#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { assessWork, formatDurationRange, formatStatus, getWorkdayStatus, loadConfiguration } from './core.mjs';

function parse(argumentsList) {
  const values = {};
  let command;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--json') {
      if (values.json) throw new Error('invalid_arguments');
      values.json = true;
    }
    else if (argument === '--estimate' || argument === '--kind' || argument === '--now' || argument === '--adapter') {
      const value = argumentsList[++index];
      if (!value || value.startsWith('--')) throw new Error('invalid_arguments');
      const name = argument.slice(2);
      if (name in values) throw new Error('invalid_arguments');
      values[name] = value;
    } else if (!command && ['status', 'assess', 'doctor', 'hook'].includes(argument)) command = argument;
    else throw new Error('invalid_arguments');
  }
  if (!command) throw new Error('invalid_arguments');
  const supported = {
    status: new Set(['json', 'now']),
    assess: new Set(['json', 'now', 'estimate', 'kind']),
    doctor: new Set(['json']),
    hook: new Set(['adapter', 'now']),
  }[command];
  if (Object.keys(values).some((name) => !supported.has(name))) throw new Error('invalid_arguments');
  if ((command === 'assess' && (!values.estimate || !values.kind)) || (command === 'hook' && !values.adapter)) throw new Error('invalid_arguments');
  return { command, values };
}

function estimate(value) {
  const match = /^(\d+)(?:-(\d+))?$/.exec(value ?? '');
  if (!match) throw new Error('invalid_arguments');
  const minMinutes = Number(match[1]);
  const maxMinutes = Number(match[2] ?? match[1]);
  if (maxMinutes < minMinutes) throw new Error('invalid_arguments');
  return { minMinutes, maxMinutes };
}

function failure(error, write) {
  const category = error.message === 'invalid_arguments' || error.message === 'invalid kind' ? 'invalid_arguments' : error.message.includes('configuration') || error.message.includes('timezone') || error.message.includes('workDays') || error.message.includes('endOfDay') || error.message.includes('wrapUp') ? 'configuration_error' : 'status_unavailable';
  write(JSON.stringify({ status: 'status_unavailable', category }));
  return 1;
}

export function run(argumentsList, { write = (line) => process.stdout.write(`${line}\n`), config, cwd, env } = {}) {
  try {
    const { command, values } = parse(argumentsList);
    const now = values.now ? new Date(values.now) : new Date();
    if (Number.isNaN(now.valueOf())) throw new Error('invalid_arguments');
    const assessmentInput = command === 'assess' ? { ...estimate(values.estimate), kind: values.kind } : undefined;
    const resolvedConfig = config ?? loadConfiguration({ cwd, env });
    const status = getWorkdayStatus(resolvedConfig, now);
    if (command === 'doctor') {
      const warnings = resolvedConfig.warnings ?? [];
      const result = { status: warnings.length ? 'warning' : 'ok', source: status.source, warnings, node: process.version };
      write(values.json ? JSON.stringify(result) : `configuration ${result.status} (${result.source}, ${result.warnings.length} warnings, Node ${result.node})`);
      return 0;
    }
    if (command === 'status') {
      write(values.json ? JSON.stringify(status) : formatStatus(status));
      return 0;
    }
    if (command === 'hook') {
      const adapter = values.adapter;
      if (!['codex', 'claude', 'gemini', 'cursor', 'copilot', 'opencode', 'windsurf'].includes(adapter)) throw new Error('invalid_arguments');
      const instructionOnly = ['cursor', 'copilot', 'windsurf'].includes(adapter);
      if (instructionOnly) {
        write(JSON.stringify({ adapter, mode: 'instruction_only', status: 'ok' }));
      } else if (adapter === 'codex' || adapter === 'claude') {
        write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: formatStatus(status) } }));
      } else if (adapter === 'gemini') {
        write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'BeforeAgent', additionalContext: formatStatus(status) } }));
      } else {
        write(JSON.stringify({ adapter, mode: 'context', status: 'ok', context: formatStatus(status) }));
      }
      return 0;
    }
    const assessment = assessWork(status, assessmentInput);
    if (values.json) write(JSON.stringify({ status, assessment }));
    else {
      const stateLabel = {
        fits_before_wrap_up: 'fits before wrap-up',
        may_fit: 'may fit before wrap-up',
        uses_wrap_up: 'uses wrap-up',
        exceeds_eod: 'exceeds end of day',
        after_eod: 'after end of day',
        no_boundary: 'no workday boundary',
      }[assessment.state];
      const guidance = ['fits_before_wrap_up', 'no_boundary'].includes(assessment.state) ? 'proceed' : assessment.state === 'after_eod' ? 'pause' : 'pause; propose a smaller slice';
      write(`${formatStatus(status)}; estimate ${formatDurationRange(assessmentInput.minMinutes, assessmentInput.maxMinutes)}; ${stateLabel}; ${guidance}`);
    }
    return 0;
  } catch (error) {
    return failure(error, write);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = run(process.argv.slice(2));
