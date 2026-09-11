import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { afterEach, beforeEach } from 'node:test';
import { adapters, adapterStatus, installAdapters as installAdapterConfiguration, preflightAdapters as preflightAdapterConfiguration } from '../../adapters/index.mjs';
import { wrapperScripts } from '../../skills/workday-aware/scripts/adapters.mjs';
import { atomicRemove, dataDir, statePath, uninstallAdapter } from '../../skills/workday-aware/scripts/setup.mjs';

const nativeWrapperExtension = process.platform === 'win32' ? 'cmd' : 'sh';
const wrapperExtensions = process.platform === 'win32' ? ['cmd'] : ['sh', 'cmd'];
let testConfigHome;
beforeEach(async () => {
  testConfigHome = await mkdtemp(join(tmpdir(), 'workday-adapter-config-'));
  process.env.WORKDAY_AWARE_CONFIG_HOME = testConfigHome;
});
afterEach(async () => {
  await rm(testConfigHome, { recursive: true, force: true });
  delete process.env.WORKDAY_AWARE_CONFIG_HOME;
});

const adapterEnv = home => ({ WORKDAY_AWARE_CONFIG_HOME: testConfigHome, XDG_CONFIG_HOME: join(home, '.config'), APPDATA: join(home, 'AppData', 'Roaming') });
const installAdapters = ({ home, env = adapterEnv(home), ...options }) => installAdapterConfiguration({ home, env, ...options });
const preflightAdapters = ({ home, env = adapterEnv(home), ...options }) => preflightAdapterConfiguration({ home, env, ...options });

async function runNativeWrapper(wrapper, env = {}) {
  const executable = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : wrapper;
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', wrapper] : [];
  const child = spawn(executable, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  const [code] = await once(child, 'exit');
  return { code, stdout: stdout.trim(), stderr };
}

test('adapter support tiers are explicit and unsupported surfaces are instruction-only', () => {
  assert.deepEqual(Object.keys(adapters).sort(), ['claude-code', 'codex', 'copilot', 'cursor', 'gemini-cli', 'opencode', 'windsurf']);
  assert.equal(adapterStatus('cursor').tier, 'instruction-only');
  assert.equal(adapterStatus('codex').tier, 'automatic');
  assert.equal(adapterStatus('opencode').tier, 'best-effort');
  assert.match(adapterStatus('cursor').message, /manual/i);
});

test('adapter install emits protocol JSON and requires explicit confirmation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-adapter-'));
  await assert.rejects(() => installAdapters({ home, names: ['codex'] }), /confirmation/i);
  const result = await installAdapters({ home, names: ['codex', 'cursor'], confirm: true });
  assert.equal(result.schema, 1);
  assert.equal(result.adapters.codex.status, 'installed');
  assert.equal(result.adapters.cursor.status, 'instruction-only');
  const state = JSON.parse(await (await import('node:fs/promises')).readFile(statePath(home), 'utf8'));
  const wrapper = join(dataDir(home), 'adapters', `codex.${nativeWrapperExtension}`);
  const record = state.targets[wrapper];
  assert.equal(record.ownedIdentifiers[0], 'adapter:codex');
  assert.match(record.preHash, /^[a-f0-9]{64}$/);
  assert.match(record.postHash, /^[a-f0-9]{64}$/);
  const repeat = await installAdapters({ home, names: ['codex'], confirm: true });
  assert.equal(repeat.adapters.codex.changed, false);
});

test('adapter install preflights malformed host configuration before writing owned files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-adapter-'));
  await mkdir(join(home, '.codex'), { recursive: true });
  await writeFile(join(home, '.codex', 'hooks.json'), '{"hooks":{"UserPromptSubmit":{}}}\n');

  await assert.rejects(() => installAdapters({ home, names: ['codex'], confirm: true }), /invalid hook configuration/i);

  for (const extension of wrapperExtensions) await assert.rejects(() => stat(join(dataDir(home), 'adapters', `codex.${extension}`)));
  await assert.rejects(() => stat(statePath(home)));
});

