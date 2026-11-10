import type { FakeBlocksData } from '../src/blocks/fakeData.js';
import type { FactoryDef, FactoryRepo } from '../src/factories.js';

export const checksFixture = {
  server: { cwd: 'server', build: 'b', test: 't' },
  client: { cwd: 'client', install: 'i', typecheck: 'tc', lint: 'l', test: 't' },
  e2e: 'off',
} as const;

export const defFixture = (factoryId: string, over: Partial<FactoryDef> = {}): FactoryDef => ({
  factoryId, name: factoryId, protectedBranches: ['dev', 'stg', 'main'], gitName: 'Factory', gitEmail: 'factory@example.com',
  docsPath: '/docs', ghUser: `gh-${factoryId}`, active: true, version: 1, ...over,
});

export const repoFixture = (factoryId: string, repoId: string, over: Partial<FactoryRepo> = {}): FactoryRepo => ({
  factoryId, repoId, remote: `git@github.com:org/${repoId}.git`, baseBranch: 'dev', checks: structuredClone(checksFixture) as never, version: 1, ...over,
});

/** One factory with the given repos, as the `factories` option of a store. */
export const seed = (factoryId = 'blocks', repos: string[] = ['data', 'iam', 'os']) => ({
  defs: [defFixture(factoryId)], repos: repos.map((r) => repoFixture(factoryId, r)),
});

/** Stores the definitions as rows in a fake Blocks project (as the Board's owner would have saved them). */
export function seedBlocksFactories(data: FakeBlocksData, factories: { defs: FactoryDef[]; repos: FactoryRepo[] }): void {
  for (const d of factories.defs) {
    data.seed('FactoryDef', {
      factoryId: d.factoryId, name: d.name, protectedBranches: JSON.stringify(d.protectedBranches), gitName: d.gitName, gitEmail: d.gitEmail,
      docsPath: d.docsPath, ghUser: d.ghUser, active: d.active ? 1 : 0, version: d.version, writeId: '',
    });
  }
  for (const r of factories.repos) {
    data.seed('FactoryRepo', {
      repoKey: `${r.factoryId}/${r.repoId}`, factoryId: r.factoryId, repoId: r.repoId, remote: r.remote, baseBranch: r.baseBranch,
      checks: JSON.stringify(r.checks), version: r.version, writeId: '',
    });
  }
}
