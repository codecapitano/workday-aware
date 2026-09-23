import assert from 'node:assert/strict';
import { chmod, cp, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';
import { configure, dataDir, detectIntegration, digest, installJsonEntry, previewJsonEntry, purgeUserState, runSetup, statePath, trustProject, uninstallAdapter, uninstallJsonEntry } from '../../skills/workday-aware/scripts/setup.mjs';

const nativeWrapperExtension = process.platform === 'win32' ? 'cmd' : 'sh';
let testConfigHome;
let testHostConfigHome;
let originalXdgConfigHome;
beforeEach(async () => {
  testConfigHome = await mkdtemp(join(tmpdir(), 'workday-installer-config-'));
  testHostConfigHome = await mkdtemp(join(tmpdir(), 'workday-installer-host-config-'));
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.WORKDAY_AWARE_CONFIG_HOME = testConfigHome;
  process.env.XDG_CONFIG_HOME = testHostConfigHome;
});
afterEach(async () => {
  await rm(testConfigHome, { recursive: true, force: true });
  await rm(testHostConfigHome, { recursive: true, force: true });
  delete process.env.WORKDAY_AWARE_CONFIG_HOME;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'workday-aware-'));
  const target = join(home, 'config.json');
  await writeFile(target, JSON.stringify({ unrelated: 'secret', hooks: { keep: true } }) + '\n', { mode: 0o640 });
  return { home, target };
}

test('preview redacts unrelated values and install is atomic and idempotent', async () => {
  const { home, target } = await fixture();
  const preview = await previewJsonEntry({ home, target, key: 'workdayAware', value: { enabled: true } });
  assert.match(preview, /<redacted>/);
  const first = await installJsonEntry({ home, target, key: 'workdayAware', value: { enabled: true } });
  const second = await installJsonEntry({ home, target, key: 'workdayAware', value: { enabled: true } });
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')).hooks, { keep: true });
  const state = JSON.parse(await readFile(statePath(home), 'utf8'));
  const backup = state.targets[target].backupPath;
  if (process.platform !== 'win32') assert.equal((await stat(backup)).mode & 0o777, 0o640);
});

test('configure previews, requires confirmation, validates settings, and preserves trusted projects', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-aware-'));
  await mkdir(join(home, 'project', '.git'), { recursive: true });
  await trustProject({ home, project: join(home, 'project'), confirm: true });
  await assert.rejects(() => configure({ home, values: { timezone: 'Europe/Berlin' } }), /confirmation/i);
  const preview = await configure({ home, values: { timezone: 'Europe/Berlin', endOfDay: '18:00', wrapUpMinutes: 20, meaningfulWorkMinutes: 10, workDays: ['mon', 'tue'] }, preview: true });
  assert.equal(preview.action, 'preview');
  assert.equal(preview.owned.timezone, 'Europe/Berlin');
  assert.equal(preview.owned.endOfDay, '18:00');
  const result = await configure({ home, values: { timezone: 'Europe/Berlin', endOfDay: '18:00', wrapUpMinutes: 20, meaningfulWorkMinutes: 10, workDays: ['mon', 'tue'] }, confirm: true });
  assert.equal(result.status, 'configured');
  const config = JSON.parse(await readFile(join(dataDir(home), 'config.json'), 'utf8'));
  assert.equal(config.version, 1);
  assert.deepEqual(config.trustedProjects, [join(home, 'project')]);
  const savedText = await readFile(join(dataDir(home), 'config.json'), 'utf8');
  const state = JSON.parse(await readFile(statePath(home), 'utf8'));
  assert.equal(state.targets[join(dataDir(home), 'config.json')].postHash, digest(savedText));
});

test('trust-project creates a valid versioned global configuration', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-aware-'));
  const project = join(home, 'project');
  await mkdir(join(project, '.git'), { recursive: true });
  await trustProject({ home, project, confirm: true });
  const config = JSON.parse(await readFile(join(dataDir(home), 'config.json'), 'utf8'));
  assert.equal(config.version, 1);
  assert.deepEqual(config.trustedProjects, [project]);
  const state = JSON.parse(await readFile(statePath(home), 'utf8'));
  assert.deepEqual(state.targets[join(dataDir(home), 'config.json')].ownedIdentifiers, ['project-trust']);
});

