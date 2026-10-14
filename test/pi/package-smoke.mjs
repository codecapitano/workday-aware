import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { assessStatus } from '../../extensions/runtime.mjs';
import { getWorkdayStatus } from '../../skills/workday-aware/scripts/core.mjs';

// chalk disables bold on non-TTY output unless color is forced before Pi loads.
process.env.FORCE_COLOR = '1';

const modulePath = process.env.PI_CODING_AGENT_MODULE;
if (!modulePath) throw new Error('PI_CODING_AGENT_MODULE must point to the pinned Pi dist/index.js');

const { DefaultResourceLoader, getAgentDir } = await import(pathToFileURL(modulePath).href);
const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: getAgentDir() });
await loader.reload();

const skills = loader.getSkills();
const matchingSkills = skills.skills.filter((skill) => skill.name === 'workday-aware');
assert.equal(matchingSkills.length, 1);
assert.deepEqual(skills.diagnostics, []);

const loaded = loader.getExtensions();
assert.deepEqual(loaded.errors, []);
const matchingExtensions = loaded.extensions.filter((extension) => extension.path.replaceAll('\\', '/').endsWith('extensions/workday-aware.mjs'));
assert.equal(matchingExtensions.length, 1);
const extension = matchingExtensions[0];
assert.deepEqual([...extension.commands.keys()], ['workday']);
assert.deepEqual([...extension.tools.keys()], ['workday_assess']);

const notifications = [];
const statuses = [];
const widgets = [];
const entries = [];
loaded.runtime.appendEntry = (customType, data) => entries.push({ customType, data });
const context = {
  cwd: process.cwd(),
  hasUI: false,
  mode: 'print',
  ui: {
    notify(message, type) { notifications.push({ message, type }); },
    setStatus(key, text) { statuses.push({ key, text }); },
    setWidget(key, content, options) { widgets.push({ key, content, options }); },
  },
};
const event = { systemPromptOptions: { sections: {} } };
await extension.handlers.get('before_agent_start')[0](event, context);
assert.match(event.systemPromptOptions.sections.workday_aware, /workday_assess/);

const toolResult = await extension.tools.get('workday_assess').definition.execute(
  'smoke-test',
  { minimumMinutes: 15, maximumMinutes: 30, kind: 'research' },
  undefined,
  undefined,
  context,
);
assert.match(toolResult.content[0].text, /estimate 15m–30m/);

