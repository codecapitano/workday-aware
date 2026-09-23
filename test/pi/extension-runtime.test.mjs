import assert from 'node:assert/strict';
import test from 'node:test';

import { assessStatus, buildWorkdayGuidance, createBoundaryTracker, formatFooterStatus } from '../../extensions/runtime.mjs';

const base = {
  localDate: '2026-09-10',
  localTime: '16:30',
  timezone: 'Europe/Berlin',
  wrapUp: '17:00',
  endOfDay: '17:30',
  remainingToWrapUp: 30,
  remainingToEndOfDay: 60,
};

test('formats footer status according to the workday phase', () => {
  assert.equal(formatFooterStatus({ ...base, phase: 'before_wrap_up' }), 'Workday: 30m to wrap-up · 1h to EOD');
  assert.equal(formatFooterStatus({ ...base, phase: 'wrap_up', remainingToWrapUp: 0 }), 'Workday: wrap-up · 1h to EOD');
  assert.equal(formatFooterStatus({ ...base, phase: 'after_eod', remainingToWrapUp: 0, remainingToEndOfDay: 0 }), 'Workday: end of day passed');
  assert.equal(formatFooterStatus({ ...base, phase: 'no_boundary' }), 'Workday: no boundary today');
});

test('builds bounded model guidance with the assessment threshold', () => {
  const guidance = buildWorkdayGuidance({ ...base, phase: 'before_wrap_up', meaningfulWorkMinutes: 15, source: 'global', warnings: [] });
  assert.match(guidance, /15m meaningful-work threshold/);
  assert.match(guidance, /workday_assess/);
  assert.match(guidance, /pause for the user's decision/);
  assert.doesNotMatch(guidance, /\/Users\//);
});

test('assesses work through the shared core formatter', () => {
  const status = { ...base, phase: 'before_wrap_up', state: 'workday', meaningfulWorkMinutes: 15, source: 'global', warnings: [] };
  const result = assessStatus(status, { minMinutes: 31, maxMinutes: 60, kind: 'verification' });
  assert.equal(result.assessment.state, 'uses_wrap_up');
  assert.match(result.text, /31m–1h.*uses wrap-up.*pause; propose a smaller slice/);
  assert.match(assessStatus(status, { minMinutes: 15, kind: 'research' }).text, /estimate 15m;/);
});

test('emits each boundary once per session and local date', () => {
  const tracker = createBoundaryTracker({ ...base, phase: 'before_wrap_up' });
  assert.deepEqual(tracker.update({ ...base, phase: 'wrap_up' }), ['wrap_up']);
  assert.deepEqual(tracker.update({ ...base, phase: 'wrap_up' }), []);
  assert.deepEqual(tracker.update({ ...base, phase: 'after_eod' }), ['end_of_day']);
  assert.deepEqual(tracker.update({ ...base, phase: 'after_eod' }), []);

  const nextDay = { ...base, localDate: '2026-09-11', phase: 'before_wrap_up' };
  assert.deepEqual(tracker.update(nextDay), []);
  assert.deepEqual(tracker.update({ ...nextDay, phase: 'wrap_up' }), ['wrap_up']);
});
