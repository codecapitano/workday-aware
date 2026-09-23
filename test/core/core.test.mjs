import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessWork,
  formatDuration,
  formatDurationRange,
  getWorkdayStatus,
  validateConfiguration,
} from '../../skills/workday-aware/scripts/core.mjs';

const config = {
  timezone: 'Europe/Berlin',
  workDays: ['mon', 'tue', 'wed', 'thu', 'fri'],
  endOfDay: '17:30',
  wrapUpMinutes: 30,
  meaningfulWorkMinutes: 15,
};

test('formats compact durations without clock notation', () => {
  assert.equal(formatDuration(393), '6h 33m');
  assert.equal(formatDuration(1), '1m');
  assert.equal(formatDurationRange(45, 75), '45m–1h 15m');
});

test('reports workday boundaries in the configured IANA timezone', () => {
  const status = getWorkdayStatus(config, new Date('2026-09-10T14:30:00.000Z'));
  assert.deepEqual(
    { state: status.state, phase: status.phase, localDate: status.localDate, localTime: status.localTime, remainingToWrapUp: status.remainingToWrapUp, remainingToEndOfDay: status.remainingToEndOfDay },
    { state: 'workday', phase: 'before_wrap_up', localDate: '2026-09-10', localTime: '16:30', remainingToWrapUp: 30, remainingToEndOfDay: 60 },
  );
});

test('uses daylight-saving offsets from the IANA timezone database', () => {
  const winter = getWorkdayStatus(config, new Date('2026-01-15T15:30:00.000Z'));
  const summer = getWorkdayStatus(config, new Date('2026-07-15T14:30:00.000Z'));
  assert.equal(winter.localTime, '16:30');
  assert.equal(summer.localTime, '16:30');
  assert.equal(winter.remainingToEndOfDay, 60);
  assert.equal(summer.remainingToEndOfDay, 60);
});

test('calculates real remaining minutes across daylight-saving boundary instants', () => {
  const spring = { ...config, workDays: ['sun'], endOfDay: '02:30', wrapUpMinutes: 30 };
  const springStatus = getWorkdayStatus(spring, new Date('2026-03-29T00:30:00.000Z'));
  assert.deepEqual(
    { state: springStatus.state, remainingToWrapUp: springStatus.remainingToWrapUp, remainingToEndOfDay: springStatus.remainingToEndOfDay },
    { state: 'workday', remainingToWrapUp: 30, remainingToEndOfDay: 30 },
  );
  assert.equal(getWorkdayStatus(spring, new Date('2026-03-29T01:00:00.000Z')).state, 'after_eod');

  const fall = { ...config, workDays: ['sun'], endOfDay: '02:30', wrapUpMinutes: 30 };
  const fallStatus = getWorkdayStatus(fall, new Date('2026-10-24T23:30:00.000Z'));
  assert.deepEqual(
    { state: fallStatus.state, remainingToWrapUp: fallStatus.remainingToWrapUp, remainingToEndOfDay: fallStatus.remainingToEndOfDay },
    { state: 'workday', remainingToWrapUp: 30, remainingToEndOfDay: 60 },
  );
  assert.equal(getWorkdayStatus(fall, new Date('2026-10-25T00:30:00.000Z')).state, 'after_eod');
  assert.equal(getWorkdayStatus(fall, new Date('2026-10-25T01:00:00.000Z')).state, 'after_eod');
});

test('exposes the configured meaningful-work threshold to hooks and agents', () => {
  const status = getWorkdayStatus({ ...config, meaningfulWorkMinutes: 20 }, new Date('2026-09-10T14:30:00.000Z'));
  assert.equal(status.meaningfulWorkMinutes, 20);
});

test('reports precise phases at wrap-up, end of day, and non-workdays', () => {
  assert.equal(getWorkdayStatus(config, new Date('2026-09-10T14:59:59.000Z')).phase, 'before_wrap_up');
  assert.equal(getWorkdayStatus(config, new Date('2026-09-10T15:00:00.000Z')).phase, 'wrap_up');
  const endOfDay = getWorkdayStatus(config, new Date('2026-09-10T15:30:00.000Z'));
  assert.equal(endOfDay.state, 'after_eod');
  assert.equal(endOfDay.phase, 'after_eod');
  const weekend = getWorkdayStatus(config, new Date('2026-09-12T10:00:00.000Z'));
  assert.equal(weekend.state, 'no_boundary');
  assert.equal(weekend.phase, 'no_boundary');
  assert.equal(weekend.localDate, '2026-09-12');
});

test('assesses all exact schedule boundaries', () => {
  const status = getWorkdayStatus(config, new Date('2026-09-10T14:30:00.000Z'));
  assert.equal(assessWork(status, { minMinutes: 30, maxMinutes: 30, kind: 'implementation' }).state, 'fits_before_wrap_up');
  assert.equal(assessWork(status, { minMinutes: 30, maxMinutes: 31, kind: 'implementation' }).state, 'may_fit');
  const wrapUp = assessWork(status, { minMinutes: 31, maxMinutes: 60, kind: 'verification' });
  assert.equal(wrapUp.state, 'uses_wrap_up');
  assert.equal('mayProceed' in wrapUp, false);
  assert.equal(assessWork(status, { minMinutes: 31, maxMinutes: 61, kind: 'implementation' }).state, 'exceeds_eod');
});

test('makes zero and negative estimates deterministic', () => {
  const status = getWorkdayStatus(config, new Date('2026-09-10T14:30:00.000Z'));
  assert.equal(assessWork(status, { minMinutes: 0, maxMinutes: 0, kind: 'research' }).state, 'fits_before_wrap_up');
  assert.throws(() => assessWork(status, { minMinutes: -1, maxMinutes: 0, kind: 'research' }), /estimate/);
});

test('rejects unsupported overnight and invalid schedule configuration', () => {
  assert.throws(() => validateConfiguration({ ...config, endOfDay: '00:00' }), /overnight/);
  assert.throws(() => validateConfiguration({ ...config, timezone: 'nope' }), /timezone/);
  assert.throws(() => validateConfiguration({ ...config, unknown: true }), /unknown/);
});

test('accepts UTC as an IANA timezone and rejects invalid timezone identifiers', () => {
  assert.doesNotThrow(() => validateConfiguration({ ...config, timezone: 'UTC' }));
  assert.throws(() => validateConfiguration({ ...config, timezone: 'Mars/Olympus' }), /timezone/);
});

test('prioritizes exceeding end of day over a range that begins before wrap-up', () => {
  const status = getWorkdayStatus(config, new Date('2026-09-10T14:30:00.000Z'));
  assert.equal(assessWork(status, { minMinutes: 1, maxMinutes: 61, kind: 'implementation' }).state, 'exceeds_eod');
});

test('floors remaining whole minutes at a second before wrap-up', () => {
  const status = getWorkdayStatus({ ...config, timezone: 'UTC' }, new Date('2026-09-10T16:59:59.000Z'));
  assert.equal(status.remainingToWrapUp, 0);
  assert.notEqual(assessWork(status, { minMinutes: 1, maxMinutes: 1, kind: 'implementation' }).state, 'fits_before_wrap_up');
});
