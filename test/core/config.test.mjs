import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadConfiguration } from '../../skills/workday-aware/scripts/core.mjs';

test('uses project schedule only from an explicitly trusted Git root', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'workday-aware-'));
  const root = join(fixture, 'project');
  const configHome = join(fixture, 'config');
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(configHome);
  writeFileSync(join(configHome, 'workday-aware.json'), JSON.stringify({ version: 1, timezone: 'Europe/Berlin', trustedProjects: [root] }));
  writeFileSync(join(root, '.workday-aware.json'), JSON.stringify({ endOfDay: '16:00' }));
  const config = loadConfiguration({ cwd: join(root, 'child'), env: { WORKDAY_AWARE_CONFIG_HOME: configHome } });
  assert.equal(config.endOfDay, '16:00');
  assert.equal(config.source, 'project');
  assert.equal('trustedProjects' in config, true);
});

test('falls back with a symbolic warning when global configuration lacks version 1', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'workday-aware-'));
  writeFileSync(join(fixture, 'workday-aware.json'), JSON.stringify({ timezone: 'Europe/Berlin' }));
  assert.deepEqual(loadConfiguration({ cwd: fixture, env: { WORKDAY_AWARE_CONFIG_HOME: fixture } }).warnings, ['global_config_invalid']);
});

test('falls back with symbolic warnings for invalid global or trusted project configuration', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'workday-aware-'));
  const root = join(fixture, 'project');
  const configHome = join(fixture, 'config');
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(configHome);
  writeFileSync(join(configHome, 'workday-aware.json'), '{invalid');
  const globalFallback = loadConfiguration({ cwd: root, env: { WORKDAY_AWARE_CONFIG_HOME: configHome } });
  assert.deepEqual(globalFallback.warnings, ['global_config_invalid']);
  writeFileSync(join(configHome, 'workday-aware.json'), JSON.stringify({ version: 1, trustedProjects: [root] }));
  writeFileSync(join(root, '.workday-aware.json'), '{invalid');
  const projectFallback = loadConfiguration({ cwd: root, env: { WORKDAY_AWARE_CONFIG_HOME: configHome } });
  assert.deepEqual(projectFallback.warnings, ['project_config_invalid']);
  assert.equal(projectFallback.source, 'global');
});

test('falls back to the global schedule when a trusted project override makes the merged schedule invalid', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'workday-aware-'));
  const root = join(fixture, 'project');
  const configHome = join(fixture, 'config');
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(configHome);
  writeFileSync(join(configHome, 'workday-aware.json'), JSON.stringify({ version: 1, endOfDay: '16:00', trustedProjects: [root] }));
  writeFileSync(join(root, '.workday-aware.json'), JSON.stringify({ wrapUpMinutes: 1000 }));
  const config = loadConfiguration({ cwd: root, env: { WORKDAY_AWARE_CONFIG_HOME: configHome } });
  assert.equal(config.endOfDay, '16:00');
  assert.equal(config.wrapUpMinutes, 30);
  assert.equal(config.source, 'global');
  assert.deepEqual(config.warnings, ['project_config_invalid']);
});

test('accepts a trusted project override that is valid only with the global schedule', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'workday-aware-'));
  const root = join(fixture, 'project');
  const configHome = join(fixture, 'config');
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(configHome);
  writeFileSync(join(configHome, 'workday-aware.json'), JSON.stringify({ version: 1, endOfDay: '23:00', trustedProjects: [root] }));
  writeFileSync(join(root, '.workday-aware.json'), JSON.stringify({ wrapUpMinutes: 1200 }));
  const config = loadConfiguration({ cwd: root, env: { WORKDAY_AWARE_CONFIG_HOME: configHome } });
  assert.equal(config.wrapUpMinutes, 1200);
  assert.equal(config.source, 'project');
  assert.deepEqual(config.warnings, []);
});

test('warns symbolically when an untrusted project configuration exists and accepts Windows absolute trust paths', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'workday-aware-'));
  const root = join(fixture, 'project');
  const configHome = join(fixture, 'config');
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(configHome);
  writeFileSync(join(configHome, 'workday-aware.json'), JSON.stringify({ version: 1, trustedProjects: ['C:\\repo', '\\\\server\\share'] }));
  writeFileSync(join(root, '.workday-aware.json'), JSON.stringify({ endOfDay: '16:00' }));
  const config = loadConfiguration({ cwd: root, env: { WORKDAY_AWARE_CONFIG_HOME: configHome } });
  assert.deepEqual(config.warnings, ['untrusted_project_config']);
  assert.equal(config.source, 'global');
});

test('uses AppData for Windows global configuration', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'workday-aware-'));
  const appData = join(fixture, 'AppData', 'Roaming');
  mkdirSync(join(appData, 'workday-aware'), { recursive: true });
  writeFileSync(join(appData, 'workday-aware', 'config.json'), JSON.stringify({ version: 1, timezone: 'UTC', endOfDay: '18:00' }));
  const config = loadConfiguration({ cwd: fixture, env: { APPDATA: appData }, platformName: 'win32' });
  assert.equal(config.timezone, 'UTC');
  assert.equal(config.endOfDay, '18:00');
  assert.equal(config.source, 'global');
});

test('prefers canonical config.json over the legacy config file', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'workday-aware-'));
  mkdirSync(join(fixture, 'workday-aware'));
  writeFileSync(join(fixture, 'workday-aware.json'), JSON.stringify({ version: 1, timezone: 'UTC', endOfDay: '16:00' }));
  writeFileSync(join(fixture, 'workday-aware', 'config.json'), JSON.stringify({ version: 1, timezone: 'UTC', endOfDay: '18:00' }));
  assert.equal(loadConfiguration({ cwd: fixture, env: { WORKDAY_AWARE_CONFIG_HOME: fixture } }).endOfDay, '18:00');
});

test('ignores relative global configuration roots', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'workday-aware-'));
  mkdirSync(join(fixture, 'config'));
  writeFileSync(join(fixture, 'config', 'workday-aware.json'), JSON.stringify({ version: 1, timezone: 'UTC' }));
  const originalCwd = process.cwd();
  process.chdir(fixture);
  try {
    const config = loadConfiguration({ cwd: fixture, env: { WORKDAY_AWARE_CONFIG_HOME: 'config' } });
    assert.equal(config.source, 'defaults');
    assert.equal(config.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  } finally {
    process.chdir(originalCwd);
  }
});
