// Pure (no Node API): the file `factory migrate --export` writes and the Board's "Import factory" action reads.
import { validateFactoryDef, validateFactoryRepo, type FactoryDef, type FactoryRepo, type Validated } from './factories.js';

export const IMPORT_FORMAT = 'factory-import/1';

/** A factory definition and its repos, ready for the owner to import on the Board. Never holds a secret. */
export interface ImportFile {
  format: typeof IMPORT_FORMAT;
  factory: FactoryDef;
  repos: FactoryRepo[];
}

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Checks and normalises an import file (`main` is added to the protected branches). The error names the first problem. */
export function validateImportFile(json: unknown): Validated<ImportFile> {
  if (!isObject(json)) return fail('import file must be an object');
  if (json.format !== IMPORT_FORMAT) return fail(`format must be ${IMPORT_FORMAT}`);
  const def = validateFactoryDef(json.factory);
  if (!def.ok) return fail(`factory: ${def.error}`);
  if (!Array.isArray(json.repos)) return fail('repos must be a list');
  const repos: FactoryRepo[] = [];
  for (const [i, raw] of json.repos.entries()) {
    // Per-repo protected branches are local-YAML-only in v1 (design section 14, call 5).
    if (isObject(raw) && raw.protectedBranches !== undefined) return fail(`repos[${i}]: protectedBranches is not supported in the import format`);
    const r = validateFactoryRepo(raw, def.value);
    if (!r.ok) return fail(`repos[${i}]: ${r.error}`);
    if (repos.some((x) => x.repoId === r.value.repoId)) return fail(`repos[${i}]: duplicate repo id ${r.value.repoId}`);
    repos.push(r.value);
  }
  return { ok: true, value: { format: IMPORT_FORMAT, factory: def.value, repos } };
}
