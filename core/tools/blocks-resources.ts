// Writes (or with --check, verifies) the generated Blocks resource files at the factory root.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TABLES, generateFields, generateIndexes, generateRules } from '../src/blocks/schema.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const text = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export function renderFiles(): Record<string, string> {
  const files: Record<string, string> = { 'blocks/data/rules.json': text(generateRules()) };
  for (const schema of TABLES) files[`blocks/data/factory/${schema}.fields.json`] = text(generateFields(schema));
  files['blocks/data/factory/indexes.json'] = text(generateIndexes());
  return files;
}

const files = renderFiles();
if (process.argv.includes('--check')) {
  const differing = Object.entries(files).filter(([path, content]) => {
    try { return readFileSync(root + path, 'utf8') !== content; } catch { return true; }
  }).map(([path]) => path);
  for (const path of differing) console.error(`${path} differs from the generator output`);
  process.exit(differing.length ? 1 : 0);
}
for (const [path, content] of Object.entries(files)) {
  mkdirSync(dirname(root + path), { recursive: true });
  writeFileSync(root + path, content);
}
console.log(`Wrote ${Object.keys(files).length} files`);