test('setup previews defaults without mutation and applies only after confirmation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-aware-'));
  const output = [];
  assert.equal(await runSetup(['setup', '--preview', '--adapter', 'codex'], { home, write: (value) => output.push(value) }), 0);
  const preview = JSON.parse(output[0]);
  assert.equal(preview.action, 'preview');
  assert.equal(preview.configuration.endOfDay, '17:30');
  assert.deepEqual(preview.adapters.codex.owned, ['wrapper', 'hook:UserPromptSubmit']);
  await assert.rejects(() => readFile(join(dataDir(home), 'config.json'), 'utf8'));

  output.length = 0;
  assert.equal(await runSetup(['setup', '--confirm', '--adapter', 'codex'], { home, write: (value) => output.push(value) }), 0);
  assert.equal(JSON.parse(output[0]).status, 'configured');
  assert.equal(JSON.parse(await readFile(join(dataDir(home), 'config.json'), 'utf8')).version, 1);
});

test('setup rejects invalid host configuration before writing Workday files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-aware-'));
  await mkdir(join(home, '.codex'), { recursive: true });
  await writeFile(join(home, '.codex', 'hooks.json'), '{invalid json\n');

  await assert.rejects(() => runSetup(['setup', '--confirm', '--adapter', 'codex'], { home, write: () => {} }), /invalid JSON/i);

  await assert.rejects(() => stat(join(dataDir(home), 'config.json')));
  await assert.rejects(() => stat(join(dataDir(home), 'adapters', `codex.${nativeWrapperExtension}`)));
  await assert.rejects(() => stat(join(dataDir(home), 'adapters', 'codex.cmd')));
  await assert.rejects(() => stat(statePath(home)));
});

test('setup rejects malformed host hook structures before writing Workday files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-aware-'));
  await mkdir(join(home, '.codex'), { recursive: true });
  await writeFile(join(home, '.codex', 'hooks.json'), '{"hooks":{"UserPromptSubmit":{}}}\n');

  await assert.rejects(() => runSetup(['setup', '--confirm', '--adapter', 'codex'], { home, write: () => {} }), /invalid hook configuration/i);

  await assert.rejects(() => stat(join(dataDir(home), 'config.json')));
  await assert.rejects(() => stat(join(dataDir(home), 'adapters', `codex.${nativeWrapperExtension}`)));
  await assert.rejects(() => stat(statePath(home)));
});

test('setup rejects malformed OpenCode plugin structures before writing Workday files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-aware-'));
  const config = join(testHostConfigHome, 'opencode', 'opencode.json');
  await mkdir(join(testHostConfigHome, 'opencode'), { recursive: true });
  await writeFile(config, '{"plugins":{}}\n');

  await assert.rejects(() => runSetup(['setup', '--confirm', '--adapter', 'opencode'], { home, write: () => {} }), /invalid plugin configuration/i);

  await assert.rejects(() => stat(join(dataDir(home), 'config.json')));
  await assert.rejects(() => stat(join(dataDir(home), 'adapters', `opencode.${nativeWrapperExtension}`)));
  await assert.rejects(() => stat(statePath(home)));
});

test('setup rejects unmanaged adapter files before writing Workday configuration', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-aware-'));
  const plugin = join(testHostConfigHome, 'opencode', 'plugins', 'workday-aware.js');
  await mkdir(join(testHostConfigHome, 'opencode', 'plugins'), { recursive: true });
  await writeFile(plugin, 'user-managed plugin\n');

  await assert.rejects(() => runSetup(['setup', '--confirm', '--adapter', 'opencode'], { home, write: () => {} }), /unmanaged target/i);

  assert.equal(await readFile(plugin, 'utf8'), 'user-managed plugin\n');
  await assert.rejects(() => stat(join(dataDir(home), 'config.json')));
  await assert.rejects(() => stat(join(dataDir(home), 'adapters', `opencode.${nativeWrapperExtension}`)));
  await assert.rejects(() => stat(statePath(home)));
});

test('setup rejects an unmanaged wrapper before writing Workday configuration', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-aware-'));
  const extension = process.platform === 'win32' ? 'cmd' : 'sh';
  const wrapper = join(dataDir(home), 'adapters', `codex.${extension}`);
  await mkdir(join(dataDir(home), 'adapters'), { recursive: true });
  await writeFile(wrapper, 'user-managed wrapper\n');

  await assert.rejects(() => runSetup(['setup', '--confirm', '--adapter', 'codex'], { home, write: () => {} }), /unmanaged target/i);

  assert.equal(await readFile(wrapper, 'utf8'), 'user-managed wrapper\n');
  await assert.rejects(() => stat(join(dataDir(home), 'config.json')));
  await assert.rejects(() => stat(statePath(home)));
});

