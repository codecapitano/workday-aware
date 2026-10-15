import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkdayAssessPresentation } from '../../extensions/presentation.mjs';
import { assessStatus } from '../../extensions/runtime.mjs';

// Minimal stand-ins for pi-tui helpers so these tests need no Pi installation.
const ANSI = /\x1b\[[0-9;]*m/y;
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]|\p{Extended_Pictographic}/u;

function tokens(text) {
  const result = [];
  for (let index = 0; index < text.length;) {
    ANSI.lastIndex = index;
    const match = ANSI.exec(text);
    if (match) {
      result.push({ text: match[0], width: 0 });
      index += match[0].length;
      continue;
    }
    const end = text.slice(index).search(/\x1b\[/);
    const chunk = end === -1 ? text.slice(index) : text.slice(index, index + end);
    for (const { segment } of segmenter.segment(chunk)) result.push({ text: segment, width: /^\p{M}+$/u.test(segment) ? 0 : WIDE.test(segment) ? 2 : 1 });
    index += chunk.length;
  }
  return result;
}
const visibleWidth = (text) => tokens(text).reduce((sum, token) => sum + token.width, 0);
function truncateToWidth(text, max, ellipsis = '…') {
  if (visibleWidth(text) <= max) return text;
  const room = Math.max(0, max - visibleWidth(ellipsis));
  let out = '';
  let used = 0;
  for (const token of tokens(text)) {
    if (used + token.width > room) break;
    out += token.text;
    used += token.width;
  }
  return `${out}\x1b[0m${max >= visibleWidth(ellipsis) ? ellipsis : ''}`;
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

const codes = { success: 32, warning: 33, error: 31, muted: 90, dim: 2, accent: 36, text: 39 };
const theme = {
  fg: (color, text) => `\x1b[${codes[color] ?? 0}m${text}\x1b[39m`,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
};
const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');
const presentation = createWorkdayAssessPresentation({ visibleWidth, truncateToWidth, wrapTextWithAnsi });

const schedule = {
  localDate: '2026-09-10', localTime: '16:30', timezone: 'Europe/Berlin', wrapUp: '17:00', endOfDay: '17:30',
  remainingToWrapUp: 30, remainingToEndOfDay: 60, meaningfulWorkMinutes: 15, source: 'global', warnings: [], state: 'workday', phase: 'before_wrap_up',
};
function completed(status, input, options = {}) {
  const result = assessStatus(status, { kind: 'research', ...input });
  const args = { minimumMinutes: input.minMinutes, maximumMinutes: input.maxMinutes, kind: 'research' };
  const context = { args, isPartial: false, isError: false, expanded: false, outputPad: 0, ...options.context };
  return presentation.renderResult({ content: [{ type: 'text', text: result.text }], details: { status, assessment: result.assessment } }, { expanded: Boolean(options.expanded), isPartial: false }, theme, context);
}
const render = (component, width = 80) => component.render(width);

test('renders an optional task label on completed and pending assessments', () => {
  const status = { ...schedule, state: 'after_eod', phase: 'after_eod', remainingToWrapUp: 0, remainingToEndOfDay: 0 };
  const result = { content: [{ type: 'text', text: 'result' }], details: { status, assessment: { state: 'after_eod' }, task: 'Investigate Workday UX' } };
  const lines = render(presentation.renderResult(result, {}, theme, { args: { minimumMinutes: 15, maximumMinutes: 25, task: 'fallback task' } }));
  assert.deepEqual(lines.map(strip), ['Investigate Workday UX', '', '15–25 minutes · After hours · End of day at 17:30']);
  assert.match(lines[0], /^\x1b\[31m\x1b\[1m/);
  assert.match(lines[2], /\x1b\[1m15–25 minutes\x1b\[22m/);
  const pending = render(presentation.renderCall({ minimumMinutes: 15, maximumMinutes: 25, task: 'Investigate Workday UX' }, theme, { args: { task: 'Investigate Workday UX' }, isPartial: true }));
  assert.deepEqual(pending.map(strip), ['Investigate Workday UX', '', '15–25 minutes · Assessing…']);
});

test('named task assessments show the effective project wrap-up clock', () => {
  const status = { ...schedule, source: 'project', timezone: 'America/New_York', wrapUp: '15:45', endOfDay: '16:30', remainingToWrapUp: 60, remainingToEndOfDay: 105 };
  const component = completed(status, { minMinutes: 25, maxMinutes: 50 }, { context: { args: { minimumMinutes: 25, maximumMinutes: 50, task: 'Discoverable terminal directory option' } } });
  const lines = plainOf(component);
  assert.deepEqual(lines, ['Discoverable terminal directory option', '', '25–50 minutes · Fits before wrap-up at 15:45']);
  for (const width of [80, 40, 24, 12]) {
    const wrapped = render(component, width);
    assert.ok(wrapped.every((line) => visibleWidth(line) <= width));
    assert.match(flat(wrapped.map(strip)), /Fits before wrap-up at 15:45/);
  }
});

test('uses the task name from call arguments when result metadata has no label', () => {
  const result = assessStatus(schedule, { minMinutes: 10, kind: 'research' });
  const value = { content: [{ type: 'text', text: result.text }], details: { status: schedule, assessment: result.assessment } };
  const lines = plainOf(presentation.renderResult(value, { expanded: true }, theme, { args: { minimumMinutes: 10, task: 'Check the installation' } }));
  assert.equal(lines[0], 'Check the installation');
  assert.match(lines.join(' '), /10 minutes · Fits before wrap-up/);
  assert.doesNotMatch(lines.join(' '), /Estimated work:|You have/);
  assert.match(lines.join(' '), /Kind: research/);
  assert.match(lines.join(' '), /Timezone: Europe\/Berlin/);
  assert.doesNotMatch(lines.join(' '), /Your decision needed/);
});

test('named task assessments show the relevant boundary without countdowns or the decision question', () => {
  for (const [minimum, maximum, state, verdict] of [
    [20, 40, 'may_fit', 'May cross wrap-up at 17:00'],
    [40, 50, 'uses_wrap_up', 'Uses wrap-up from 17:00'],
    [40, 90, 'exceeds_eod', 'Exceeds end of day at 17:30'],
  ]) {
    const result = assessStatus(schedule, { minMinutes: minimum, maxMinutes: maximum, kind: 'research' });
    assert.equal(result.assessment.state, state);
    const value = { content: [{ type: 'text', text: result.text }], details: { status: schedule, assessment: result.assessment, task: 'Investigate UX' } };
    const lines = render(presentation.renderResult(value, {}, theme, { args: { minimumMinutes: minimum, maximumMinutes: maximum } }));
    assert.equal(strip(lines[0]), 'Investigate UX');
    assert.ok(lines[0].startsWith(state === 'exceeds_eod' ? '\x1b[31m' : '\x1b[33m'));
    assert.equal(strip(lines.at(-1)), `${minimum}–${maximum} minutes · ${verdict}`);
    assert.equal(lines.length, 3);
    assert.doesNotMatch(lines.map(strip).join(' '), /Your decision needed|You have|until wrap-up|until end of day/);
  }
});

test('named task verdicts omit boundary times when unavailable or not applicable', () => {
  const labels = {
    fits_before_wrap_up: 'Fits before wrap-up', may_fit: 'May cross wrap-up', uses_wrap_up: 'Uses wrap-up',
    exceeds_eod: 'Exceeds end of day', after_eod: 'After hours', no_boundary: 'No workday boundary',
  };
  for (const [state, label] of Object.entries(labels)) {
    for (const status of [{}, { wrapUp: null, endOfDay: '' }]) {
      const result = { details: { status, assessment: { state }, task: 'Check timing' } };
      assert.deepEqual(plainOf(presentation.renderResult(result, {}, theme, { args: { minimumMinutes: 5 } })), ['Check timing', '', `5 minutes · ${label}`]);
    }
  }
  const result = { details: { status: schedule, assessment: { state: 'no_boundary' }, task: 'Check timing' } };
  assert.deepEqual(plainOf(presentation.renderResult(result, {}, theme, { args: { minimumMinutes: 5 } })), ['Check timing', '', '5 minutes · No workday boundary']);
});

test('cleans task labels and preserves fallback headings for absent, error, and unavailable tasks', () => {
  const value = { content: [{ type: 'text', text: 'ok' }], details: { status: schedule, assessment: { state: 'fits_before_wrap_up' }, task: '  alpha\n\x1b[2J beta  ' } };
  const cleaned = plainOf(presentation.renderResult(value, {}, theme, {})).join(' ');
  assert.match(cleaned, /alpha beta/);
  assert.doesNotMatch(cleaned, /\x1b|\n/);
  const blank = { ...value, details: { ...value.details, task: '  ' } };
  assert.equal(plainOf(presentation.renderResult(blank, {}, theme, {}))[0], 'Workday · Fits before wrap-up');
  const error = render(presentation.renderResult({ content: [{ type: 'text', text: 'boom' }], details: { task: 'ignore me' } }, {}, theme, { isError: true }));
  assert.equal(strip(error[0]), 'Workday · Assessment failed');
  const unavailable = { content: [{ type: 'text', text: 'unavailable' }], details: { status: 'status_unavailable', task: 'ignore me' } };
  assert.equal(strip(render(presentation.renderResult(unavailable, {}, theme, {}))[0]), 'Workday · Status unavailable');
  for (const line of render(presentation.renderResult(value, {}, theme, {}), 12)) assert.ok(visibleWidth(line) <= 12);
});

test('declares self-rendered shell', () => {
  assert.equal(presentation.renderShell, 'self');
});

const FRAME = /[╭╮╰╯│─✓✗○!]/;
const plainOf = (component, width = 80) => render(component, width).map(strip);
// Joins soft-wrapped lines back into paragraphs.
const flat = (lines) => lines.join('\n').replace(/\n(?!\n)/g, ' ');

test('renders plain prose with a bold colored heading for work that fits', () => {
  const lines = render(completed({ ...schedule, remainingToWrapUp: 42 }, { minMinutes: 20, maxMinutes: 40 }));
  const plain = lines.map(strip);
  assert.deepEqual(plain, [
    'Workday · Fits before wrap-up',
    '',
    'Estimated work: 20–40 minutes. You have 42 minutes until wrap-up at 17:00.',
  ]);
  assert.equal(lines[0], '\x1b[32m\x1b[1mWorkday · Fits before wrap-up\x1b[22m\x1b[39m');
  assert.match(lines[2], /\x1b\[1m20–40 minutes\x1b\[22m/);
  assert.match(lines[2], /\x1b\[1m42 minutes\x1b\[22m/);
  assert.doesNotMatch(lines[2], /\x1b\[1mEstimated/);
  assert.doesNotMatch(plain.join('\n'), FRAME);
  assert.doesNotMatch(plain.join('\n'), /Your decision needed|Europe\/Berlin|research|Estimate\s{2}/);
});

test('maps assessment states to heading colors, wording and decisions', () => {
  const eod = { ...schedule, state: 'after_eod', phase: 'after_eod', remainingToWrapUp: 0, remainingToEndOfDay: 0 };
  const none = { ...schedule, state: 'no_boundary', phase: 'no_boundary' };
  const cases = [
    [schedule, { minMinutes: 10, maxMinutes: 20 }, 32, 'Fits before wrap-up', null],
    [schedule, { minMinutes: 20, maxMinutes: 40 }, 33, 'May cross wrap-up', 'Reduce the scope or approve working into wrap-up.'],
    [schedule, { minMinutes: 40, maxMinutes: 50 }, 33, 'Uses wrap-up', 'Reduce the scope or approve working into wrap-up.'],
    [schedule, { minMinutes: 40, maxMinutes: 90 }, 31, 'Exceeds end of day', 'Reduce the scope or approve working past end of day.'],
    [eod, { minMinutes: 15 }, 31, 'Past end of day', 'Approve this task to work past end of day.'],
    [none, { minMinutes: 15 }, 90, 'No workday boundary', null],
  ];
  for (const [status, input, color, label, guidance] of cases) {
    const lines = render(completed(status, input));
    assert.ok(lines[0].startsWith(`\x1b[${color}m\x1b[1mWorkday · ${label}`), `${label} heading`);
    const plain = lines.map(strip);
    assert.equal(plain[1], '');
    if (guidance) {
      assert.equal(plain.at(-2), '');
      assert.equal(plain.at(-1), `Your decision needed. ${guidance}`);
      assert.match(lines.at(-1), /^\x1b\[1mYour decision needed\.\x1b\[22m /);
    } else {
      assert.doesNotMatch(plain.join('\n'), /Your decision needed/);
    }
    assert.doesNotMatch(plain.join('\n'), FRAME);
  }
});

test('includes end-of-day timing for cautions and later phases', () => {
  const amber = flat(plainOf(completed(schedule, { minMinutes: 20, maxMinutes: 40 })));
  assert.match(amber, /Estimated work: 20–40 minutes\. You have 30 minutes until wrap-up at 17:00 and 1 hour until end of day at 17:30\./);
  const wrapUp = flat(plainOf(completed({ ...schedule, phase: 'wrap_up', remainingToWrapUp: 0, remainingToEndOfDay: 20 }, { minMinutes: 5, maxMinutes: 10 })));
  assert.match(wrapUp, /Wrap-up started at 17:00\. You have 20 minutes until end of day at 17:30\./);
  const after = flat(plainOf(completed({ ...schedule, state: 'after_eod', phase: 'after_eod', remainingToWrapUp: 0, remainingToEndOfDay: 0 }, { minMinutes: 5 })));
  assert.match(after, /Estimated work: 5 minutes\. End of day passed at 17:30\./);
  const none = plainOf(completed({ ...schedule, state: 'no_boundary', phase: 'no_boundary' }, { minMinutes: 1 })).join('\n');
  assert.match(none, /Estimated work: 1 minute\.$/);
  assert.doesNotMatch(none, /You have|passed/);
});

test('formats estimates and remaining time in plain minutes and hours', () => {
  const text = (status, input) => flat(plainOf(completed(status, input)));
  assert.match(text({ ...schedule, remainingToWrapUp: 90, remainingToEndOfDay: 120 }, { minMinutes: 40, maxMinutes: 60 }), /Estimated work: 40–60 minutes\. You have 1 hour 30 minutes until wrap-up at 17:00\./);
  assert.match(text({ ...schedule, remainingToWrapUp: 30, remainingToEndOfDay: 120 }, { minMinutes: 40, maxMinutes: 50 }), /until wrap-up at 17:00 and 2 hours until end of day at 17:30\./);
  assert.match(text(schedule, { minMinutes: 15, maxMinutes: 90 }), /Estimated work: 15–90 minutes\./);
  assert.match(text({ ...schedule, remainingToWrapUp: 1 }, { minMinutes: 15 }), /Estimated work: 15 minutes\. You have 1 minute until wrap-up/);
});

test('shows a pending heading only while the call is partial and keeps completed calls empty', () => {
  const args = { minimumMinutes: 15, maximumMinutes: 90, kind: 'implementation' };
  const pending = render(presentation.renderCall(args, theme, { args, isPartial: true, expanded: false, outputPad: 0 }));
  assert.deepEqual(pending.map(strip), ['Workday · Assessing…', '', 'Estimated work: 15–90 minutes.']);
  assert.ok(pending[0].startsWith('\x1b[90m\x1b[1m'));
  const expanded = plainOf(presentation.renderCall(args, theme, { args, isPartial: true, expanded: true })).join('\n');
  assert.match(expanded, /Kind: implementation/);
  assert.deepEqual(render(presentation.renderCall(args, theme, { args, isPartial: false })), []);
  const incomplete = plainOf(presentation.renderCall({}, theme, { args: {}, isPartial: true }));
  assert.equal(incomplete[0], 'Workday · Assessing…');
  assert.doesNotMatch(incomplete.join('\n'), /Estimate|undefined|NaN/);
});

test('renders no duplicate output for partial results', () => {
  const result = { content: [{ type: 'text', text: 'x' }], details: undefined };
  assert.deepEqual(render(presentation.renderResult(result, { expanded: false, isPartial: true }, theme, { isPartial: true })), []);
  assert.deepEqual(render(presentation.renderResult(result, { expanded: false, isPartial: false }, theme, { isPartial: true })), []);
});

test('reveals technical details, timezone, kind and model text only when expanded', () => {
  const collapsed = plainOf(completed(schedule, { minMinutes: 20, maxMinutes: 40 })).join('\n');
  assert.doesNotMatch(collapsed, /Europe\/Berlin|research|before_wrap_up|Timezone|Kind/);
  const expanded = flat(plainOf(completed(schedule, { minMinutes: 20, maxMinutes: 40 }, { expanded: true })));
  assert.match(expanded, /Kind: research/);
  assert.match(expanded, /Timezone: Europe\/Berlin/);
  assert.match(expanded, /Local time: 2026-09-10 16:30/);
  assert.match(expanded, /Phase: before_wrap_up/);
  assert.match(expanded, /pause; propose a smaller slice/);
  assert.doesNotMatch(expanded, FRAME);
});

test('renders the unavailable fallback in warning color with preserved text and no pause', () => {
  const result = { content: [{ type: 'text', text: 'Workday status is unavailable.' }], details: { status: 'status_unavailable' } };
  const args = { minimumMinutes: 30, kind: 'cleanup' };
  const collapsed = render(presentation.renderResult(result, { expanded: false, isPartial: false }, theme, { args }));
  assert.ok(collapsed[0].startsWith('\x1b[33m\x1b[1mWorkday · Status unavailable'));
  const lines = render(presentation.renderResult(result, { expanded: true, isPartial: false }, theme, { args }));
  const plain = lines.map(strip).join('\n');
  assert.match(plain, /Estimated work: 30 minutes\./);
  assert.doesNotMatch(plain, /Your decision needed|confirm|pause/);
  assert.match(plain, /Workday status is unavailable\./);
});

test('falls back safely for legacy, malformed and error results while preserving text', () => {
  const text = 'Workday 16:30; estimate 15m; fits before wrap-up; proceed';
  for (const details of [undefined, null, {}, { status: 'x' }, { assessment: { state: 'bogus' }, status: {} }, { assessment: { state: 'may_fit' } }]) {
    const lines = render(presentation.renderResult({ content: [{ type: 'text', text }], details }, { expanded: false, isPartial: false }, theme, { args: undefined }), 200);
    assert.ok(lines.map(strip).join('\n').includes(text), JSON.stringify(details));
  }
  const failure = render(presentation.renderResult({ content: [{ type: 'text', text: 'boom' }], details: undefined }, { expanded: false, isPartial: false }, theme, { isError: true }));
  assert.ok(failure[0].startsWith('\x1b[31m\x1b[1m'));
  assert.deepEqual(failure.map(strip), ['Workday · Assessment failed', '', 'boom']);
  assert.doesNotThrow(() => render(presentation.renderResult(undefined, { expanded: true, isPartial: false }, theme, undefined)));
  assert.doesNotThrow(() => render(presentation.renderResult({ content: 'bad', details: { assessment: { state: 'fits_before_wrap_up' }, status: {} } }, { expanded: true }, theme, {})));
});

test('degrades legacy partial status without NaN or undefined', () => {
  const result = { content: [{ type: 'text', text: 'legacy' }], details: { assessment: { state: 'may_fit', kind: 'research' }, status: { phase: 'before_wrap_up' } } };
  const plain = plainOf(presentation.renderResult(result, { expanded: true, isPartial: false }, theme, {})).join('\n');
  assert.doesNotMatch(plain, /undefined|NaN|null/);
  assert.match(plain, /May cross wrap-up/);
});

test('derives wrap-up wording from the phase, not from equal remaining values', () => {
  const equal = { ...schedule, phase: 'wrap_up', remainingToWrapUp: 0, remainingToEndOfDay: 0 };
  const plain = flat(plainOf(completed(equal, { minMinutes: 5 })));
  assert.match(plain, /Wrap-up started at 17:00\. You have 0 minutes until end of day at 17:30\./);
  const before = plainOf(completed({ ...schedule, remainingToWrapUp: 60, remainingToEndOfDay: 60 }, { minMinutes: 5 })).join('\n');
  assert.match(before, /You have 1 hour until wrap-up at 17:00\./);
});

test('strips terminal control sequences from untrusted text', () => {
  const result = { content: [{ type: 'text', text: 'ok\x1b[2J\x07 text' }], details: undefined };
  const lines = render(presentation.renderResult(result, { expanded: false, isPartial: false }, theme, {}));
  assert.ok(!lines.join('\n').includes('\x1b[2J'));
  assert.ok(!lines.join('').includes('\x07'));
});

test('wraps prose to the width, capped near 80 columns, at every size', () => {
  const unicode = '東京📅 e\u0301 ' + 'ß'.repeat(30) + ' Zeitzone Ünïcode 日本語のとても長いテキスト';
  const cases = [
    completed(schedule, { minMinutes: 20, maxMinutes: 90 }, { expanded: true }),
    completed({ ...schedule, timezone: unicode }, { minMinutes: 20, maxMinutes: 40 }, { expanded: true }),
    presentation.renderResult({ content: [{ type: 'text', text: unicode }], details: undefined }, { expanded: false, isPartial: false }, theme, {}),
    presentation.renderCall({ minimumMinutes: 1, kind: 'research' }, theme, { isPartial: true, expanded: true }),
  ];
  for (const component of cases) {
    for (const width of [200, 100, 80, 64, 40, 30, 24, 20, 12, 9, 8, 7, 5, 3, 2, 1]) {
      for (const line of render(component, width)) assert.ok(visibleWidth(line) <= Math.min(width, 80), `width ${width}: ${JSON.stringify(strip(line))}`);
    }
    assert.deepEqual(render(component, 0), []);
    assert.deepEqual(render(component, -5), []);
    assert.deepEqual(render(component, Number.NaN), []);
    assert.deepEqual(render(component, 50), render(component, 50));
  }
  const wrapped = render(completed(schedule, { minMinutes: 20, maxMinutes: 40 }), 30);
  assert.ok(wrapped.length > 4);
});

test('applies Pi output padding inside the available width', () => {
  const lines = render(completed(schedule, { minMinutes: 10 }, { context: { outputPad: 2 } }), 40).filter((line) => strip(line));
  assert.ok(lines.every((line) => strip(line).startsWith('  ') && !strip(line).startsWith('   ') && visibleWidth(line) <= 38));
  const wide = render(completed(schedule, { minMinutes: 10 }, { context: { outputPad: 2 } }), 200).filter((line) => strip(line));
  assert.ok(wide.every((line) => visibleWidth(line) <= 82));
  const tiny = render(completed(schedule, { minMinutes: 10 }, { context: { outputPad: 4 } }), 10);
  assert.ok(tiny.every((line) => visibleWidth(line) <= 10));
});

test('recolors from the supplied theme on every render without cached ANSI', () => {
  const result = assessStatus(schedule, { minMinutes: 10, kind: 'research' });
  const value = { content: [{ type: 'text', text: result.text }], details: { status: schedule, assessment: result.assessment } };
  const component = presentation.renderResult(value, { expanded: false, isPartial: false }, theme, { args: { minimumMinutes: 10 } });
  const before = render(component);
  const other = { fg: (color, text) => `<${color}>${text}</${color}>`, bold: (text) => `<b>${text}</b>` };
  const themed = presentation.renderResult(value, { expanded: false, isPartial: false }, other, { args: { minimumMinutes: 10 } });
  assert.equal(render(themed)[0], '<success><b>Workday · Fits before wrap-up</b></success>');
  assert.ok(before[0].startsWith('\x1b[32m'));
  component.invalidate();
  assert.deepEqual(render(component), before);
});