test('concurrent public adapter installs retain every ownership record', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-adapter-'));
  const module = pathToFileURL(join(process.cwd(), 'adapters', 'index.mjs')).href;
  const run = name => new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', `import { installAdapters } from ${JSON.stringify(module)}; await installAdapters({ home: ${JSON.stringify(home)}, names: [${JSON.stringify(name)}], confirm: true });`], { env: { ...process.env } });
    let stderr = '';
    child.stderr.on('data', value => { stderr += value; });
    child.on('error', rejectRun);
    child.on('exit', code => code === 0 ? resolveRun() : rejectRun(new Error(stderr)));
  });

  await Promise.all([run('codex'), run('claude-code')]);

  const state = JSON.parse(await readFile(statePath(home), 'utf8'));
  assert.ok(state.targets[join(dataDir(home), 'adapters', `codex.${nativeWrapperExtension}`)]);
  assert.ok(state.targets[join(dataDir(home), 'adapters', `claude-code.${nativeWrapperExtension}`)]);
  assert.ok(state.targets[join(home, '.codex', 'hooks.json')]);
  assert.ok(state.targets[join(home, '.claude', 'settings.json')]);
});

test('conditional removal retains replaced empty configs and wrappers', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-adapter-'));
  const config = join(home, '.codex', 'hooks.json');
  const wrapper = join(dataDir(home), 'adapters', `codex.${nativeWrapperExtension}`);
  await installAdapters({ home, names: ['codex'], confirm: true });
  await writeFile(config, 'replacement config\n');
  await writeFile(wrapper, 'replacement wrapper\n');

  assert.equal(await atomicRemove(config, 'not-the-current-hash'), false);
  assert.equal(await atomicRemove(wrapper, 'not-the-current-hash'), false);
  assert.equal(await readFile(config, 'utf8'), 'replacement config\n');
  assert.equal(await readFile(wrapper, 'utf8'), 'replacement wrapper\n');
});

test('POSIX wrapper discards stdin, passes canonical hook output, and fails open within three seconds', { skip: process.platform === 'win32' }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday adapter space-'));
  const result = await installAdapters({ home, names: ['codex'], confirm: true });
  const wrapper = join(dataDir(home), 'adapters', 'codex.sh');
  const wrapperSource = await readFile(wrapper, 'utf8');
  assert.match(wrapperSource, /sleep 3/);
  assert.doesNotMatch(wrapperSource, /command -v timeout/);
  const child = spawn(wrapper, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const stdinErrors = [];
  child.stdin.on('error', error => { stdinErrors.push(error); });
  child.stdin.end('untrusted stdin');
  let stdout = '';
  child.stdout.on('data', value => { stdout += value; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  const output = JSON.parse(stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(output.hookSpecificOutput.additionalContext, /wrap-up/);
  assert.ok(stdinErrors.every(error => error.code === 'EPIPE'));
});

test('native wrapper returns valid fail-open JSON when the runtime fails', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-adapter-'));
  const failureModule = join(home, 'force-node-failure.mjs');
  await writeFile(failureModule, "throw new Error('forced runtime failure');\n");
  await installAdapters({ home, names: ['codex'], confirm: true });
  const wrapper = join(dataDir(home), 'adapters', `codex.${nativeWrapperExtension}`);

  const result = await runNativeWrapper(wrapper, { NODE_OPTIONS: `--import=${pathToFileURL(failureModule).href}` });

  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { status: 'status_unavailable', category: 'adapter_hook_failed' });
});

test('native wrapper enforces its fail-open deadline when the runtime hangs', { timeout: 8000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-adapter-'));
  const delayModule = join(home, 'delay-node-runtime.mjs');
  await writeFile(delayModule, 'await new Promise(resolve => setTimeout(resolve, 30000));\n');
  await installAdapters({ home, names: ['codex'], confirm: true });
  const wrapper = join(dataDir(home), 'adapters', `codex.${nativeWrapperExtension}`);
  const started = performance.now();

  const result = await runNativeWrapper(wrapper, { NODE_OPTIONS: `--import=${pathToFileURL(delayModule).href}` });
  const elapsed = performance.now() - started;

  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { status: 'status_unavailable', category: 'adapter_hook_failed' });
  assert.ok(elapsed >= 2500, `wrapper returned before its deadline (${elapsed}ms)`);
  assert.ok(elapsed < 6000, `wrapper exceeded its deadline (${elapsed}ms)`);
});

