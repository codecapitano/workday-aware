import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';

const DEFAULTS = Object.freeze({
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  workDays: ['mon', 'tue', 'wed', 'thu', 'fri'],
  endOfDay: '17:30',
  wrapUpMinutes: 30,
  meaningfulWorkMinutes: 15,
});
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const SCHEDULE_KEYS = new Set(Object.keys(DEFAULTS));
const ALL_KEYS = new Set([...SCHEDULE_KEYS, 'version', 'trustedProjects']);
const KINDS = new Set(['implementation', 'research', 'verification', 'cleanup', 'handoff']);

export function formatDuration(minutes) {
  const value = Math.max(0, Math.trunc(minutes));
  const hours = Math.floor(value / 60);
  const remainder = value % 60;
  if (!hours) return `${remainder}m`;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

export function formatDurationRange(minimum, maximum) {
  return minimum === maximum ? formatDuration(minimum) : `${formatDuration(minimum)}–${formatDuration(maximum)}`;
}

function validZone(timezone) {
  try { Intl.DateTimeFormat('en-US', { timeZone: timezone }); return true; } catch { return false; }
}

function parseClock(value, label = 'endOfDay') {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error(`invalid ${label}`);
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

export function validateConfiguration(input, { project = false, partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('configuration must be an object');
  for (const key of Object.keys(input)) {
    if (!(project ? SCHEDULE_KEYS : ALL_KEYS).has(key)) throw new Error(`unknown configuration key: ${key}`);
  }
  if ('version' in input && input.version !== 1) throw new Error('unsupported configuration version');
  if ('timezone' in input && !validZone(input.timezone)) throw new Error('invalid timezone');
  if ('workDays' in input && (!Array.isArray(input.workDays) || !input.workDays.length || input.workDays.some((day) => !DAYS.includes(day)) || new Set(input.workDays).size !== input.workDays.length)) throw new Error('invalid workDays');
  const endOfDay = 'endOfDay' in input ? parseClock(input.endOfDay) : parseClock(DEFAULTS.endOfDay);
  const wrapUp = 'wrapUpMinutes' in input ? input.wrapUpMinutes : DEFAULTS.wrapUpMinutes;
  const meaningful = 'meaningfulWorkMinutes' in input ? input.meaningfulWorkMinutes : DEFAULTS.meaningfulWorkMinutes;
  if (!Number.isInteger(wrapUp) || wrapUp < 0 || (!partial && wrapUp >= endOfDay)) throw new Error(wrapUp >= endOfDay ? 'overnight shifts are unsupported' : 'invalid wrapUpMinutes');
  if (!Number.isInteger(meaningful) || meaningful < 0 || meaningful > 24 * 60) throw new Error('invalid meaningfulWorkMinutes');
  if ('trustedProjects' in input && (!Array.isArray(input.trustedProjects) || input.trustedProjects.some((path) => typeof path !== 'string' || !(/^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/).test(path)))) throw new Error('invalid trustedProjects');
  return input;
}

function localParts(now, timezone, formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })) {
  const parts = formatter.formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return { weekday: get('weekday').toLowerCase(), year: Number(get('year')), month: Number(get('month')), day: Number(get('day')), localTime: `${get('hour')}:${get('minute')}`, minuteOfDay: Number(get('hour')) * 60 + Number(get('minute')) };
}

function localBoundary(local, minuteOfDay, timezone, formatter) {
  const start = Date.UTC(local.year, local.month - 1, local.day, 0, 0) - 18 * 60 * 60 * 1000;
  let firstAfterGap;
  for (let offset = 0; offset <= 36 * 60; offset += 1) {
    const instant = new Date(start + offset * 60 * 1000);
    const candidate = localParts(instant, timezone, formatter);
    if (candidate.year !== local.year || candidate.month !== local.month || candidate.day !== local.day) continue;
    if (candidate.minuteOfDay === minuteOfDay) return instant;
    if (!firstAfterGap && candidate.minuteOfDay > minuteOfDay) firstAfterGap = instant;
  }
  return firstAfterGap;
}

export function getWorkdayStatus(configuration = {}, now = new Date()) {
  const config = { ...DEFAULTS, ...configuration };
  const { source = 'defaults', warnings = [], ...schedule } = config;
  validateConfiguration(schedule);
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const local = localParts(now, config.timezone, formatter);
  const endOfDayMinute = parseClock(config.endOfDay);
  const wrapUpMinute = endOfDayMinute - config.wrapUpMinutes;
  const wrapUpBoundary = localBoundary(local, wrapUpMinute, config.timezone, formatter);
  const endOfDayBoundary = localBoundary(local, endOfDayMinute, config.timezone, formatter);
  const remaining = (boundary) => Math.max(0, Math.floor((boundary.valueOf() - now.valueOf()) / 60000));
  const base = { timezone: config.timezone, localDate: `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`, localTime: local.localTime, endOfDay: config.endOfDay, wrapUp: `${String(Math.floor(wrapUpMinute / 60)).padStart(2, '0')}:${String(wrapUpMinute % 60).padStart(2, '0')}`, meaningfulWorkMinutes: config.meaningfulWorkMinutes, remainingToWrapUp: remaining(wrapUpBoundary), remainingToEndOfDay: remaining(endOfDayBoundary), source, warnings };
  if (!config.workDays.includes(local.weekday)) return { ...base, state: 'no_boundary', phase: 'no_boundary' };
  if (now >= endOfDayBoundary) return { ...base, state: 'after_eod', phase: 'after_eod' };
  return { ...base, state: 'workday', phase: now >= wrapUpBoundary ? 'wrap_up' : 'before_wrap_up' };
}

export function assessWork(status, { minMinutes, maxMinutes = minMinutes, kind } = {}) {
  if (!Number.isInteger(minMinutes) || !Number.isInteger(maxMinutes) || minMinutes < 0 || maxMinutes < minMinutes) throw new Error('invalid estimate');
  if (!KINDS.has(kind)) throw new Error('invalid kind');
  if (status.state === 'no_boundary') return { state: 'no_boundary', kind };
  if (status.state === 'after_eod') return { state: 'after_eod', kind };
  if (maxMinutes > status.remainingToEndOfDay) return { state: 'exceeds_eod', kind };
  if (maxMinutes <= status.remainingToWrapUp) return { state: 'fits_before_wrap_up', kind };
  if (minMinutes <= status.remainingToWrapUp) return { state: 'may_fit', kind };
  if (maxMinutes <= status.remainingToEndOfDay) return { state: 'uses_wrap_up', kind };
  return { state: 'exceeds_eod', kind };
}

export function formatAssessment(status, input) {
  const assessment = assessWork(status, input);
  const maxMinutes = input.maxMinutes ?? input.minMinutes;
  const stateLabel = {
    fits_before_wrap_up: 'fits before wrap-up',
    may_fit: 'may fit before wrap-up',
    uses_wrap_up: 'uses wrap-up',
    exceeds_eod: 'exceeds end of day',
    after_eod: 'after end of day',
    no_boundary: 'no workday boundary',
  }[assessment.state];
  const guidance = ['fits_before_wrap_up', 'no_boundary'].includes(assessment.state) ? 'proceed' : assessment.state === 'after_eod' ? 'pause' : 'pause; propose a smaller slice';
  return `${formatStatus(status)}; estimate ${formatDurationRange(input.minMinutes, maxMinutes)}; ${stateLabel}; ${guidance}`;
}

function readJson(path, project) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!project && value.version !== 1) throw new Error('unsupported configuration version');
  return validateConfiguration(value, { project, partial: project });
}

