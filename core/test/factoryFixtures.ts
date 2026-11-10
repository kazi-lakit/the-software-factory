import type { FactoryDef, FactoryRepo } from '../src/factories.js';

export const checksFixture = {
  server: { cwd: 'server', build: 'b', test: 't' },
  client: { cwd: 'client', install: 'i', typecheck: 'tc', lint: 'l', test: 't' },
  e2e: 'off',
} as const;

export const defFixture = (factoryId: string, over: Partial<FactoryDef> = {}): FactoryDef => ({
  factoryId, name: factoryId, protectedBranches: ['dev', 'stg', 'main'], gitName: 'Factory', gitEmail: 'factory@example.com',
  docsPath: '/docs', patAccount: `github-pat:${factoryId}`, active: true, version: 1, ...over,
});

export const repoFixture = (factoryId: string, repoId: string, over: Partial<FactoryRepo> = {}): FactoryRepo => ({
  factoryId, repoId, remote: `git@github.com:org/${repoId}.git`, baseBranch: 'dev', checks: structuredClone(checksFixture) as never, version: 1, ...over,
});

/** One factory with the given repos, as the `factories` option of a store. */
export const seed = (factoryId = 'blocks', repos: string[] = ['data', 'iam', 'os']) => ({
  defs: [defFixture(factoryId)], repos: repos.map((r) => repoFixture(factoryId, r)),
});