test('adapter output is symbolic and has a Windows wrapper', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-adapter-'));
  const result = await installAdapters({ home, names: ['codex'], confirm: true });
  assert.equal(result.adapters.codex.target, 'codex-hook');
  assert.ok(await stat(join(dataDir(home), 'adapters', 'codex.cmd')));
});

test('owned adapter wrappers preserve existing permissions', { skip: process.platform === 'win32' }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-adapter-'));
  const root = join(dataDir(home), 'adapters');
  const wrapper = join(root, 'codex.sh');
  await installAdapters({ home, names: ['codex'], confirm: true });
  await chmod(wrapper, 0o750);
  await installAdapters({ home, names: ['codex'], confirm: true });
  assert.equal((await stat(wrapper)).mode & 0o777, 0o750);
});

test('reinstall restores only the owner executable bit on an owned POSIX wrapper', { skip: process.platform === 'win32' }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-adapter-'));
  await installAdapters({ home, names: ['codex'], confirm: true });
  const wrapper = join(dataDir(home), 'adapters', 'codex.sh');
  await chmod(wrapper, 0o600);

  await installAdapters({ home, names: ['codex'], confirm: true });

  assert.equal((await stat(wrapper)).mode & 0o777, 0o700);
});

test('native automatic adapters preserve existing hook configuration and use their exact prompt events', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-adapter-'));
  const claudeConfig = join(home, '.claude', 'settings.json');
  const geminiConfig = join(home, '.gemini', 'settings.json');
  await mkdir(join(home, '.claude'), { recursive: true });
  await mkdir(join(home, '.gemini'), { recursive: true });
  await writeFile(claudeConfig, '{"unrelated":true,"hooks":{"PreToolUse":[{"keep":true}]}}\n');
  await writeFile(geminiConfig, '{"unrelated":true,"hooks":{"SessionStart":[{"keep":true}]}}\n');

  await installAdapters({ home, names: ['codex', 'claude-code', 'gemini-cli'], confirm: true });

  const claude = JSON.parse(await readFile(claudeConfig, 'utf8'));
  const gemini = JSON.parse(await readFile(geminiConfig, 'utf8'));
  assert.equal(claude.unrelated, true);
  assert.deepEqual(claude.hooks.PreToolUse, [{ keep: true }]);
  assert.equal(claude.hooks.UserPromptSubmit[0].hooks[0].type, 'command');
  assert.equal(gemini.unrelated, true);
  assert.deepEqual(gemini.hooks.SessionStart, [{ keep: true }]);
  assert.equal('matcher' in gemini.hooks.BeforeAgent[0], false);
  assert.equal(gemini.hooks.BeforeAgent[0].hooks[0].type, 'command');
});

test('Codex installs an unconditional unnamed UserPromptSubmit command handler', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-adapter-'));
  await installAdapters({ home, names: ['codex'], confirm: true });

  const group = JSON.parse(await readFile(join(home, '.codex', 'hooks.json'), 'utf8')).hooks.UserPromptSubmit[0];
  const handler = group.hooks[0];
  assert.equal('matcher' in group, false);
  assert.equal('name' in handler, false);
  assert.equal(handler.type, 'command');
  assert.equal(handler.timeout, 3);
});

test('Gemini installs an unconditional named BeforeAgent command handler', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-adapter-'));
  await installAdapters({ home, names: ['gemini-cli'], confirm: true });

  const group = JSON.parse(await readFile(join(home, '.gemini', 'settings.json'), 'utf8')).hooks.BeforeAgent[0];
  const handler = group.hooks[0];
  assert.equal('matcher' in group, false);
  assert.equal(handler.name, 'workday-aware');
  assert.equal(handler.type, 'command');
  assert.equal(handler.timeout, 3000);
});

