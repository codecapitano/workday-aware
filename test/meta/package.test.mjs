import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (file) => readFileSync(join(root, file), 'utf8');

test('skill frontmatter and OpenAI metadata are complete', () => {
  const skill = read('skills/workday-aware/SKILL.md');
  assert.match(skill, /^---\nname: workday-aware\ndescription: .+\n---/);
  for (const reference of ['configuration.md', 'compatibility.md', 'lifecycle.md']) {
    assert.ok(existsSync(join(root, 'skills/workday-aware/references', reference)), `missing installed skill reference ${reference}`);
  }
  const metadata = read('skills/workday-aware/agents/openai.yaml');
  assert.match(metadata, /allow_implicit_invocation: true/);
  assert.doesNotMatch(metadata, /mcp|dependenc/i);
});

test('essential documentation exists and is linked', () => {
  for (const file of ['docs/configuration.md', 'SECURITY.md', 'CONTRIBUTING.md', 'LICENSE']) {
    assert.ok(existsSync(join(root, file)), `missing ${file}`);
  }
  const readme = read('README.md');
  for (const link of ['docs/configuration.md', 'SECURITY.md', 'CONTRIBUTING.md', 'LICENSE']) {
    assert.match(readme, new RegExp(link.replace('.', '\\.')));
  }
});

test('documented installation pins match the package version', () => {
  const { version } = JSON.parse(read('package.json'));
  const readme = read('README.md');
  assert.match(readme, new RegExp(`tree/v${version}`));
  assert.match(readme, new RegExp(`workday-aware@v${version.replaceAll('.', '\\.')}`));
  assert.doesNotMatch(readme, /(?:tree\/v1\.0\.0|@v1\.0\.0)/);
  assert.match(readme, /Native Pi integration requires Node\.js 22\.19 or later/);
  assert.match(read('docs/configuration.md'), new RegExp(`pi remove git:github\\.com/codecapitano/workday-aware@v${version.replaceAll('.', '\\.')}`));
});

test('Pi setup is adapter-free and preview and confirmation stay separate', () => {
  const skill = read('skills/workday-aware/SKILL.md');
  const configuration = read('skills/workday-aware/references/configuration.md');
  assert.match(skill, /AI_AGENT=pi/);
  assert.match(skill, /PI_CODING_AGENT=true/);
  assert.match(skill, /setup --preview` without an adapter/);
  assert.doesNotMatch(skill, /--adapter pi/);
  assert.match(skill, /Never pass `--preview` and `--confirm` together/);
  assert.match(configuration, /replace `--preview` with `--confirm`/);
  assert.match(configuration, /Never pass `--preview` and `--confirm` together/);
});

test('installation privacy, trust, and disclosure guidance match the supported distribution', () => {
  const readme = read('README.md');
  assert.match(readme, /public GitHub sources/);
  assert.match(readme, /pre-install audit/);
  assert.match(readme, /anonymous post-install usage telemetry/);
  assert.match(readme, /DISABLE_TELEMETRY=1/);
  assert.match(readme, /DO_NOT_TRACK=1/);
  assert.match(readme, /https:\/\/github\.com\/vercel-labs\/skills\/blob\/v1\.5\.25\/src\/telemetry\.ts/);
  assert.doesNotMatch(readme, /Workday Aware itself sends telemetry/);

  const userConfiguration = read('docs/configuration.md');
  assert.match(userConfiguration, /tell your agent that you approve trusting that Git root/i);
  assert.doesNotMatch(userConfiguration, /trust-project/);

  const installedConfiguration = read('skills/workday-aware/references/configuration.md');
  assert.match(installedConfiguration, /node <skill-directory>\/scripts\/setup\.mjs trust-project \/absolute\/path\/to\/repository --confirm/);

  const security = read('SECURITY.md');
  assert.match(security, /https:\/\/github\.com\/codecapitano\/workday-aware\/security\/advisories\/new/);
  assert.match(security, /requires private vulnerability reporting to be enabled/);
});

test('distribution retains the portable skill and adds an explicit Pi extension', () => {
  for (const file of ['plugin.json', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json', 'gemini-extension.json', '.cursor-plugin/plugin.json']) {
    assert.equal(existsSync(join(root, file)), false, `unexpected distribution manifest ${file}`);
  }
  assert.ok(existsSync(join(root, 'skills/workday-aware/agents/openai.yaml')));
  assert.ok(existsSync(join(root, 'skills/workday-aware/scripts/adapters.mjs')));
  assert.ok(existsSync(join(root, 'extensions/workday-aware.mjs')));
  assert.ok(existsSync(join(root, 'extensions/runtime.mjs')));
});

test('package metadata and license are correct', () => {
  const packageJson = JSON.parse(read('package.json'));
  assert.equal(packageJson.version, '1.1.0');
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.license, 'MIT');
  assert.equal(packageJson.engines.node, '>=20');
  assert.ok(packageJson.keywords.includes('pi-package'));
  assert.deepEqual(packageJson.pi, {
    extensions: ['./extensions/workday-aware.mjs'],
    skills: ['./skills/workday-aware'],
  });
  const license = read('LICENSE');
  assert.match(license, /^MIT License/m);
  assert.match(license, /Copyright \(c\) 2026 codecapitano/);
});

test('workflow uses read-only permissions and immutable action revisions', () => {
  const workflow = read('.github/workflows/test.yml');
  assert.match(workflow, /^permissions:\n  contents: read/m);
  assert.match(workflow, /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4\.4\.0/);
  assert.match(workflow, /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4\.4\.0/);
  assert.match(workflow, /npx skills@1\.5\.25 add \. --skill workday-aware --agent codex --global --yes --copy/);
  assert.match(workflow, /DISABLE_TELEMETRY: "1"/);
  assert.match(workflow, /DO_NOT_TRACK: "1"/);
});

test('package declares only the Pi-supplied TypeBox peer', () => {
  const packageJson = JSON.parse(read('package.json'));
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.devDependencies, undefined);
  assert.deepEqual(packageJson.peerDependencies, { typebox: '*' });
});
