import { chmod, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, dataDir, digest, isManagedTarget, readTarget, recordManagedTarget, withStateLock } from './setup.mjs';

export const adapters = Object.freeze({
  codex: { tier: 'automatic', event: 'UserPromptSubmit', message: 'Automatic hook wrapper installed.' },
  'claude-code': { tier: 'automatic', event: 'UserPromptSubmit', message: 'Automatic hook wrapper installed.' },
  'gemini-cli': { tier: 'automatic', event: 'BeforeAgent', message: 'Automatic hook wrapper installed.' },
  cursor: { tier: 'instruction-only', message: 'Manual configuration required; Cursor has no reliable hook injection surface.' },
  copilot: { tier: 'instruction-only', message: 'Manual configuration required; GitHub Copilot has no reliable hook injection surface.' },
  opencode: { tier: 'best-effort', event: 'context', message: 'Native context plugin installed on a best-effort basis.' },
  windsurf: { tier: 'instruction-only', message: 'Manual configuration required; Windsurf has no reliable hook injection surface.' },
});
export function adapterStatus(name) { if (!adapters[name]) throw new Error(`unknown adapter: ${name}`); return { name, ...adapters[name] }; }
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const json = value => JSON.stringify(value, null, 2) + '\n';
const hostConfigHome = (home, platform, env) => {
  const candidates = [env.XDG_CONFIG_HOME, platform === 'win32' ? env.APPDATA : join(home, '.config')];
  const root = candidates.find(candidate => candidate && (isAbsolute(candidate) || (platform === 'win32' && win32.isAbsolute(candidate))));
  if (!root) throw new Error('absolute host configuration directory unavailable');
  return root;
};
const configTarget = (home, name, platform, env) => ({
  codex: join(home, '.codex', 'hooks.json'),
  'claude-code': join(home, '.claude', 'settings.json'),
  'gemini-cli': join(home, '.gemini', 'settings.json'),
  opencode: join(hostConfigHome(home, platform, env), 'opencode', 'opencode.json'),
}[name]);
const adapterName = name => ({ 'claude-code': 'claude', 'gemini-cli': 'gemini' })[name] || name;
const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

function parseHostConfig(text, target) {
  let current;
  try { current = text ? JSON.parse(text) : {}; } catch { throw new Error(`invalid JSON in ${target}`); }
  if (!isObject(current)) throw new Error(`invalid configuration in ${target}`);
  return current;
}

function validateHookConfig(current, event, target) {
  if (current.hooks !== undefined && !isObject(current.hooks)) throw new Error(`invalid hook configuration in ${target}`);
  if (current.hooks?.[event] !== undefined && !Array.isArray(current.hooks[event])) throw new Error(`invalid hook configuration in ${target}`);
  return current;
}

function validateOpenCodeConfig(current, target) {
  if (current.plugins !== undefined && !Array.isArray(current.plugins)) throw new Error(`invalid plugin configuration in ${target}`);
  return current;
}

async function writeManaged({ home, target, text, identifier, mode = 0o600, ownedValue, shared = false, executable = false, expectedHash, env, platform }) {
  const before = await readTarget(target);
  const preHash = digest(before.text);
  if (expectedHash !== undefined && expectedHash !== preHash) throw new Error(`target changed concurrently: ${target}`);
  const restoreOwnerExecute = executable && before.info && !(before.info.mode & 0o100);
  if (before.text === text) {
    if (restoreOwnerExecute && await isManagedTarget({ home, target, identifier, hash: preHash, env, platform })) {
      await chmod(target, (before.info.mode & 0o7777) | 0o100);
      return true;
    }
    return false;
  }
  if (before.info && !shared && !(await isManagedTarget({ home, target, identifier, hash: preHash, env, platform }))) throw new Error(`refusing unmanaged target: ${target}`);
  await atomicWrite(target, text, before.info?.mode ?? mode, preHash);
  if (restoreOwnerExecute) await chmod(target, (before.info.mode & 0o7777) | 0o100);
  await recordManagedTarget({ home, target, identifier, preHash, postHash: digest(text), ownedValue, env, platform });
  return true;
}