test('OpenCode uses only its native context transform and previews symbolic owned changes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-adapter-'));
  const preview = await installAdapters({ home, names: ['opencode', 'cursor'], preview: true });
  assert.deepEqual(preview.adapters.opencode.owned, ['wrapper', 'context-plugin', 'plugin-config']);

  await installAdapters({ home, names: ['opencode'], confirm: true });
  const plugin = await readFile(join(home, '.config', 'opencode', 'plugins', 'workday-aware.js'), 'utf8');
  assert.match(plugin, /session\.hook\(["']context["']/);
  assert.match(plugin, /event\.system\.push/);
  assert.doesNotMatch(plugin, /experimental\.chat\.system\.transform/);
  assert.doesNotMatch(plugin, /prompt/i);
  const config = JSON.parse(await readFile(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
  assert.equal(config.plugins.length, 1);
  await installAdapters({ home, names: ['opencode'], confirm: true });
  assert.equal(JSON.parse(await readFile(join(home, '.config', 'opencode', 'opencode.json'), 'utf8')).plugins.length, 1);
});

test('OpenCode uses the host config root while wrappers and state use the Workday config root', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-adapter-'));
  const env = { WORKDAY_AWARE_CONFIG_HOME: join(home, 'workday-config'), XDG_CONFIG_HOME: join(home, 'host-config') };
  await installAdapters({ home, names: ['opencode'], confirm: true, env });

  assert.ok(await stat(join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.json')));
  assert.ok(await stat(join(env.XDG_CONFIG_HOME, 'opencode', 'plugins', 'workday-aware.js')));
  assert.ok(await stat(join(env.WORKDAY_AWARE_CONFIG_HOME, 'workday-aware', 'adapters', `opencode.${nativeWrapperExtension}`)));
  assert.ok(await stat(statePath(home, env)));
  await assert.rejects(() => stat(join(env.XDG_CONFIG_HOME, 'workday-aware', 'state.json')));
});

test('OpenCode ignores a relative host configuration root', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-adapter-'));
  const config = join(home, '.config', 'opencode', 'opencode.json');
  const env = { WORKDAY_AWARE_CONFIG_HOME: join(home, 'workday-config'), XDG_CONFIG_HOME: 'relative', APPDATA: join(home, '.config') };
  await mkdir(join(home, '.config', 'opencode'), { recursive: true });
  await writeFile(config, '{invalid json\n');

  await assert.rejects(() => preflightAdapters({ home, names: ['opencode'], env }), /invalid JSON/i);
});

test('Windows wrappers enforce the same three second fail-open deadline and configure native hooks', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-adapter-'));
  const env = { APPDATA: join(home, 'CustomRoaming') };
  await installAdapters({ home, names: ['gemini-cli'], confirm: true, platform: 'win32', env });
  const state = JSON.parse(await readFile(statePath(home, env, 'win32'), 'utf8'));
  assert.equal(state.targets[join(dataDir(home, env, 'win32'), 'adapters', 'gemini-cli.cmd')].platform, 'win32');
  const wrapper = await readFile(join(dataDir(home, env, 'win32'), 'adapters', 'gemini-cli.cmd'), 'utf8');
  const payload = Buffer.from(wrapper.match(/powershell -NoProfile -EncodedCommand ([A-Za-z0-9+/=]+)/)[1], 'base64').toString('utf16le');
  assert.match(payload, /WaitForExit\(3000\)/);
  assert.match(payload, /StandardInput\.Close/);
  assert.match(payload, /\[void\]\$p\.Start\(\)/);
  assert.match(payload, /\$p\.Kill\(\)/);
  assert.match(payload, /\[Console\]::Out\.WriteLine\('\{"status":"status_unavailable","category":"adapter_hook_failed"\}'\)/);
  assert.match(payload, /exit 0/);
  assert.match(wrapper, /if errorlevel 1 echo \{"status":"status_unavailable","category":"adapter_hook_failed"\}/);
  const config = JSON.parse(await readFile(join(home, '.gemini', 'settings.json'), 'utf8'));
  assert.equal(config.hooks.BeforeAgent[0].hooks[0].timeout, 3000);
});

test('Windows wrapper escapes apostrophes in the encoded PowerShell payload', () => {
  const wrapper = wrapperScripts("C:\\Users\\O'Brien\\workday-aware.mjs", 'codex').windows;
  const payload = Buffer.from(wrapper.match(/powershell -NoProfile -EncodedCommand ([A-Za-z0-9+/=]+)/)[1], 'base64').toString('utf16le');
  assert.match(payload, /O''Brien/);
});

test('uninstall removes every unchanged owned adapter entry and preserves unrelated host configuration', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-adapter-'));
  const configPath = join(home, '.claude', 'settings.json');
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(configPath, '{"unrelated":true}\n');
  await installAdapters({ home, names: ['claude-code'], confirm: true });

  const result = await uninstallAdapter({ home, name: 'claude-code' });
  assert.equal(result.status, 'uninstalled');
  assert.equal(result.skippedChanged, 0);
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), { unrelated: true });
  for (const extension of wrapperExtensions) await assert.rejects(() => readFile(join(dataDir(home), 'adapters', `claude-code.${extension}`), 'utf8'));
});

