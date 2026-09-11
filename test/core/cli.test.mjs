import assert from 'node:assert/strict';
import test from 'node:test';

import { run } from '../../skills/workday-aware/scripts/workday-aware.mjs';

test('status human output contains local clock, IANA zone, boundaries, duration, and source', () => {
  const output = [];
  const code = run(['status', '--now', '2026-09-10T14:30:00.000Z'], { write: (line) => output.push(line), config: { timezone: 'Europe/Berlin', workDays: ['mon'], endOfDay: '17:30', wrapUpMinutes: 30, meaningfulWorkMinutes: 15, source: 'defaults' } });
  assert.equal(code, 0);
  assert.match(output[0], /16:30 Europe\/Berlin/);
  assert.match(output[0], /wrap-up 17:00, end of day 17:30, 30m to wrap-up, 1h to end of day \(defaults\)/);
});

test('assess accepts a range and emits JSON', () => {
  const output = [];
  const code = run(['assess', '--estimate', '31-60', '--kind', 'verification', '--json', '--now', '2026-09-10T14:30:00.000Z'], { write: (line) => output.push(line), config: { timezone: 'Europe/Berlin', workDays: ['thu'], endOfDay: '17:30', wrapUpMinutes: 30, meaningfulWorkMinutes: 15, source: 'project' } });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(output[0]).assessment.state, 'uses_wrap_up');
});

test('invalid invocation has bounded categorized status_unavailable output', () => {
  const output = [];
  assert.equal(run(['assess', '--estimate', 'wrong'], { write: (line) => output.push(line) }), 1);
  assert.deepEqual(JSON.parse(output[0]), { status: 'status_unavailable', category: 'invalid_arguments' });
});

test('assess requires --kind as an invalid-arguments error', () => {
  const output = [];
  assert.equal(run(['assess', '--estimate', '15'], { write: (line) => output.push(line) }), 1);
  assert.deepEqual(JSON.parse(output[0]), { status: 'status_unavailable', category: 'invalid_arguments' });
});

test('assess rejects an unsupported kind as an invalid-arguments error', () => {
  const output = [];
  assert.equal(run(['assess', '--estimate', '15', '--kind', 'unsupported'], { write: (line) => output.push(line) }), 1);
  assert.deepEqual(JSON.parse(output[0]), { status: 'status_unavailable', category: 'invalid_arguments' });
});

test('rejects command-unsupported flags and stray positional arguments', () => {
  for (const argumentsList of [
    ['status', '--estimate', '15'],
    ['doctor', '--now', '2026-01-01T00:00:00Z'],
    ['hook', '--json', '--adapter', 'codex'],
    ['status', 'unexpected'],
    ['unknown'],
  ]) {
    const output = [];
    assert.equal(run(argumentsList, { write: (line) => output.push(line) }), 1, argumentsList.join(' '));
    assert.deepEqual(JSON.parse(output[0]), { status: 'status_unavailable', category: 'invalid_arguments' });
  }
});

test('invalid configuration output is categorized', () => {
  const output = [];
  assert.equal(run(['status'], { write: (line) => output.push(line), config: { timezone: 'not-a-zone' } }), 1);
  assert.deepEqual(JSON.parse(output[0]), { status: 'status_unavailable', category: 'configuration_error' });
});

test('human assess has bounded scheduling context and guidance', () => {
  const output = [];
  run(['assess', '--estimate', '31-60', '--kind', 'verification', '--now', '2026-09-10T14:30:00.000Z'], { write: (line) => output.push(line), config: { timezone: 'Europe/Berlin', workDays: ['thu'], endOfDay: '17:30', wrapUpMinutes: 30, meaningfulWorkMinutes: 15, source: 'global' } });
  assert.match(output[0], /16:30 Europe\/Berlin.*wrap-up 17:00.*end of day 17:30.*30m.*1h.*31m–1h.*uses wrap-up.*pause; propose a smaller slice/);
  assert.doesNotMatch(output[0], /uses_wrap_up/);
});

test('human status reports symbolic configuration fallback warnings', () => {
  const output = [];
  run(['status', '--now', '2026-01-05T10:00:00Z'], { write: (line) => output.push(line), config: { timezone: 'UTC', workDays: ['mon'], endOfDay: '17:30', wrapUpMinutes: 30, meaningfulWorkMinutes: 15, source: 'defaults', warnings: ['global_config_invalid'] } });
  assert.match(output[0], /global configuration invalid/);
  assert.doesNotMatch(output[0], /global_config_invalid/);
});

test('doctor JSON returns bounded runtime and configuration health', () => {
  const output = [];
  assert.equal(run(['doctor', '--json'], { write: (line) => output.push(line), config: { timezone: 'UTC', workDays: ['thu'], endOfDay: '17:30', wrapUpMinutes: 30, meaningfulWorkMinutes: 15, source: 'defaults', warnings: ['global_config_invalid'] } }), 0);
  assert.deepEqual(JSON.parse(output[0]), { status: 'warning', source: 'defaults', warnings: ['global_config_invalid'], node: process.version });
});

test('hook emits adapter-shaped context or explicit instruction-only output', () => {
  const context = [];
  assert.equal(run(['hook', '--adapter', 'codex', '--now', '2026-09-10T14:30:00.000Z'], { write: (line) => context.push(line), config: { timezone: 'UTC', workDays: ['thu'], endOfDay: '17:30', wrapUpMinutes: 30, meaningfulWorkMinutes: 15, source: 'defaults' } }), 0);
  assert.equal(JSON.parse(context[0]).hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(JSON.parse(context[0]).hookSpecificOutput.additionalContext, /wrap-up/);
  assert.match(JSON.parse(context[0]).hookSpecificOutput.additionalContext, /15m meaningful-work threshold/);
  const instructionOnly = [];
  run(['hook', '--adapter', 'cursor'], { write: (line) => instructionOnly.push(line), config: { timezone: 'UTC', workDays: ['thu'], endOfDay: '17:30', wrapUpMinutes: 30, meaningfulWorkMinutes: 15, source: 'defaults' } });
  assert.deepEqual(JSON.parse(instructionOnly[0]), { adapter: 'cursor', mode: 'instruction_only', status: 'ok' });
});