function configEntry(name, command) {
  if (name === 'gemini-cli') return { hooks: [{ name: 'workday-aware', type: 'command', command, timeout: 3000 }] };
  return { hooks: [{ ...(name === 'codex' ? {} : { name: 'workday-aware' }), type: 'command', command, timeout: 3 }] };
}

async function installHookConfig({ home, name, command, platform, env }) {
  const target = configTarget(home, name, platform, env);
  const before = await readTarget(target);
  const event = adapters[name].event;
  const current = validateHookConfig(parseHostConfig(before.text, target), event, target);
  const hooks = { ...(current.hooks || {}) };
  const entry = configEntry(name, command);
  const entries = [...(hooks[event] || [])];
  if (entries.some(value => JSON.stringify(value) === JSON.stringify(entry))) return;
  entries.push(entry);
  hooks[event] = entries;
  await writeManaged({ home, target, text: json({ ...current, hooks }), identifier: `adapter:${name}:config`, ownedValue: entry, shared: true, expectedHash: digest(before.text), env, platform });
}

function openCodePlugin(core) {
  return `import { Plugin } from \"@opencode/plugin\";\n\nexport default Plugin.define({\n  id: \"workday-aware\",\n  async setup(ctx) {\n    await ctx.session.hook(\"context\", (event) => {\n      try {\n        const result = Bun.spawnSync([\"node\", ${JSON.stringify(core)}, \"hook\", \"--adapter\", \"opencode\"], { stdin: \"ignore\", stdout: \"pipe\", stderr: \"ignore\", timeout: 3000 });\n        const payload = JSON.parse(new TextDecoder().decode(result.stdout));\n        if (payload.context) event.system.push({ text: payload.context });\n      } catch {}\n    });\n  },\n});\n`;
}

function wrapperScripts(core, hookAdapter) {
  const windows = `@echo off\r\npowershell -NoProfile -Command "$p=New-Object System.Diagnostics.Process; $p.StartInfo.FileName='node'; $p.StartInfo.Arguments='\"${core.replaceAll("'", "''")}\" hook --adapter ${hookAdapter}'; $p.StartInfo.UseShellExecute=$false; $p.StartInfo.RedirectStandardInput=$true; $p.StartInfo.RedirectStandardOutput=$true; $null=$p.Start(); $p.StandardInput.Close(); if($p.WaitForExit(3000) -and $p.ExitCode -eq 0){[Console]::Out.Write($p.StandardOutput.ReadToEnd()); exit 0}else{if(-not $p.HasExited){$p.Kill()}; exit 1}"\r\nif errorlevel 1 echo {"status":"status_unavailable","category":"adapter_hook_failed"}\r\nexit /b 0\r\n`;
  const posix = `#!/bin/sh\n# Prompt stdin is intentionally discarded; hooks must fail open.\nexec </dev/null\nnode ${quote(core)} hook --adapter ${quote(hookAdapter)} &\nhook_pid=$!\n(\n  sleep 3\n  kill -TERM "$hook_pid" 2>/dev/null\n) >/dev/null 2>&1 &\nguard_pid=$!\nif wait "$hook_pid"; then\n  hook_status=0\nelse\n  hook_status=$?\nfi\nkill "$guard_pid" 2>/dev/null\nwait "$guard_pid" 2>/dev/null\nif [ "$hook_status" -ne 0 ]; then\n  printf '%s\\n' '{"status":"status_unavailable","category":"adapter_hook_failed"}'\nfi\nexit 0\n`;
  return { windows, posix };
}

function wrapperTargets(home, name, platform, env, core) {
  const root = join(dataDir(home, env, platform), 'adapters');
  const scripts = wrapperScripts(core, adapterName(name));
  if (platform === 'win32') return [{ target: join(root, `${name}.cmd`), text: scripts.windows, identifier: `adapter:${name}` }];
  return [
    { target: join(root, `${name}.sh`), text: scripts.posix, identifier: `adapter:${name}`, executable: true },
    { target: join(root, `${name}.cmd`), text: scripts.windows, identifier: `adapter:${name}:windows-wrapper` },
  ];
}