test('uninstall removes installer-created host config files and preserves pre-existing empty configs', async () => {
  const absentHome = await mkdtemp(join(tmpdir(), 'workday-adapter-'));
  await installAdapters({ home: absentHome, names: ['codex', 'opencode'], confirm: true });
  await uninstallAdapter({ home: absentHome, name: 'codex' });
  await uninstallAdapter({ home: absentHome, name: 'opencode' });
  await assert.rejects(() => readFile(join(absentHome, '.codex', 'hooks.json'), 'utf8'));
  await assert.rejects(() => readFile(join(absentHome, '.config', 'opencode', 'opencode.json'), 'utf8'));

  const existingHome = await mkdtemp(join(tmpdir(), 'workday-adapter-'));
  const codexConfig = join(existingHome, '.codex', 'hooks.json');
  const openCodeConfig = join(existingHome, '.config', 'opencode', 'opencode.json');
  await mkdir(join(existingHome, '.codex'), { recursive: true });
  await mkdir(join(existingHome, '.config', 'opencode'), { recursive: true });
  await writeFile(codexConfig, '{}\n');
  await writeFile(openCodeConfig, '{}\n');
  await installAdapters({ home: existingHome, names: ['codex', 'opencode'], confirm: true });
  await uninstallAdapter({ home: existingHome, name: 'codex' });
  await uninstallAdapter({ home: existingHome, name: 'opencode' });
  assert.deepEqual(JSON.parse(await readFile(codexConfig, 'utf8')), {});
  assert.deepEqual(JSON.parse(await readFile(openCodeConfig, 'utf8')), {});
});

test('uninstall removes only hook groups and plugin paths installed by this project', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-adapter-'));
  const claudeConfig = join(home, '.claude', 'settings.json');
  const openCodeConfig = join(home, '.config', 'opencode', 'opencode.json');
  const existingHook = { matcher: 'external', hooks: [{ name: 'workday-aware', type: 'command', command: '/external/workday-aware', timeout: 3 }] };
  const existingPlugin = '/external/plugins/workday-aware.js';
  await mkdir(join(home, '.claude'), { recursive: true });
  await mkdir(join(home, '.config', 'opencode'), { recursive: true });
  await writeFile(claudeConfig, `${JSON.stringify({ hooks: { UserPromptSubmit: [existingHook] } })}\n`);
  await writeFile(openCodeConfig, `${JSON.stringify({ plugins: [existingPlugin] })}\n`);

  await installAdapters({ home, names: ['claude-code', 'opencode'], confirm: true });
  await uninstallAdapter({ home, name: 'claude-code' });
  await uninstallAdapter({ home, name: 'opencode' });

  assert.deepEqual(JSON.parse(await readFile(claudeConfig, 'utf8')).hooks.UserPromptSubmit, [existingHook]);
  assert.deepEqual(JSON.parse(await readFile(openCodeConfig, 'utf8')).plugins, [existingPlugin]);
});

test('uninstall preserves exact pre-existing adapter entries in compact configuration', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-adapter-'));
  const claudeConfig = join(home, '.claude', 'settings.json');
  const openCodeConfig = join(home, '.config', 'opencode', 'opencode.json');
  await installAdapters({ home, names: ['claude-code', 'opencode'], confirm: true });
  const claudeText = JSON.stringify(JSON.parse(await readFile(claudeConfig, 'utf8')));
  const openCodeText = JSON.stringify(JSON.parse(await readFile(openCodeConfig, 'utf8')));
  const wrapper = join(dataDir(home), 'adapters', `claude-code.${nativeWrapperExtension}`);
  const plugin = join(home, '.config', 'opencode', 'plugins', 'workday-aware.js');
  const wrapperText = await readFile(wrapper, 'utf8');
  const pluginText = await readFile(plugin, 'utf8');
  await writeFile(claudeConfig, claudeText);
  await writeFile(openCodeConfig, openCodeText);
  await unlink(statePath(home));

  await installAdapters({ home, names: ['claude-code', 'opencode'], confirm: true });
  await uninstallAdapter({ home, name: 'claude-code' });
  await uninstallAdapter({ home, name: 'opencode' });

  assert.equal(await readFile(claudeConfig, 'utf8'), claudeText);
  assert.equal(await readFile(openCodeConfig, 'utf8'), openCodeText);
  assert.equal(await readFile(wrapper, 'utf8'), wrapperText);
  assert.equal(await readFile(plugin, 'utf8'), pluginText);
});

