import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { REPO_IDS, type RepoId } from './types.js';

export { REPO_IDS };

export class RepoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepoConfigError';
  }
}

const cmd = z.string().min(1);

const RepoConfigSchema = z.object({
  repo: z.enum(REPO_IDS as [RepoId, ...RepoId[]]),
  remote: z.string().min(1),
  baseBranch: z.string().min(1).default('dev'),
  checks: z.object({
    server: z.object({ cwd: cmd, build: cmd, test: cmd }),
    client: z.object({ cwd: cmd, install: cmd, typecheck: cmd, lint: cmd, test: cmd }),
    e2e: z.literal('off'),
  }),
});

export type RepoConfig = z.infer<typeof RepoConfigSchema>;

export function loadRepoConfig(reposDir: string, repo: RepoId): RepoConfig {
  const file = join(reposDir, `${repo}.yaml`);
  const name = basename(file);
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new RepoConfigError(`${name}: cannot load (${e instanceof Error ? e.message : String(e)})`);
  }
  const result = RepoConfigSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const path = issue.path.join('.');
    if (path === 'repo') throw new RepoConfigError(`${name}: repo must be "${repo}"`);
    const detail = issue.code === 'invalid_type' && issue.input === undefined ? 'is required' : issue.message;
    throw new RepoConfigError(`${name}: ${path || '(root)'} ${detail}`);
  }
  if (result.data.repo !== repo) throw new RepoConfigError(`${name}: repo must be "${repo}"`);
  return result.data;
}

export function loadAllRepoConfigs(reposDir: string): Record<RepoId, RepoConfig> {
  const out = {} as Record<RepoId, RepoConfig>;
  for (const id of REPO_IDS) out[id] = loadRepoConfig(reposDir, id);
  return out;
}
