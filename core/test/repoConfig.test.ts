import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { RepoConfigError, loadRepoConfig } from '../src/repoConfig.js';

const REPO_IDS = ['os', 'iam', 'monitor', 'logic', 'data', 'localization', 'release'];
const reposDir = fileURLToPath(new URL('./fixtures/repos', import.meta.url));

function tempDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'repocfg-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

describe('repo configs', () => {
  test('loads all 7 shipped repos', () => {
    const all = Object.fromEntries(REPO_IDS.map((id) => [id, loadRepoConfig(reposDir, id)])) as Record<string, ReturnType<typeof loadRepoConfig>>;
    expect(Object.keys(all).sort()).toEqual(['data', 'iam', 'localization', 'logic', 'monitor', 'os', 'release']);
    for (const c of Object.values(all)) {
      expect(c.remote).toMatch(/SELISEdigitalplatforms\/blocks-[a-z]+\.git$/);
      expect(c.baseBranch).toBe('dev');
      expect(c.checks.e2e).toBe('off');
    }
  });

  test('solution files per repo', () => {
    const all = Object.fromEntries(REPO_IDS.map((id) => [id, loadRepoConfig(reposDir, id)])) as Record<string, ReturnType<typeof loadRepoConfig>>;
    expect(all.iam.checks.server.build).toBe('dotnet build BlocksIAM.sln');
    expect(all.os.checks.server.test).toBe('dotnet test BlocksOS.sln');
    expect(all.data.checks.server.build).toBe('dotnet build Blocks.slnx');
  });

  test('repo id must match the file name', () => {
    const dir = tempDir({ 'os.yaml': readFileSync(join(reposDir, 'data.yaml'), 'utf8') });
    expect(() => loadRepoConfig(dir, 'os')).toThrow(RepoConfigError);
    expect(() => loadRepoConfig(dir, 'os')).toThrow(/os\.yaml.*repo/);
  });

  test('missing field names the dotted path', () => {
    const body = readFileSync(join(reposDir, 'data.yaml'), 'utf8').replace(/ {4}lint:.*\n/, '');
    const dir = tempDir({ 'data.yaml': body });
    expect(() => loadRepoConfig(dir, 'data')).toThrow(/data\.yaml: checks\.client\.lint is required/);
  });

  test('baseBranch defaults to dev and remote may be a local path', () => {
    const body = readFileSync(join(reposDir, 'logic.yaml'), 'utf8')
      .replace(/remote:.*\n/, 'remote: /tmp/some/bare.git\n')
      .replace(/baseBranch:.*\n/, '');
    const c = loadRepoConfig(tempDir({ 'logic.yaml': body }), 'logic');
    expect(c.baseBranch).toBe('dev');
    expect(c.remote).toBe('/tmp/some/bare.git');
  });

  test('missing file throws RepoConfigError', () => {
    expect(() => loadRepoConfig(tempDir({}), 'os')).toThrow(RepoConfigError);
  });
});