test('adapter installation refuses to overwrite an unmanaged conflicting wrapper', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-adapter-'));
  const wrapper = join(dataDir(home), 'adapters', `claude-code.${nativeWrapperExtension}`);
  await mkdir(join(dataDir(home), 'adapters'), { recursive: true });
  await writeFile(wrapper, 'user-managed wrapper\n');

  await assert.rejects(() => installAdapters({ home, names: ['claude-code'], confirm: true }), /unmanaged target/i);

  assert.equal(await readFile(wrapper, 'utf8'), 'user-managed wrapper\n');
});

test('uninstall leaves every adapter target intact when a later target is unreadable', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-adapter-'));
  const configPath = join(home, '.codex', 'hooks.json');
  await installAdapters({ home, names: ['codex'], confirm: true });
  const configText = await readFile(configPath, 'utf8');
  const wrapperPaths = wrapperExtensions.map(extension => join(dataDir(home), 'adapters', `codex.${extension}`));
  const wrapperTexts = await Promise.all(wrapperPaths.map(wrapperPath => readFile(wrapperPath, 'utf8')));
  await rm(configPath);
  await mkdir(configPath);

  await assert.rejects(() => uninstallAdapter({ home, name: 'codex' }), /non-file target/i);
  for (const [index, wrapperPath] of wrapperPaths.entries()) assert.equal(await readFile(wrapperPath, 'utf8'), wrapperTexts[index]);

  await rm(configPath, { recursive: true });
  await writeFile(configPath, configText);
  const retry = await uninstallAdapter({ home, name: 'codex' });
  assert.equal(retry.removed, wrapperExtensions.length + 1);
  assert.equal(retry.status, 'uninstalled');
});

test('uninstall preserves every adapter target when one target changed and keeps ownership for retry', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-adapter-'));
  const configPath = join(home, '.codex', 'hooks.json');
  await installAdapters({ home, names: ['codex'], confirm: true });
  const configText = await readFile(configPath, 'utf8');
  const wrapperPaths = wrapperExtensions.map(extension => join(dataDir(home), 'adapters', `codex.${extension}`));
  const wrapperTexts = await Promise.all(wrapperPaths.map(wrapperPath => readFile(wrapperPath, 'utf8')));
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.external = true;
  await writeFile(configPath, `${JSON.stringify(config)}\n`);
  const result = await uninstallAdapter({ home, name: 'codex' });
  assert.deepEqual(result, { status: 'partial', target: 'codex-hook', removed: 0, skippedChanged: 1 });
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).external, true);
  for (const [index, wrapperPath] of wrapperPaths.entries()) assert.equal(await readFile(wrapperPath, 'utf8'), wrapperTexts[index]);

  await writeFile(configPath, configText);
  const retry = await uninstallAdapter({ home, name: 'codex' });
  assert.equal(retry.removed, wrapperExtensions.length + 1);
  assert.equal(retry.status, 'uninstalled');
});

test('uninstall treats a missing owned wrapper as already removed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workday-adapter-'));
  const configPath = join(home, '.codex', 'hooks.json');
  const missingWrapper = join(dataDir(home), 'adapters', `codex.${nativeWrapperExtension}`);
  await installAdapters({ home, names: ['codex'], confirm: true });
  await unlink(missingWrapper);

  const result = await uninstallAdapter({ home, name: 'codex' });

  assert.equal(result.status, 'uninstalled');
  await assert.rejects(() => readFile(configPath, 'utf8'));
  for (const extension of wrapperExtensions) await assert.rejects(() => readFile(join(dataDir(home), 'adapters', `codex.${extension}`), 'utf8'));
  const state = JSON.parse(await readFile(statePath(home), 'utf8'));
  assert.equal(Object.values(state.targets).some(record => record.ownedIdentifiers?.some(identifier => identifier.startsWith('adapter:codex'))), false);
});
