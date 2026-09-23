import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

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
const matchingExtensions = loaded.extensions.filter((extension) => extension.path.endsWith('extensions/workday-aware.mjs'));
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