test('setup reports recovery when a host write fails after configuration', { skip: process.platform === 'win32' }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-aware-'));
  const hostDirectory = join(home, '.codex');
  await mkdir(hostDirectory, { recursive: true });
  await writeFile(join(hostDirectory, 'hooks.json'), '{}\n');
  await chmod(hostDirectory, 0o500);

  try {
    await assert.rejects(
      () => runSetup(['setup', '--confirm', '--adapter', 'codex'], { home, write: () => {} }),
      /setup partially completed.*retry setup or run uninstall --purge --confirm/i,
    );
  } finally {
    await chmod(hostDirectory, 0o700);
  }
});

test('the installed skill directory is self-contained for setup and adapters', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'workday-aware-standalone-'));
  const installedSkill = join(fixture, 'workday-aware');
  const sourceSkill = new URL('../../skills/workday-aware/', import.meta.url);
  await cp(sourceSkill, installedSkill, { recursive: true });
  const { runSetup: runInstalledSetup } = await import(`${new URL(`file://${join(installedSkill, 'scripts', 'setup.mjs')}`).href}?standalone=${Date.now()}`);
  const output = [];
  assert.equal(await runInstalledSetup(['setup', '--preview', '--adapter', 'codex'], { home: join(fixture, 'home'), write: value => output.push(value) }), 0);
  assert.deepEqual(JSON.parse(output[0]).adapters.codex.owned, ['wrapper', 'hook:UserPromptSubmit']);
});

test('uses AppData for setup state on Windows', () => {
  assert.equal(
    dataDir('C:\\Users\\person', { APPDATA: 'C:\\Users\\person\\AppData\\Roaming' }, 'win32'),
    join('C:\\Users\\person\\AppData\\Roaming', 'workday-aware'),
  );
});

test('setup state ignores relative configuration roots', () => {
  const home = join(tmpdir(), 'workday-aware-home');
  const xdg = join(tmpdir(), 'workday-aware-xdg');
  assert.equal(dataDir(home, { WORKDAY_AWARE_CONFIG_HOME: 'relative', XDG_CONFIG_HOME: xdg }, 'linux'), join(xdg, 'workday-aware'));
  assert.equal(dataDir(home, { WORKDAY_AWARE_CONFIG_HOME: 'relative', XDG_CONFIG_HOME: 'also-relative' }, 'linux'), join(home, '.config', 'workday-aware'));
  assert.throws(() => dataDir('C:\\Users\\person', { APPDATA: 'relative' }, 'win32'), /absolute configuration directory/i);
});

test('Windows doctor uses AppData and cmd adapter discovery', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-aware-'));
  const env = { APPDATA: join(home, 'CustomRoaming') };
  await mkdir(join(env.APPDATA, 'opencode'), { recursive: true });
  await writeFile(join(env.APPDATA, 'opencode', 'opencode.json'), '{}\n');
  await mkdir(join(dataDir(home, env, 'win32'), 'adapters'), { recursive: true });
  await writeFile(join(dataDir(home, env, 'win32'), 'adapters', 'opencode.cmd'), 'exit /b 0\r\n');
  const result = await detectIntegration(home, { env, platformName: 'win32' });
  assert.equal(result.config.opencode, true);
  assert.equal(result.adapters.opencode, true);
});

test('setup rejects unknown options instead of silently ignoring them', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-aware-'));
  await assert.rejects(() => runSetup(['setup', '--preview', '--typo', 'value'], { home, write: () => {} }), /unknown option/i);
  await assert.rejects(() => runSetup(['configure', '--preview', '--typo', 'value'], { home, write: () => {} }), /unknown option/i);
});

test('setup requires preview and confirmation to be separate invocations', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-aware-'));
  await assert.rejects(() => runSetup(['setup', '--preview', '--confirm'], { home, write: () => {} }), /mutually exclusive/i);
  await assert.rejects(() => runSetup(['configure', '--preview', '--confirm'], { home, write: () => {} }), /mutually exclusive/i);
});

test('offline doctor reports bounded integration health', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-aware-'));
  const output = [];
  assert.equal(await runSetup(['doctor'], { home, write: value => output.push(value) }), 0);
  const result = JSON.parse(output[0]);
  assert.equal(result.status, 'ok');
  assert.equal(result.runtime.nodeSupported, true);
});

test('integration doctor identifies a Pi-launched process without claiming extension state', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-aware-'));
  const result = await detectIntegration(home, { env: { AI_AGENT: 'pi', PI_CODING_AGENT: 'true', XDG_CONFIG_HOME: join(home, '.config') } });
  assert.equal(result.runtime.agent, 'pi');
  assert.equal('pi' in result.adapters, false);
});

test('project trust accepts only an explicit Git root', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-aware-'));
  const directory = join(home, 'not-a-git-root');
  await mkdir(directory);
  await assert.rejects(() => trustProject({ home, project: directory, confirm: true }), /Git root/i);
  await assert.rejects(() => trustProject({ home, confirm: true }), /project/i);
});