async function installOpenCode({ home, command, core, platform, env }) {
  const root = join(hostConfigHome(home, platform, env), 'opencode');
  await writeManaged({ home, target: join(root, 'plugins', 'workday-aware.js'), text: openCodePlugin(core), identifier: 'adapter:opencode:plugin', mode: 0o700, env, platform });
  const target = configTarget(home, 'opencode', platform, env);
  const before = await readTarget(target);
  const current = validateOpenCodeConfig(parseHostConfig(before.text, target), target);
  const plugin = join(root, 'plugins', 'workday-aware.js');
  const plugins = [...(current.plugins || [])];
  if (plugins.includes(plugin)) return;
  plugins.push(plugin);
  await writeManaged({ home, target, text: json({ ...current, plugins }), identifier: 'adapter:opencode:config', ownedValue: plugin, shared: true, expectedHash: digest(before.text), env, platform });
}

function preview(name) {
  const status = adapterStatus(name);
  if (status.tier === 'instruction-only') return { status: 'instruction-only', tier: status.tier, target: `${name}-hook`, message: status.message };
  return { status: 'would-install', tier: status.tier, target: `${name}-hook`, owned: name === 'opencode' ? ['wrapper', 'context-plugin', 'plugin-config'] : ['wrapper', `hook:${status.event}`], message: status.message };
}

export async function preflightAdapters({ home = homedir(), names = Object.keys(adapters), platform = process.platform, env = process.env }) {
  const core = resolve(fileURLToPath(new URL('./workday-aware.mjs', import.meta.url)));
  for (const name of names) {
    const status = adapterStatus(name);
    if (status.tier === 'instruction-only') continue;
    const target = configTarget(home, name, platform, env);
    const before = await readTarget(target);
    const current = parseHostConfig(before.text, target);
    if (name === 'opencode') validateOpenCodeConfig(current, target);
    else validateHookConfig(current, status.event, target);
    for (const wrapper of wrapperTargets(home, name, platform, env, core)) {
      const current = await readTarget(wrapper.target);
      if (current.info && current.text !== wrapper.text && !(await isManagedTarget({ home, target: wrapper.target, identifier: wrapper.identifier, hash: digest(current.text), env, platform }))) throw new Error(`refusing unmanaged target: ${wrapper.target}`);
    }
    if (name === 'opencode') {
      const plugin = join(hostConfigHome(home, platform, env), 'opencode', 'plugins', 'workday-aware.js');
      const current = await readTarget(plugin);
      if (current.info && current.text !== openCodePlugin(core) && !(await isManagedTarget({ home, target: plugin, identifier: 'adapter:opencode:plugin', hash: digest(current.text), env, platform }))) throw new Error(`refusing unmanaged target: ${plugin}`);
    }
  }
}

export async function installAdapters({ home = homedir(), names = Object.keys(adapters), confirm = false, preview: isPreview = false, platform = process.platform, env = process.env }) {
  if (isPreview) return { schema: 1, action: 'preview', adapters: Object.fromEntries(names.map(name => [name, preview(name)])) };
  if (!confirm) throw new Error('explicit confirmation required to install adapters');
  return withStateLock(home, async () => {
    await preflightAdapters({ home, names, platform, env });
    return installAdaptersLocked({ home, names, platform, env });
  }, env, platform);
}
async function installAdaptersLocked({ home, names, platform, env }) {
  const root = join(dataDir(home, env, platform), 'adapters');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const core = resolve(fileURLToPath(new URL('./workday-aware.mjs', import.meta.url)));
  const result = { schema: 1, adapters: {} };
  for (const name of names) {
    const status = adapterStatus(name);
    if (status.tier === 'instruction-only') { result.adapters[name] = { status: 'instruction-only', message: status.message }; continue; }
    const targets = wrapperTargets(home, name, platform, env, core);
    const primary = targets[0];
    const changed = await writeManaged({ home, ...primary, mode: 0o700, env, platform });
    for (const supplemental of targets.slice(1)) await writeManaged({ home, ...supplemental, mode: 0o700, env, platform });
    const wrapper = primary.target;
    const command = platform === 'win32' ? `"${wrapper}"` : quote(join(root, `${name}.sh`));
    if (name === 'opencode') await installOpenCode({ home, command, core, platform, env });
    else await installHookConfig({ home, name, command, platform, env });
    result.adapters[name] = { status: 'installed', changed, tier: status.tier, target: `${name}-hook`, message: status.message };
  }
  return result;
}
