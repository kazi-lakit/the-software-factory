import { describe, expect, test } from 'vitest';
import { detectChecks } from '../src/detectChecks.js';

const readOf = (files: Record<string, string>) => async (p: string) => files[p] ?? null;

describe('detectChecks', () => {
  test('npm with a lockfile: npm ci then the scripts that exist, in order', async () =>
    expect(await detectChecks(['package.json', 'package-lock.json'], readOf({ 'package.json': '{"scripts":{"test":"v","lint":"e","build":"b"}}' }))).toEqual([
      { name: 'install', cwd: '.', run: 'npm ci' }, { name: 'lint', cwd: '.', run: 'npm run lint', needs: 'install' },
      { name: 'test', cwd: '.', run: 'npm run test', needs: 'install' }, { name: 'build', cwd: '.', run: 'npm run build', needs: 'install' }]));

  test.each([
    ['pnpm-lock.yaml', 'pnpm i --frozen-lockfile', 'pnpm run test'],
    ['yarn.lock', 'yarn --frozen-lockfile', 'yarn test'],
    [null, 'npm install', 'npm run test'],
  ])('lockfile %s', async (lock, install, test_) =>
    expect(await detectChecks(['package.json', ...(lock ? [lock] : [])], readOf({ 'package.json': '{"scripts":{"test":"v"}}' }))).toEqual([
      { name: 'install', cwd: '.', run: install }, { name: 'test', cwd: '.', run: test_, needs: 'install' }]));

  test('monorepo with server (dotnet) and client (pnpm) gets prefixed names and cwds', async () =>
    expect(await detectChecks(['server/api.csproj', 'client/package.json', 'client/pnpm-lock.yaml', 'client/src/a.ts', 'README.md'],
      readOf({ 'client/package.json': '{"scripts":{"lint":"x"}}' }))).toEqual([
      { name: 'server.build', cwd: 'server', run: 'dotnet build' }, { name: 'server.test', cwd: 'server', run: 'dotnet test', needs: 'server.build' },
      { name: 'client.install', cwd: 'client', run: 'pnpm i --frozen-lockfile' }, { name: 'client.lint', cwd: 'client', run: 'pnpm run lint', needs: 'client.install' }]));

  test.each([
    ['go.mod', 'go build ./...', 'go test ./...'], ['Cargo.toml', 'cargo build', 'cargo test'], ['api.sln', 'dotnet build', 'dotnet test'],
  ])('%s gives build then test', async (f, b, t) =>
    expect(await detectChecks([f], readOf({}))).toEqual([{ name: 'build', cwd: '.', run: b }, { name: 'test', cwd: '.', run: t, needs: 'build' }]));

  test('pytest only when mentioned; make test only when nothing else matched', async () => {
    expect(await detectChecks(['pyproject.toml'], readOf({ 'pyproject.toml': 'dependencies = ["pytest"]' }))).toEqual([{ name: 'test', cwd: '.', run: 'pytest' }]);
    expect(await detectChecks(['requirements.txt'], readOf({ 'requirements.txt': 'flask' }))).toEqual([]);
    expect(await detectChecks(['Makefile'], readOf({ Makefile: 'build:\n\tx\ntest:\n\ty\n' }))).toEqual([{ name: 'test', cwd: '.', run: 'make test' }]);
    expect(await detectChecks(['Makefile', 'go.mod'], readOf({ Makefile: 'test:\n\ty\n' }))).toHaveLength(2);
  });

  test('nothing found is an empty list; deeper folders are ignored', async () => {
    expect(await detectChecks(['README.md', 'a/b/go.mod'], readOf({}))).toEqual([]);
    expect(await detectChecks(['package.json'], readOf({ 'package.json': 'not json' }))).toEqual([]);
  });
});
