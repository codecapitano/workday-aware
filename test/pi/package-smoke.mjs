import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
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
const context = {
  cwd: process.cwd(),
  hasUI: false,
  mode: 'print',
  ui: {
    notify(message, type) { notifications.push({ message, type }); },
    setStatus(key, text) { statuses.push({ key, text }); },
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

const uiContext = { ...context, hasUI: true, mode: 'tui' };
await extension.commands.get('workday').handler('', uiContext);
assert.equal(notifications.at(-1).type, 'info');
assert.match(notifications.at(-1).message, /Current Workday status/);

await extension.handlers.get('session_start')[0]({ type: 'session_start', reason: 'startup' }, uiContext);
assert.equal(statuses.at(-1).key, 'workday-aware');
assert.match(statuses.at(-1).text, /^Workday:/);
await extension.handlers.get('session_shutdown')[0]({ type: 'session_shutdown', reason: 'quit' }, uiContext);
assert.deepEqual(statuses.at(-1), { key: 'workday-aware', text: undefined });

console.log('Pi package smoke test passed');
