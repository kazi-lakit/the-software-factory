import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const FORBIDDEN = /(^|\/)(credential|secrets|token|wire|cli|git|github|githubBoard|checks|engine|claims|repoConfig|githubPusher|githubPuller|githubWatcher)\.ts$|src\/store\.ts$/;

describe('browser entry', () => {
  it('bundles for the browser with no Node-only or credential module', async () => {
    const result = await build({
      entryPoints: ['src/browser.ts'], bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true, logLevel: 'silent',
    });
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.filter((i) => FORBIDDEN.test(i))).toEqual([]);
    const nodeImports = Object.values(result.metafile.inputs).flatMap((i) => i.imports.map((m) => m.path)).filter((p) => p.startsWith('node:'));
    expect(nodeImports).toEqual([]);
    expect(inputs.some((i) => i.endsWith('src/blocks/store.ts'))).toBe(true);
    expect(inputs.some((i) => i.endsWith('src/owner.ts'))).toBe(true);
  });

  it('exports isMainRef for the Board\'s base checks', async () => {
    const entry = await import('../src/browser.js');
    expect(entry.isMainRef('refs/heads/main')).toBe(true);
    expect(entry.isMainRef('dev')).toBe(false);
  });

  it('exports unfinishedDeps for the Board', async () => {
    const entry = await import('../src/browser.js');
    expect(entry.unfinishedDeps({ dependsOn: ['T-1'] }, [{ taskId: 'T-1', status: 'build' }])).toEqual(['T-1']);
  });

  it('exports the agent stage and model lists for the Board', async () => {
    const entry = await import('../src/browser.js');
    expect(entry.AGENT_STEPS).toEqual(['spec', 'plan', 'build', 'verify', 'review']);
    expect(entry.AGENT_MODELS).toEqual(['opus', 'sonnet', 'haiku', 'fable']);
  });

  it('exports the Blocks data errors so the Board can tell them apart', async () => {
    const entry = await import('../src/browser.js');
    const data = await import('../src/blocks/data.js');
    expect(entry.BlocksForbiddenError).toBe(data.BlocksForbiddenError);
    expect(entry.BlocksUnauthorizedError).toBe(data.BlocksUnauthorizedError);
  });
});
