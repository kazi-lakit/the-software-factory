// Test-only: factory definitions and their Blocks rows, so the Board tests need nothing from core/test.
import type { FactoryDef, FactoryRepo } from "@factory/core";
import type { FakeBlocksData } from "../../../core/src/blocks/fakeData";

export type Factories = { defs: FactoryDef[]; repos: FactoryRepo[] };

const checks = {
  client: { cwd: "client", install: "i", lint: "l", test: "t", typecheck: "tc" },
  e2e: "off",
  server: { build: "b", cwd: "server", test: "t" }
} as const;

export const defFixture = (factoryId: string, over: Partial<FactoryDef> = {}): FactoryDef => ({
  active: true, docsPath: "/docs", factoryId, gitEmail: "factory@example.com", gitName: "Factory", name: factoryId,
  ghUser: `gh-${factoryId}`, protectedBranches: ["dev", "stg", "main"], version: 1, ...over
});

export const repoFixture = (factoryId: string, repoId: string, over: Partial<FactoryRepo> = {}): FactoryRepo => ({
  baseBranch: "dev", checks: structuredClone(checks) as never, factoryId, remote: `git@github.com:org/${repoId}.git`, repoId, version: 1, ...over
});

/** One factory with the given repos. */
export const factory = (factoryId: string, repos: string[], over: Partial<FactoryDef> = {}): Factories => ({
  defs: [defFixture(factoryId, over)], repos: repos.map((repoId) => repoFixture(factoryId, repoId))
});

export const merge = (...all: Factories[]): Factories => ({ defs: all.flatMap((f) => f.defs), repos: all.flatMap((f) => f.repos) });

/** The default Board fixture: factory `blocks` with the seven Blocks repos. */
export const BLOCKS_REPOS = ["os", "iam", "monitor", "logic", "data", "localization", "release"];
export const blocksFactories = (): Factories => factory("blocks", BLOCKS_REPOS, { name: "Blocks" });

/** Stores the definitions as rows in a fake Blocks project (as the Board's owner would have saved them). */
export function seedBlocksFactories(data: FakeBlocksData, factories: Factories): void {
  for (const d of factories.defs) {
    data.seed("FactoryDef", {
      active: d.active ? 1 : 0, docsPath: d.docsPath, factoryId: d.factoryId, gitEmail: d.gitEmail, gitName: d.gitName, name: d.name,
      ghUser: d.ghUser, protectedBranches: JSON.stringify(d.protectedBranches), version: d.version, writeId: ""
    });
  }
  for (const r of factories.repos) {
    data.seed("FactoryRepo", {
      baseBranch: r.baseBranch, checks: JSON.stringify(r.checks), factoryId: r.factoryId, remote: r.remote, repoId: r.repoId,
      repoKey: `${r.factoryId}/${r.repoId}`, version: r.version, writeId: ""
    });
  }
}