test('adapter uninstall uses state ownership', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-aware-'));
  const { installAdapters } = await import('../../adapters/index.mjs');
  await installAdapters({ home, names: ['codex'], confirm: true });
  const result = await uninstallAdapter({ home, name: 'codex' });
  assert.equal(result.status, 'uninstalled');
  assert.equal(result.target, 'codex-hook');
});

test('command-line adapter uninstall requires explicit confirmation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-aware-'));
  const { installAdapters } = await import('../../adapters/index.mjs');
  await installAdapters({ home, names: ['codex'], confirm: true });
  await assert.rejects(() => runSetup(['uninstall', 'codex'], { home, write: () => {} }), /confirmation/i);
  assert.equal(await runSetup(['uninstall', 'codex', '--confirm'], { home, write: () => {} }), 0);
});

test('command-line purge uninstalls managed adapters before deleting Workday state', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-aware-'));
  const { installAdapters } = await import('../../adapters/index.mjs');
  await installAdapters({ home, names: ['codex'], confirm: true });

  assert.equal(await runSetup(['uninstall', '--purge', '--confirm'], { home, write: () => {} }), 0);

  await assert.rejects(() => readFile(join(home, '.codex', 'hooks.json'), 'utf8'));
  await assert.rejects(() => stat(dataDir(home)));
});

test('command-line purge completes when an owned wrapper is already missing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-aware-'));
  const extension = process.platform === 'win32' ? 'cmd' : 'sh';
  const { installAdapters } = await import('../../adapters/index.mjs');
  await installAdapters({ home, names: ['codex'], confirm: true });
  await rm(join(dataDir(home), 'adapters', `codex.${extension}`));

  assert.equal(await runSetup(['uninstall', '--purge', '--confirm'], { home, write: () => {} }), 0);

  await assert.rejects(() => stat(join(home, '.codex', 'hooks.json')));
  await assert.rejects(() => stat(dataDir(home)));
});

test('command-line purge retains state when an adapter host config changed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-aware-'));
  const { installAdapters } = await import('../../adapters/index.mjs');
  await installAdapters({ home, names: ['codex'], confirm: true });
  const configPath = join(home, '.codex', 'hooks.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.external = true;
  await writeFile(configPath, `${JSON.stringify(config)}\n`);
  const output = [];

  assert.equal(await runSetup(['uninstall', '--purge', '--confirm'], { home, write: value => output.push(value) }), 0);

  assert.equal(JSON.parse(output[0]).status, 'partial');
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).external, true);
  assert.ok(await stat(join(dataDir(home), 'adapters', `codex.${nativeWrapperExtension}`)));
  assert.ok(await stat(statePath(home)));
});

test('uninstall never restores a stale whole file after an external edit', async () => {
  const { home, target } = await fixture();
  await installJsonEntry({ home, target, key: 'workdayAware', value: true });
  await writeFile(target, '{"external":true,"workdayAware":true}\n');
  const result = await uninstallJsonEntry({ home, target, key: 'workdayAware' });
  assert.equal(result.changed, false);
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { external: true, workdayAware: true });
});

test('install rejects symlink targets and detects concurrent changes', async () => {
  const { home, target } = await fixture();
  const link = join(home, 'link.json');
  await symlink(target, link);
  await assert.rejects(() => installJsonEntry({ home, target: link, key: 'x', value: 1 }), /symlink/i);
  const preview = JSON.parse(await previewJsonEntry({ home, target, key: 'workdayAware', value: true }));
  await writeFile(target, '{"changed":true}\n');
  await assert.rejects(() => installJsonEntry({ home, target, key: 'workdayAware', value: true, expectedHash: preview.hash }), /changed concurrently/i);
});

test('trust-project and owned uninstall preserve unrelated state; purge is explicit', async () => {
  const { home, target } = await fixture();
  const project = join(home, 'project');
  await mkdir(join(project, '.git'), { recursive: true });
  await trustProject({ home, project, confirm: true });
  await installJsonEntry({ home, target, key: 'workdayAware', value: { enabled: true } });
  const removed = await uninstallJsonEntry({ home, target, key: 'workdayAware' });
  assert.equal(removed.changed, true);
  assert.equal(JSON.parse(await readFile(target, 'utf8')).unrelated, 'secret');
  assert.equal((await uninstallJsonEntry({ home, target, key: 'workdayAware' })).changed, false);
  await assert.rejects(() => purgeUserState({ home }), /confirmation/i);
  await purgeUserState({ home, confirm: true });
  await assert.rejects(() => readFile(dataDir(home), 'utf8'));
});
