import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkdayStatusPresentation, formatWorkdayStatus } from '../../extensions/status-presentation.mjs';

// Minimal stand-ins for pi-tui helpers so these tests need no Pi installation.
const ANSI = /\x1b\[[0-9;]*m/y;
function tokens(text) {
  const result = [];
  for (let index = 0; index < text.length;) {
    ANSI.lastIndex = index;
    const match = ANSI.exec(text);
    if (match) { result.push({ text: match[0], width: 0 }); index += match[0].length; continue; }
    const [char] = text.slice(index);
    result.push({ text: char, width: 1 });
    index += char.length;
  }
  return result;
}
const visibleWidth = (text) => tokens(text).reduce((sum, token) => sum + token.width, 0);
function truncateToWidth(text, max) {
  if (visibleWidth(text) <= max) return text;
  let out = '';
  let used = 0;
  for (const token of tokens(text)) {
    if (used + token.width > Math.max(0, max - 1)) break;
    out += token.text;
    used += token.width;
  }
  return `${out}\x1b[0m…`;
}
function wrapTextWithAnsi(text, width) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const candidate = line ? `${line} ${word}` : word;
      if (visibleWidth(candidate) <= width) { line = candidate; continue; }
      if (line) lines.push(line);
      line = '';
      for (const token of tokens(word)) {
        if (visibleWidth(line) + token.width > width) { lines.push(line); line = ''; }
        line += token.text;
      }
    }
    lines.push(line);
  }
  return lines;
}

const COLORS = { text: 1, success: 2, warning: 3, muted: 4 };
const makeTheme = (base = 30) => ({
  fg: (color, text) => `\x1b[${base + COLORS[color]}m${text}\x1b[39m`,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
});
const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');

const presentation = createWorkdayStatusPresentation({ visibleWidth, truncateToWidth, wrapTextWithAnsi });
const base = {
  timezone: 'Europe/Berlin', localDate: '2026-05-04', localTime: '16:00', endOfDay: '17:30', wrapUp: '17:00',
  meaningfulWorkMinutes: 15, source: 'global', warnings: [],
};
const STATUSES = {
  before: { ...base, state: 'workday', phase: 'before_wrap_up', remainingToWrapUp: 60, remainingToEndOfDay: 90 },
  wrap: { ...base, state: 'workday', phase: 'wrap_up', localTime: '17:10', remainingToWrapUp: 0, remainingToEndOfDay: 20 },
  after: { ...base, state: 'after_eod', phase: 'after_eod', localTime: '18:00', remainingToWrapUp: 0, remainingToEndOfDay: 0 },
  none: { timezone: 'UTC', localDate: '2026-05-04', localTime: '09:00', state: 'no_boundary', phase: 'no_boundary', source: 'defaults', meaningfulWorkMinutes: 15, warnings: [] },
};
const message = (status) => ({ customType: 'workday-status', content: 'x', details: { status } });
const render = (status, width = 80, options = {}, theme = makeTheme()) => presentation.renderMessage(message(status), options, theme).render(width);

test('formatWorkdayStatus gives plain wording per phase', () => {
  assert.equal(formatWorkdayStatus(STATUSES.before), 'Wrap-up in 1h · End of day at 17:30');
  assert.equal(formatWorkdayStatus(STATUSES.wrap), 'Wrap-up · 20m until 17:30');
  assert.equal(formatWorkdayStatus(STATUSES.after), 'After hours · Ended at 17:30');
  assert.equal(formatWorkdayStatus(STATUSES.none), 'No workday boundary today');
  assert.equal(formatWorkdayStatus(undefined), 'Workday status is unavailable.');
});

test('plain summary formats mixed durations and uses status times', () => {
  const status = { ...STATUSES.before, wrapUp: '16:15', endOfDay: '16:45', remainingToWrapUp: 135 };
  assert.equal(formatWorkdayStatus(status), 'Wrap-up in 2h 15m · End of day at 16:45');
});