// Render through Pi's own pi-tui helpers and theme to exercise the plain-prose layout.
const definition = extension.tools.get('workday_assess').definition;
assert.equal(definition.renderShell, 'self');
const { visibleWidth } = await import(pathToFileURL(createRequire(modulePath).resolve('@earendil-works/pi-tui')).href);
// CI isolates PI_PACKAGE_DIR; theme assets live in the pinned Pi package, so point at it.
process.env.PI_PACKAGE_DIR = dirname(dirname(modulePath));
const { initTheme, theme } = await import(new URL('./modes/interactive/theme/theme.js', pathToFileURL(modulePath)).href);
initTheme('dark', false);
const renderArgs = { minimumMinutes: 15, maximumMinutes: 30, kind: 'research' };
// Rendering assertions use a fixed workday, independent of the host clock and schedule.
const renderStatus = getWorkdayStatus({ timezone: 'UTC' }, new Date('2026-09-10T12:00:00Z'));
const renderAssessment = assessStatus(renderStatus, { minMinutes: 15, maxMinutes: 30, kind: 'research' });
const renderResult = { content: [{ type: 'text', text: renderAssessment.text }], details: { status: renderStatus, assessment: renderAssessment.assessment } };
const renderContext = { args: renderArgs, isPartial: false, isError: false, expanded: false, outputPad: 1 };
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');
assert.deepEqual(definition.renderCall(renderArgs, theme, renderContext).render(80), []);
assert.match(stripAnsi(definition.renderCall(renderArgs, theme, { ...renderContext, isPartial: true }).render(80).join('\n')), /Workday · Assessing…/);
assert.deepEqual(definition.renderResult(renderResult, { expanded: false, isPartial: true }, theme, { ...renderContext, isPartial: true }).render(80), []);
for (const width of [80, 64, 30, 12, 6]) {
  const lines = definition.renderResult(renderResult, { expanded: true, isPartial: false }, theme, renderContext).render(width);
  assert.ok(lines.length > 0);
  for (const line of lines) assert.ok(visibleWidth(line) <= width, `rendered line exceeds ${width} columns`);
}
const rendered = definition.renderResult(renderResult, { expanded: false, isPartial: false }, theme, renderContext).render(80);
const prose = rendered.map(stripAnsi);
assert.equal(prose[0], ' Workday · Fits before wrap-up');
assert.equal(prose[1], '');
assert.match(prose[2], /^ Estimated work: 15–30 minutes\. You have \d+ (minutes?|hours?)/);
assert.doesNotMatch(prose.join('\n'), /[╭╮╰╯│─✓✗]/);
assert.doesNotMatch(prose.join('\n'), /Europe\/|research/);
// Heading is bold and colored; estimate is bold; widths respect outputPad.
assert.match(rendered[0], /\x1b\[1m/);
assert.ok(rendered[0].includes('\x1b[') && rendered[0] !== prose[0]);
assert.match(rendered[2], /\x1b\[1m15–30 minutes\x1b\[22m/);
assert.ok(rendered.every((line) => visibleWidth(line) <= 80));
// Bold must survive wrapping across lines in the real pi-tui wrapper.
const narrow = definition.renderResult(renderResult, { expanded: false, isPartial: false }, theme, { ...renderContext, outputPad: 0 }).render(24);
const estimateLine = narrow.find((line) => stripAnsi(line).includes('15–30'));
assert.ok(estimateLine && estimateLine.slice(0, estimateLine.indexOf('15–30')).includes('\x1b[1m'), 'bold styling survives wrapping');
assert.ok(narrow.every((line) => visibleWidth(line) <= 24));

// Optional task labels are UI metadata, not a change to model-facing assessment text.
const labeledResult = await definition.execute('task-smoke', { ...renderArgs, task: 'Investigate Workday UX' }, undefined, undefined, context);
assert.equal(labeledResult.details.task, 'Investigate Workday UX');
assert.equal(definition.parameters.properties.task.maxLength, 120);
const taskLines = definition.renderResult({ ...renderResult, details: { ...renderResult.details, task: 'Investigate Workday UX' } }, { expanded: false }, theme, { args: { ...renderArgs, task: 'Investigate Workday UX' } }).render(80);
assert.equal(stripAnsi(taskLines[0]), 'Investigate Workday UX');
assert.match(taskLines[0], /\x1b\[1m/);

const uiContext = { ...context, hasUI: true, mode: 'tui' };
const configHome = mkdtempSync(join(tmpdir(), 'workday-ui-smoke-'));
const savedConfigHome = process.env.WORKDAY_AWARE_CONFIG_HOME;
const RealDate = Date;
const config = { version: 1, timezone: 'UTC', workDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], endOfDay: '17:30', wrapUpMinutes: 30, meaningfulWorkMinutes: 15 };
const configPath = join(configHome, 'workday-aware.json');
process.env.WORKDAY_AWARE_CONFIG_HOME = configHome;
const at = async (instant, action) => {
  const now = new RealDate(instant).valueOf();
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  try { await action(); } finally { globalThis.Date = RealDate; }
};
const handler = (name) => extension.handlers.get(name)[0];
const statusRenderer = extension.entryRenderers.get('workday-status');
assert.equal(typeof statusRenderer, 'function');
try {
  writeFileSync(configPath, JSON.stringify(config));
  await at('2026-09-10T12:00:00Z', async () => {
    await handler('session_start')({ type: 'session_start', reason: 'startup' }, uiContext);
    assert.equal(statuses.at(-1).key, 'workday-aware');
    assert.equal(widgets.at(-1).content, undefined);
    await extension.commands.get('workday').handler('', uiContext);
    assert.equal(notifications.length, 0);
    assert.equal(entries.at(-1).customType, 'workday-status');
    const message = { customType: 'workday-status', data: entries.at(-1).data };
    const compact = statusRenderer(message, { expanded: false }, theme).render(80);
    assert.match(stripAnsi(compact[0]), /Wrap-up in.*End of day at/);
    assert.equal(compact.length, 1);
    assert.doesNotMatch(compact.map(stripAnsi).join('\n'), /workday_assess|pessimistic|threshold|Europe\//);
    assert.match(compact[0], /\x1b\[1m/);
    for (const width of [80, 30, 12, 6, 2, 1]) {
      const lines = statusRenderer(message, { expanded: true }, theme).render(width);
      assert.ok(lines.length > 0);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
    }
    const expanded = statusRenderer(message, { expanded: true }, theme).render(80).map(stripAnsi).join('\n');
    assert.match(expanded, /Timezone: UTC/);
    assert.match(expanded, /Threshold: 15m/);
    const unicodeMessage = { data: { status: { ...entries.at(-1).data.status, timezone: '東京📅 e\u0301 '.repeat(8) } } };
    for (const width of [30, 12, 6, 2, 1]) {
      const lines = statusRenderer(unicodeMessage, { expanded: true }, theme).render(width);
      assert.ok(lines.length > 0 && lines.every((line) => visibleWidth(line) <= width));
      const task = definition.renderCall({ ...renderArgs, task: '東京📅 e\u0301 '.repeat(8) }, theme, { isPartial: true }).render(width);
      assert.ok(task.length > 0 && task.every((line) => visibleWidth(line) <= width));
    }
  });
  await at('2026-09-10T17:10:00Z', async () => {
    await handler('agent_settled')({}, uiContext);
    assert.equal(notifications.length, 1);
    assert.equal(statuses.at(-1).text, undefined);
    assert.equal(widgets.at(-1).options.placement, 'aboveEditor');
    assert.equal(typeof widgets.at(-1).content, 'function');
    const banner = widgets.at(-1).content(undefined, theme);
    const lines = banner.render(20);
    assert.ok(lines.every((line) => visibleWidth(line) <= 20));
    assert.match(lines.map(stripAnsi).join(' '), /Wrap-up.*20m.*left/);
    const warningCodes = /\x1b\[([0-9;]+)m/.exec(theme.fg('warning', 'X'))[1];
    // Pi combines bold and color into one SGR sequence on wrapped continuation lines.
    const hasWarning = (line) => [...line.matchAll(/\x1b\[([0-9;]+)m/g)].some(([, codes]) => `;${codes};`.includes(`;${warningCodes};`));
    assert.ok(lines.every((line) => !stripAnsi(line).trim() || hasWarning(line)));
    assert.ok(lines.every((line) => !stripAnsi(line).trim() || /\x1b\[1(?:;|m)/.test(line)));
    await handler('agent_settled')({}, uiContext);
    assert.equal(notifications.length, 1);
  });
  await at('2026-09-10T18:00:00Z', async () => {
    await handler('agent_settled')({}, uiContext);
    assert.equal(notifications.length, 2);
    assert.equal(statuses.at(-1).text, undefined);
    const banner = widgets.at(-1).content(undefined, theme).render(5);
    assert.equal(banner.map(stripAnsi).join(' '), 'After hours');
    const warningCodes = /\x1b\[([0-9;]+)m/.exec(theme.fg('warning', 'X'))[1];
    const hasWarning = (line) => [...line.matchAll(/\x1b\[([0-9;]+)m/g)].some(([, codes]) => `;${codes};`.includes(`;${warningCodes};`));
    assert.ok(banner.every((line) => visibleWidth(line) <= 18 && (!stripAnsi(line).trim() || hasWarning(line))));
    assert.ok(banner.every((line) => !stripAnsi(line).trim() || /\x1b\[1(?:;|m)/.test(line)));
    await extension.commands.get('workday').handler('', uiContext);
    const renderedStatus = statusRenderer({ data: entries.at(-1).data }, { expanded: false }, theme).render(80);
    assert.deepEqual(renderedStatus.map(stripAnsi), ['After hours · Ended at 17:30']);
    assert.match(renderedStatus[0], /\x1b\[1m/);
    const beforeGuidance = { systemPromptOptions: { sections: {} } };
    await handler('before_agent_start')(beforeGuidance, uiContext);
    assert.match(beforeGuidance.systemPromptOptions.sections.workday_aware, /call workday_assess/);
    assert.match(beforeGuidance.systemPromptOptions.sections.workday_aware, /ask one short approval question/);
    const withLabel = await definition.execute('label', { ...renderArgs, task: 'Task label' }, undefined, undefined, uiContext);
    const withoutLabel = await definition.execute('no-label', renderArgs, undefined, undefined, uiContext);
    assert.equal(withLabel.content[0].text, withoutLabel.content[0].text);
    const entryCount = entries.length;
    const rpcContext = { ...uiContext, mode: 'rpc' };
    await extension.commands.get('workday').handler('', rpcContext);
    assert.equal(entries.length, entryCount);
    assert.equal(notifications.at(-1).type, 'warning');
    assert.match(notifications.at(-1).message, /After hours · Ended at 17:30/);
    assert.doesNotMatch(notifications.at(-1).message, /workday_assess|pessimistic/);
    assert.ok(Array.isArray(widgets.at(-1).content));
    assert.equal(statuses.at(-1).text, 'Workday: end of day passed');
    const widgetCount = widgets.length;
    await extension.commands.get('workday').handler('', context);
    assert.equal(entries.length, entryCount);
    assert.equal(widgets.length, widgetCount);
  });
  await at('2026-09-11T12:00:00Z', async () => {
    await handler('agent_settled')({}, uiContext);
    assert.equal(widgets.at(-1).content, undefined);
    assert.match(statuses.at(-1).text, /Workday:.*to wrap-up/);
  });
  writeFileSync(configPath, JSON.stringify({ ...config, workDays: ['mon'] }));
  await at('2026-09-12T18:00:00Z', async () => {
    await handler('agent_settled')({}, uiContext);
    assert.equal(widgets.at(-1).content, undefined);
    await extension.commands.get('workday').handler('', uiContext);
    assert.deepEqual(statusRenderer({ data: entries.at(-1).data }, {}, theme).render(80).map(stripAnsi), ['No workday boundary today']);
  });
  // A failed clock read exercises the unavailable path; invalid config intentionally falls back to defaults.
  writeFileSync(configPath, JSON.stringify(config));
  await at('invalid clock', async () => {
    await extension.commands.get('workday').handler('', uiContext);
    assert.equal(widgets.at(-1).content, undefined);
    assert.deepEqual(statusRenderer({ data: entries.at(-1).data }, {}, theme).render(80).map(stripAnsi), ['Workday status is unavailable.']);
  });
} finally {
  globalThis.Date = RealDate;
  if (savedConfigHome === undefined) delete process.env.WORKDAY_AWARE_CONFIG_HOME;
  else process.env.WORKDAY_AWARE_CONFIG_HOME = savedConfigHome;
  await handler('session_shutdown')({ type: 'session_shutdown', reason: 'quit' }, uiContext);
  rmSync(configHome, { recursive: true, force: true });
}
assert.deepEqual(statuses.at(-1), { key: 'workday-aware', text: undefined });
assert.equal(widgets.at(-1).content, undefined);

console.log('Pi package smoke test passed');