function globalConfigPath(env, platformName) {
  const roots = [env.WORKDAY_AWARE_CONFIG_HOME, env.XDG_CONFIG_HOME, platformName === 'win32' ? env.APPDATA : join(homedir(), '.config')];
  const root = roots.find((candidate) => candidate && (isAbsolute(candidate) || (platformName === 'win32' && win32.isAbsolute(candidate))));
  if (!root) return undefined;
  return [join(root, 'workday-aware', 'config.json'), join(root, 'workday-aware.json')].find(existsSync);
}

function gitRoot(cwd) {
  let current = resolve(cwd);
  while (dirname(current) !== current) {
    if (existsSync(join(current, '.git'))) return current;
    current = dirname(current);
  }
  return existsSync(join(current, '.git')) ? current : undefined;
}

export function loadConfiguration({ cwd = process.cwd(), env = process.env, platformName = platform() } = {}) {
  const globalPath = globalConfigPath(env, platformName);
  const warnings = [];
  let global = {};
  if (globalPath) {
    try { global = readJson(globalPath, false); } catch { warnings.push('global_config_invalid'); }
  }
  const root = gitRoot(cwd);
  let project = {};
  const projectPath = root && join(root, '.workday-aware.json');
  if (projectPath && global.trustedProjects?.includes(root)) {
    if (existsSync(projectPath)) {
      try {
        project = readJson(projectPath, true);
        validateConfiguration({ ...DEFAULTS, ...global, ...project });
      } catch {
        project = {};
        warnings.push('project_config_invalid');
      }
    }
  } else if (projectPath && existsSync(projectPath)) {
    warnings.push('untrusted_project_config');
  }
  return { ...DEFAULTS, ...global, ...project, source: Object.keys(project).length ? 'project' : Object.keys(global).length ? 'global' : 'defaults', warnings };
}

export function formatStatus(status) {
  const warningLabels = {
    global_config_invalid: 'global configuration invalid; using safe fallback',
    project_config_invalid: 'project configuration invalid; using safe fallback',
    untrusted_project_config: 'project configuration not trusted; ignoring it',
  };
  const warning = status.warnings?.length ? `; warning: ${status.warnings.map((item) => warningLabels[item] ?? 'configuration warning').join('; ')}` : '';
  return `${status.localTime} ${status.timezone}, wrap-up ${status.wrapUp}, end of day ${status.endOfDay}, ${formatDuration(status.remainingToWrapUp)} to wrap-up, ${formatDuration(status.remainingToEndOfDay)} to end of day (${status.source}), ${formatDuration(status.meaningfulWorkMinutes)} meaningful-work threshold${warning}`;
}