test('messages render heading and body per phase with semantic colors', () => {
  const before = render(STATUSES.before);
  assert.deepEqual(before.map(strip), ['Wrap-up in 1h · End of day at 17:30']);
  assert.match(before[0], /^\x1b\[32m\x1b\[1mWrap-up/);
  const wrap = render(STATUSES.wrap);
  assert.deepEqual(wrap.map(strip), ['Wrap-up · 20m until 17:30']);
  assert.match(wrap[0], /^\x1b\[33m\x1b\[1m/);
  const after = render(STATUSES.after);
  assert.deepEqual(after.map(strip), ['After hours · Ended at 17:30']);
  assert.match(after[0], /^\x1b\[33m\x1b\[1m/);
  const none = render(STATUSES.none);
  assert.deepEqual(none.map(strip), ['No workday boundary today']);
  assert.match(none[0], /^\x1b\[34m\x1b\[1m/);
});

test('unavailable status renders a warning', () => {
  const lines = render(undefined);
  assert.deepEqual(lines.map(strip), ['Workday status is unavailable.']);
  assert.match(lines[0], /^\x1b\[33m/);
});

test('the summary stays on one bold line without approval boilerplate', () => {
  for (const status of [STATUSES.before, STATUSES.wrap, STATUSES.after]) {
    const lines = render(status);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\x1b\[1m/);
    assert.ok(!lines[0].includes('\x1b[34m'));
    assert.doesNotMatch(strip(lines[0]), /approval|substantial work/);
  }
});

test('messages never include instructions or model policy', () => {
  for (const expanded of [false, true]) {
    for (const status of Object.values(STATUSES)) {
      const text = strip(render(status, 200, { expanded }).join('\n'));
      assert.doesNotMatch(text, /workday_assess|Current Workday status|pessimistic|call /i);
    }
  }
});

test('expanded messages add only muted details', () => {
  const compact = render(STATUSES.before);
  const expanded = render(STATUSES.before, 200, { expanded: true });
  assert.deepEqual(expanded.slice(0, compact.length), compact);
  const extra = expanded.slice(compact.length).filter((line) => line !== '');
  assert.ok(extra.length > 0);
  for (const line of extra) assert.match(line, /^\x1b\[34m/);
  const text = strip(extra.join('\n'));
  for (const part of ['Europe/Berlin', '2026-05-04', '16:00', 'global', '15m']) assert.ok(text.includes(part), part);
  assert.doesNotMatch(text, /\bwarnings?\b/i);
});

test('status text has terminal controls stripped', () => {
  const status = { ...STATUSES.before, wrapUp: '17:00\x1b[2J\x07', endOfDay: '17:30\x9b31m\n', timezone: 'Zone\x1b]0;x\x07' };
  const lines = render(status, 200, { expanded: true });
  assert.doesNotMatch(lines.join('\n').replace(/\x1b\[[0-9;]*m/g, ''), /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  assert.doesNotMatch(formatWorkdayStatus(status), /[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
});

test('narrow widths wrap, keep styling per line, and never exceed width', () => {
  for (const width of [1, 2, 5, 10, 20, 33]) {
    const lines = render(STATUSES.wrap, width, { expanded: true }, makeTheme());
    assert.ok(lines.length > 0);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
  }
  const wrapped = render(STATUSES.wrap, 20);
  assert.ok(wrapped.length > 1);
  assert.equal(strip(wrapped.join(' ')).replace(/\s+/g, ' '), 'Wrap-up · 20m until 17:30');
});

test('outputPad indents when there is room and is ignored when narrow', () => {
  const padded = presentation.renderMessage(message(STATUSES.after), { outputPad: 2 }, makeTheme()).render(40);
  assert.ok(padded.every((line) => strip(line).startsWith('  ')));
  const tight = presentation.renderMessage(message(STATUSES.after), { outputPad: 10 }, makeTheme()).render(12);
  assert.ok(tight.every((line) => visibleWidth(line) <= 12 && !strip(line).startsWith(' ')));
  const odd = presentation.renderMessage(message(STATUSES.after), { outputPad: -3 }, makeTheme()).render(40);
  assert.ok(odd.every((line) => !strip(line).startsWith(' ')));
});

test('invalid widths render nothing and invalidate is safe', () => {
  const component = presentation.renderMessage(message(STATUSES.after), {}, makeTheme());
  for (const width of [0, -1, NaN, Infinity, undefined]) assert.deepEqual(component.render(width), []);
  assert.equal(component.invalidate(), undefined);
  assert.equal(presentation.renderWidget(STATUSES.after, makeTheme()).render(0).length, 0);
});

test('theme changes apply on the next render', () => {
  const theme = makeTheme(30);
  const component = presentation.renderMessage(message(STATUSES.after), {}, theme);
  const first = component.render(80);
  const next = makeTheme(90);
  const second = presentation.renderMessage(message(STATUSES.after), {}, next).render(80);
  assert.notEqual(first[0], second[0]);
  theme.fg = next.fg;
  component.invalidate();
  assert.deepEqual(component.render(80), second);
});

test('renderer failures are not swallowed', () => {
  const broken = { fg() { throw new Error('theme failed'); }, bold: (t) => t };
  assert.throws(() => presentation.renderMessage(message(STATUSES.after), {}, broken).render(80), /theme failed/);
});

test('widget shows a compact warning only during wrap-up and after end of day', () => {
  const theme = makeTheme();
  const after = presentation.renderWidget(STATUSES.after, theme).render(80);
  assert.deepEqual(after.map(strip), ['After hours']);
  assert.match(after[0], /^\x1b\[33m\x1b\[1m/);
  const wrap = presentation.renderWidget(STATUSES.wrap, theme).render(80);
  assert.deepEqual(wrap.map(strip), ['Wrap-up · 20m left']);
  for (const status of [STATUSES.before, STATUSES.none, undefined]) {
    assert.deepEqual(presentation.renderWidget(status, theme).render(80), []);
  }
});

test('widget wraps when narrow and stays within width', () => {
  const lines = presentation.renderWidget(STATUSES.after, makeTheme()).render(5);
  assert.ok(lines.length > 1);
  for (const line of lines) assert.ok(visibleWidth(line) <= 5);
  // Per-line style re-emission belongs to the injected real wrapper (covered by parent smoke tests).
  assert.match(lines[0], /^\x1b\[33m/);
  assert.equal(strip(lines.join(' ')), 'After hours');
});
