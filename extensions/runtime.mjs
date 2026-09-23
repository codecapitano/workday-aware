import {
  assessWork,
  formatAssessment,
  formatDuration,
  formatStatus,
  getWorkdayStatus,
  loadConfiguration,
} from '../skills/workday-aware/scripts/core.mjs';

export function resolveStatus({ cwd = process.cwd(), env = process.env, now = new Date() } = {}) {
  return getWorkdayStatus(loadConfiguration({ cwd, env }), now);
}

export function assessStatus(status, input) {
  return { assessment: assessWork(status, input), text: formatAssessment(status, input) };
}

export function buildWorkdayGuidance(status) {
  return [
    `Current Workday status: ${formatStatus(status)}.`,
    `Before non-trivial work with a pessimistic maximum estimate of at least ${formatDuration(status.meaningfulWorkMinutes)}, call workday_assess with the estimate and task kind.`,
    "If the assessment may cross wrap-up, uses wrap-up, exceeds end of day, or starts after end of day, report it and pause for the user's decision before starting.",
    'Apply an explicit override only to the current task. Do not silently split or defer work.',
  ].join('\n');
}

export function createBoundaryTracker(initialStatus) {
  let localDate = initialStatus.localDate;
  let notified = reachedBoundaries(initialStatus.phase);

  return {
    update(status) {
      if (status.localDate !== localDate) {
        localDate = status.localDate;
        notified = reachedBoundaries(status.phase);
        return [];
      }
      if (status.phase === 'after_eod' && !notified.has('end_of_day')) {
        notified.add('wrap_up');
        notified.add('end_of_day');
        return ['end_of_day'];
      }
      if (status.phase === 'wrap_up' && !notified.has('wrap_up')) {
        notified.add('wrap_up');
        return ['wrap_up'];
      }
      return [];
    },
  };
}

function reachedBoundaries(phase) {
  if (phase === 'after_eod') return new Set(['wrap_up', 'end_of_day']);
  if (phase === 'wrap_up') return new Set(['wrap_up']);
  return new Set();
}

export function formatFooterStatus(status) {
  if (status.phase === 'before_wrap_up') return `Workday: ${formatDuration(status.remainingToWrapUp)} to wrap-up · ${formatDuration(status.remainingToEndOfDay)} to EOD`;
  if (status.phase === 'wrap_up') return `Workday: wrap-up · ${formatDuration(status.remainingToEndOfDay)} to EOD`;
  if (status.phase === 'after_eod') return 'Workday: end of day passed';
  return 'Workday: no boundary today';
}
