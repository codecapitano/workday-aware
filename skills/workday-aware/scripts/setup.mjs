#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { access, chmod, link, lstat, mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfiguration } from './core.mjs';

const schema = 1;
const version = '1.0.0';
const stateName = 'state.json';

export function dataDir(home = homedir(), env = process.env, platformName = process.platform) {
  const candidates = [env.WORKDAY_AWARE_CONFIG_HOME, env.XDG_CONFIG_HOME, platformName === 'win32' ? env.APPDATA : join(home, '.config')];
  const root = candidates.find(candidate => candidate && (isAbsolute(candidate) || (platformName === 'win32' && win32.isAbsolute(candidate))));
  if (!root) throw new Error('absolute configuration directory unavailable');
  return join(root, 'workday-aware');
}
export function statePath(home, env = process.env, platformName = process.platform) { return join(dataDir(home, env, platformName), stateName); }
export function digest(value) { return createHash('sha256').update(value).digest('hex'); }

async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function regular(path) {
  if (!(await exists(path))) return null;
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`refusing symlink target: ${path}`);
  if (!info.isFile()) throw new Error(`refusing non-file target: ${path}`);
  return info;
}
export async function readTarget(path) {
  const info = await regular(path);
  return { info, text: info ? await readFile(path, 'utf8') : '' };
}
export async function atomicWrite(path, text, mode = 0o600, expectedHash) {
  const before = await readTarget(path);
  if (expectedHash !== undefined && digest(before.text) !== expectedHash) throw new Error(`target changed concurrently: ${path}`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    await writeFile(temp, text, { mode: before.info?.mode ?? mode, flag: 'wx' });
    await chmod(temp, before.info?.mode ?? mode);
    const current = await readTarget(path);
    if (expectedHash !== undefined && digest(current.text) !== expectedHash) throw new Error(`target changed concurrently: ${path}`);
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}
export async function atomicRemove(path, expectedHash) {
  const before = await readTarget(path);
  if (expectedHash !== undefined && digest(before.text) !== expectedHash) return false;
  const tombstone = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString('hex')}.remove`);
  let retainTombstone = false;
  try {
    await rename(path, tombstone);
    const removed = await readTarget(tombstone);
    if (expectedHash !== undefined && digest(removed.text) !== expectedHash) {
      retainTombstone = true;
      try {
        await link(tombstone, path);
        await unlink(tombstone);
        retainTombstone = false;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      return false;
    }
    await unlink(tombstone);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  } finally { if (!retainTombstone) await rm(tombstone, { force: true }); }
}
function parseJson(text, path) { try { return text ? JSON.parse(text) : {}; } catch { throw new Error(`invalid JSON in ${path}`); } }
function redacted(value) {
  if (Array.isArray(value)) return value.map(redacted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).map(key => [key, '<redacted>']));
  return '<redacted>';
}
async function readState(home, env = process.env, platformName = process.platform) {
  const path = statePath(home, env, platformName);
  if (!(await exists(path))) return { schema, coreVersion: version, adapterVersion: version, migrationVersion: 1, targets: {}, ownedIdentifiers: [] };
  const { text } = await readTarget(path);
  return parseJson(text, path);
}
async function saveState(home, state, env = process.env, platformName = process.platform) { await atomicWrite(statePath(home, env, platformName), JSON.stringify(state, null, 2) + '\n'); }
const pause = milliseconds => new Promise(resolvePause => setTimeout(resolvePause, milliseconds));
export async function withStateLock(home, operation, env = process.env, platformName = process.platform) {
  const lock = `${statePath(home, env, platformName)}.lock`;
  const attempts = 100;
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await mkdir(lock, { mode: 0o700 });
      try { return await operation(); } finally { await rm(lock, { recursive: true, force: true }); }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - (await stat(lock)).mtimeMs > 30000) await rm(lock, { recursive: true, force: true });
      } catch (recoveryError) { if (recoveryError?.code !== 'ENOENT') throw recoveryError; }
      await pause(20);
    }
  }
  throw new Error(`state lock timed out: ${lock}`);
}
export async function isManagedTarget({ home = homedir(), target, identifier, hash, env = process.env, platform = process.platform }) {
  const record = (await readState(home, env, platform)).targets[target];
  return Boolean(record?.ownedIdentifiers?.includes(identifier) && record.postHash === hash);
}
export async function recordManagedTarget({ home = homedir(), target, identifier, preHash, postHash, backupPath = null, ownedValue, env = process.env, platform = process.platform }) {
  const state = await readState(home, env, platform);
  const previous = state.targets[target];
  const ownedValues = { ...(previous?.ownedValues ?? {}) };
  if (ownedValue !== undefined) ownedValues[identifier] = ownedValue;
  state.targets[target] = { target, ownedIdentifiers: [...new Set([...(previous?.ownedIdentifiers ?? []), identifier])], ownedValues, preHash: previous?.preHash ?? preHash, postHash, backupPath: previous?.backupPath ?? backupPath, migrationVersion: 1, platform, coreVersion: version, adapterVersion: version };
  state.ownedIdentifiers = [...new Set([...state.ownedIdentifiers, `${target}:${identifier}`])];
  await saveState(home, state, env, platform);
}

export async function previewJsonEntry({ target, key, value }) {
  const { text } = await readTarget(target);
  const current = parseJson(text, target);
  return JSON.stringify({ target: 'configuration', hash: digest(text), current: redacted(current), owned: { [key]: value } }, null, 2);
}
export async function installJsonEntry({ home = homedir(), target, key, value, expectedHash }) {
  const { text, info } = await readTarget(target);
  const beforeHash = digest(text);
  if (expectedHash !== undefined && expectedHash !== beforeHash) throw new Error(`target changed concurrently: ${target}`);
  const current = parseJson(text, target);
  if (JSON.stringify(current[key]) === JSON.stringify(value)) return { changed: false, hash: beforeHash };
  const next = { ...current, [key]: value };
  const output = JSON.stringify(next, null, 2) + '\n';
  const backup = join(dataDir(home), 'backups', `${digest(resolve(target))}-${beforeHash}.json`);
  if (text && !(await exists(backup))) await atomicWrite(backup, text, info?.mode ?? 0o600);
  await atomicWrite(target, output, info?.mode ?? 0o600, beforeHash);
  const state = await readState(home);
  state.targets[target] = { target, ownedIdentifiers: [key], preHash: beforeHash, postHash: digest(output), backupPath: text ? backup : null, mode: info?.mode ?? 0o600 };
  state.ownedIdentifiers = [...new Set([...state.ownedIdentifiers, `${target}:${key}`])];
  await saveState(home, state);
  return { changed: true, hash: digest(output) };
}
export async function uninstallJsonEntry({ home = homedir(), target, key }) {
  const state = await readState(home);
  const record = state.targets[target];
  const { text, info } = await readTarget(target);
  if (!record || digest(text) !== record.postHash) return { changed: false, reason: 'target changed or is not owned' };
  const current = parseJson(text, target);
  if (!(key in current)) return { changed: false };
  delete current[key];
  const output = JSON.stringify(current, null, 2) + '\n';
  await atomicWrite(target, output, info?.mode ?? 0o600, record.postHash);
  delete state.targets[target];
  state.ownedIdentifiers = state.ownedIdentifiers.filter(item => item !== `${target}:${key}`);
  await saveState(home, state);
  return { changed: true };
}
export async function trustProject({ home = homedir(), project, confirm = false }) {
  if (!confirm) throw new Error('explicit confirmation required to trust project');
  if (typeof project !== 'string' || !project) throw new Error('project path required');
  const resolved = resolve(project);
  if (!(await exists(join(resolved, '.git')))) throw new Error('project must be a Git root');
  const path = join(dataDir(home), 'config.json');
  const { text } = await readTarget(path);
  const current = parseJson(text, path);
  const trusted = current.trustedProjects || [];
  let output = text;
  if (!trusted.includes(resolved) || current.version !== 1) {
    const next = { ...current, version: 1, trustedProjects: [...new Set([...trusted, resolved])] };
    validateConfiguration(next);
    output = JSON.stringify(next, null, 2) + '\n';
    await atomicWrite(path, output, 0o600, digest(text));
  }
  await recordManagedTarget({ home, target: path, identifier: 'project-trust', preHash: digest(text), postHash: digest(output) });
  return { status: 'trusted', target: 'project' };
}
export async function configure({ home = homedir(), values, confirm = false, preview = false }) {
  const path = join(dataDir(home), 'config.json');
  const { text } = await readTarget(path);
  const current = parseJson(text, path);
  const permitted = ['timezone', 'endOfDay', 'wrapUpMinutes', 'meaningfulWorkMinutes', 'workDays'];
  for (const key of Object.keys(values)) if (!permitted.includes(key)) throw new Error(`unsupported configuration field: ${key}`);
  const next = { ...current, ...values, version: 1 };
  validateConfiguration(next);
  if (preview) return { action: 'preview', target: 'global-configuration', current: redacted(current), owned: { ...values }, version: 1 };
  if (!confirm) throw new Error('explicit confirmation required to configure');
  const output = JSON.stringify(next, null, 2) + '\n';
  if (output !== text) await atomicWrite(path, output, 0o600, digest(text));
  await recordManagedTarget({ home, target: path, identifier: 'configuration', preHash: digest(text), postHash: digest(output) });
  return { status: 'configured', target: 'global-configuration' };
}
export async function uninstallAdapter({ home = homedir(), name, env = process.env, platform = process.platform }) {
  return withStateLock(home, () => uninstallAdapterLocked({ home, name, env, platform }), env, platform);
}
async function uninstallAdapterLocked({ home, name, env, platform }) {
  const state = await readState(home, env, platform);
  const prefix = `adapter:${name}`;
  const entries = Object.entries(state.targets).filter(([, record]) => record.ownedIdentifiers?.some(identifier => identifier === prefix || identifier.startsWith(`${prefix}:`)));
  if (!entries.length) return { status: 'not-installed', target: `${name}-hook`, removed: 0, skippedChanged: 0 };
  entries.sort(([, left], [, right]) => Number(right.ownedIdentifiers.some(identifier => identifier.endsWith(':config'))) - Number(left.ownedIdentifiers.some(identifier => identifier.endsWith(':config'))));
  const preflight = [];
  let skippedChanged = 0;
  for (const [target, record] of entries) {
    const current = await readTarget(target);
    const identifiers = record.ownedIdentifiers.filter(identifier => identifier === prefix || identifier.startsWith(`${prefix}:`));
    const configIdentifier = identifiers.find(identifier => identifier.endsWith(':config'));
    if (!current.info) {
      preflight.push([target, record, current, identifiers, true]);
      continue;
    }
    if (digest(current.text) !== record.postHash || (configIdentifier && record.ownedValues?.[configIdentifier] === undefined)) {
      skippedChanged += 1;
      continue;
    }
    preflight.push([target, record, current, identifiers]);
  }
  if (skippedChanged) return { status: 'partial', target: `${name}-hook`, removed: 0, skippedChanged };
  let removed = 0;
  for (const [target, record, { text, info }, identifiers, missing = false] of preflight) {
    if (missing) {
      delete state.targets[target];
      state.ownedIdentifiers = state.ownedIdentifiers.filter(item => !identifiers.some(identifier => item === `${target}:${identifier}`));
      removed += 1;
      await saveState(home, state, env, platform);
      continue;
    }
    if (identifiers.some(identifier => identifier.endsWith(':config'))) {
      const current = parseJson(text, target);
      const configIdentifier = identifiers.find(identifier => identifier.endsWith(':config'));
      const ownedValue = record.ownedValues?.[configIdentifier];
      if (name === 'opencode') {
        current.plugins = (current.plugins || []).filter(value => value !== ownedValue);
        if (!current.plugins.length) delete current.plugins;
      } else {
        const event = name === 'gemini-cli' ? 'BeforeAgent' : 'UserPromptSubmit';
        const hooks = { ...(current.hooks || {}) };
        hooks[event] = (hooks[event] || []).filter(entry => JSON.stringify(entry) !== JSON.stringify(ownedValue));
        if (!hooks[event].length) delete hooks[event];
        if (Object.keys(hooks).length) current.hooks = hooks;
        else delete current.hooks;
      }
      if (record.preHash === digest('') && !Object.keys(current).length) {
        if (!(await atomicRemove(target, record.postHash))) return { status: 'partial', target: `${name}-hook`, removed, skippedChanged: 1 };
      }
      else await atomicWrite(target, JSON.stringify(current, null, 2) + '\n', info?.mode ?? 0o600, record.postHash);
    } else {
      if (!(await atomicRemove(target, record.postHash))) return { status: 'partial', target: `${name}-hook`, removed, skippedChanged: 1 };
    }
    delete state.targets[target];
    state.ownedIdentifiers = state.ownedIdentifiers.filter(item => !identifiers.some(identifier => item === `${target}:${identifier}`));
    removed += 1;
    await saveState(home, state, env, platform);
  }
  return { status: skippedChanged ? 'partial' : 'uninstalled', target: `${name}-hook`, removed, skippedChanged };
}
export async function purgeUserState({ home = homedir(), confirm = false }) {
  if (!confirm) throw new Error('explicit confirmation required for purge');
  await rm(dataDir(home), { recursive: true, force: true });
  return { purged: true };
}
export async function detectIntegration(home = homedir(), { env = process.env, platformName = process.platform } = {}) {
  const config = {};
  const generalConfigHome = env.XDG_CONFIG_HOME || (platformName === 'win32' ? env.APPDATA : join(home, '.config'));
  const locations = {
    codex: join(home, '.codex', 'hooks.json'),
    'claude-code': join(home, '.claude', 'settings.json'),
    'gemini-cli': join(home, '.gemini', 'settings.json'),
    cursor: join(home, '.cursor', 'settings.json'),
    copilot: join(generalConfigHome, 'github-copilot', 'config.json'),
    opencode: join(generalConfigHome, 'opencode', 'opencode.json'),
    windsurf: join(home, '.codeium', 'windsurf', 'settings.json'),
  };
  for (const [name, location] of Object.entries(locations)) config[name] = await exists(location);
  const adapterAvailability = {};
  const extension = platformName === 'win32' ? 'cmd' : 'sh';
  for (const name of Object.keys(config)) adapterAvailability[name] = await exists(join(dataDir(home, env, platformName), 'adapters', `${name}.${extension}`));
  return { runtime: { node: process.version, nodeSupported: Number(process.versions.node.split('.')[0]) >= 20, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }, config, adapters: adapterAvailability };
}

function optionValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) if (args[index] === name && args[index + 1]) values.push(args[++index]);
  return values;
}
function configurationValues(args) {
  const values = {};
  const fields = { '--timezone': 'timezone', '--end-of-day': 'endOfDay', '--wrap-up-minutes': 'wrapUpMinutes', '--meaningful-work-minutes': 'meaningfulWorkMinutes', '--work-days': 'workDays' };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!(flag in fields)) continue;
    const value = args[++index];
    if (!value) throw new Error(`value required for ${flag}`);
    const key = fields[flag];
    values[key] = key === 'workDays' ? value.split(',') : key.endsWith('Minutes') ? Number(value) : value;
  }
  return values;
}
function validateOptions(args, { valueFlags = [], booleanFlags = [], positional = false } = {}) {
  const valueSet = new Set(valueFlags);
  const booleanSet = new Set(booleanFlags);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith('--')) {
      if (!positional) throw new Error(`unexpected argument: ${value}`);
      continue;
    }
    if (booleanSet.has(value)) continue;
    if (!valueSet.has(value)) throw new Error(`unknown option: ${value}`);
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`value required for ${value}`);
    index += 1;
  }
}
function defaultConfiguration() {
  return {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    endOfDay: '17:30',
    wrapUpMinutes: 30,
    meaningfulWorkMinutes: 15,
    workDays: ['mon', 'tue', 'wed', 'thu', 'fri'],
  };
}
export async function runSetup(args, { home = process.env.HOME || homedir(), write = value => console.log(value) } = {}) {
  const [command, ...rest] = args;
  const confirm = rest.includes('--confirm');
  const preview = rest.includes('--preview');
  const output = value => { write(JSON.stringify(value)); return 0; };
  if (command === 'doctor' || command === 'doctor-integration') {
    const health = await detectIntegration(home);
    return output({ status: health.runtime.nodeSupported ? 'ok' : 'warning', ...health });
  }
  if (command === 'trust-project') return output(await trustProject({ home, project: rest.find(x => !x.startsWith('--')), confirm }));
  if (command === 'uninstall') {
    if (rest.includes('--purge')) {
      if (!confirm) throw new Error('explicit confirmation required for purge');
      const state = await readState(home);
      const names = [...new Set(Object.values(state.targets).flatMap(record => record.ownedIdentifiers ?? []).map(identifier => /^adapter:([^:]+)/.exec(identifier)?.[1]).filter(Boolean))];
      const adapters = [];
      for (const name of names) {
        const result = await uninstallAdapter({ home, name });
        adapters.push({ name, ...result });
        if (result.status !== 'uninstalled') return output({ status: result.status, adapters });
      }
      await purgeUserState({ home, confirm: true });
      return output({ purged: true, adapters });
    }
    if (!confirm) throw new Error('explicit confirmation required to uninstall adapter');
    const name = rest.find(item => !item.startsWith('--'));
    if (!name) throw new Error('adapter name required');
    return output(await uninstallAdapter({ home, name }));
  }
  if (command === 'configure') {
    validateOptions(rest, { valueFlags: ['--timezone', '--end-of-day', '--wrap-up-minutes', '--meaningful-work-minutes', '--work-days'], booleanFlags: ['--confirm', '--preview'] });
    const values = configurationValues(rest);
    return output(await configure({ home, values, confirm, preview }));
  }
  if (command === 'setup') {
    validateOptions(rest, { valueFlags: ['--adapter', '--timezone', '--end-of-day', '--wrap-up-minutes', '--meaningful-work-minutes', '--work-days'], booleanFlags: ['--confirm', '--preview'] });
    const values = { ...defaultConfiguration(), ...configurationValues(rest) };
    const names = optionValues(rest, '--adapter');
    for (const name of names) adapterNameGuard(name);
    if (preview) {
      const adapterResult = names.length ? await (await import('./adapters.mjs')).installAdapters({ home, names, preview: true }) : { adapters: {} };
      return output({ action: 'preview', configuration: values, adapters: adapterResult.adapters });
    }
    if (!confirm) throw new Error('explicit confirmation required');
    if (names.length) await (await import('./adapters.mjs')).preflightAdapters({ home, names });
    await configure({ home, values, confirm: true });
    let adapterResult;
    try {
      adapterResult = names.length ? await (await import('./adapters.mjs')).installAdapters({ home, names, confirm: true }) : { schema: 1, adapters: {} };
    } catch (cause) {
      const error = new Error('setup partially completed; retry setup or run uninstall --purge --confirm');
      error.code = 'PARTIAL_SETUP';
      error.cause = cause;
      throw error;
    }
    return output({ status: 'configured', configuration: 'global-configuration', adapters: adapterResult.adapters });
  }
  if (command === 'install-adapters') {
    validateOptions(rest, { valueFlags: ['--adapter'], booleanFlags: ['--confirm'], positional: true });
    if (!confirm) throw new Error('explicit confirmation required');
    const names = optionValues(rest, '--adapter').length ? optionValues(rest, '--adapter') : rest.filter((value, index) => !value.startsWith('--') && rest[index - 1] !== '--adapter');
    const { installAdapters } = await import('./adapters.mjs');
    return output(await installAdapters({ home, names, confirm: true }));
  }
  throw new Error('usage: setup|configure|trust-project|install-adapters|doctor|uninstall [--purge]');
}
function adapterNameGuard(name) {
  const allowed = ['codex', 'claude-code', 'gemini-cli', 'cursor', 'copilot', 'opencode', 'windsurf'];
  if (!allowed.includes(name)) throw new Error(`unknown adapter: ${name}`);
}
async function main(args) {
  return runSetup(args);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => { console.error(`workday-aware: ${error.message.includes('confirmation') || error.code === 'PARTIAL_SETUP' ? error.message : 'operation failed'}`); process.exitCode = 1; });
