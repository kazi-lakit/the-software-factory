import type { Check } from './checksSchema.js';

// Pure (no Node API): the wizard and the Board may use it.
const SCRIPTS = ['typecheck', 'lint', 'test', 'build'];

interface Pm { install: string; run: (s: string) => string }
function packageManager(has: (f: string) => boolean): Pm {
  if (has('package-lock.json')) return { install: 'npm ci', run: (s) => `npm run ${s}` };
  if (has('pnpm-lock.yaml')) return { install: 'pnpm i --frozen-lockfile', run: (s) => `pnpm run ${s}` };
  if (has('yarn.lock')) return { install: 'yarn --frozen-lockfile', run: (s) => `yarn ${s}` };
  return { install: 'npm install', run: (s) => `npm run ${s}` };
}

function scriptsOf(text: string | null): string[] {
  try {
    const s = (JSON.parse(text ?? '') as { scripts?: Record<string, unknown> }).scripts;
    return s && typeof s === 'object' ? SCRIPTS.filter((n) => typeof s[n] === 'string') : [];
  } catch {
    return [];
  }
}

/** The checks of one folder (`dir` '' is the repo root); `names` are its direct file names. */
async function folderChecks(dir: string, names: string[], read: (path: string) => Promise<string | null>): Promise<Check[]> {
  const has = (f: string) => names.includes(f);
  const at = (f: string) => (dir ? `${dir}/${f}` : f);
  const cwd = dir || '.';
  const name = (step: string) => (dir ? `${dir}.${step}` : step);
  const out: Check[] = [];
  const pair = (build: string, test: string) => {
    out.push({ name: name('build'), cwd, run: build }, { name: name('test'), cwd, run: test, needs: name('build') });
  };
  if (has('package.json')) {
    const pm = packageManager(has);
    const scripts = scriptsOf(await read(at('package.json')));
    // An install with nothing to run after it is not a check.
    if (scripts.length) out.push({ name: name('install'), cwd, run: pm.install });
    for (const s of scripts) out.push({ name: name(s), cwd, run: pm.run(s), needs: name('install') });
  }
  if (names.some((n) => /\.(sln|csproj)$/.test(n))) pair('dotnet build', 'dotnet test');
  if (has('go.mod')) pair('go build ./...', 'go test ./...');
  if (has('Cargo.toml')) pair('cargo build', 'cargo test');
  for (const f of names.filter((n) => n === 'pyproject.toml' || /^requirements.*\.txt$/.test(n))) {
    if ((await read(at(f)))?.includes('pytest')) { out.push({ name: name('test'), cwd, run: 'pytest' }); break; }
  }
  if (!out.length && has('Makefile') && /^test:/m.test((await read(at('Makefile'))) ?? '')) out.push({ name: name('test'), cwd, run: 'make test' });
  return out;
}

/** Checks detected from a repo's file list: the root and first-level folders only, in the order they first appear. */
export async function detectChecks(files: string[], read: (path: string) => Promise<string | null>): Promise<Check[]> {
  const root: string[] = [];
  const folders = new Map<string, string[]>();
  for (const f of files) {
    const parts = f.split('/');
    if (parts.length === 1) root.push(f);
    else if (parts.length === 2) folders.set(parts[0]!, [...(folders.get(parts[0]!) ?? []), parts[1]!]);
  }
  const out = await folderChecks('', root, read);
  for (const dir of folders.keys()) out.push(...(await folderChecks(dir, folders.get(dir)!, read)));
  return out;
}
