import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../..', import.meta.url).pathname;
const jsonFiles = ['package.json', 'schemas/workday-aware.schema.json'];
for (const file of jsonFiles) {
  const content = readFileSync(join(root, file), 'utf8');
  const formatted = `${JSON.stringify(JSON.parse(content), null, 2)}\n`;
  if (content !== formatted) throw new Error(`${file} is not formatted with two-space JSON indentation`);
}

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    return entry.isDirectory() && !['.git', 'node_modules'].includes(entry.name) ? markdownFiles(file) : entry.name.endsWith('.md') ? [file] : [];
  });
}
for (const file of markdownFiles(root)) {
  if (/[ \t]+$/m.test(readFileSync(file, 'utf8'))) throw new Error(`${file} has trailing whitespace`);
}
