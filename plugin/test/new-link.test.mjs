import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_IDS } from '../../core/src/types.ts';
import { buildLink } from '../skills/new/link.mjs';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../skills/new/link.mjs');
const BOARD = 'https://board.test';
const draft = (over = {}) => ({ title: 'Fix it', description: 'Details', repo: 'os', base: 'dev', ...over });
const params = (url) => new URL(url).searchParams;

function runCli(d, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-link-'));
  const file = path.join(dir, 'draft.json');
  fs.writeFileSync(file, JSON.stringify(d));
  const { FACTORY_BOARD_URL, ...rest } = process.env;
  return spawnSync(process.execPath, [script, file], { encoding: 'utf8', env: { ...rest, ...env } });
}

describe('buildLink', () => {
  it('builds /?new=1 with the four fields', () => {
    const url = buildLink(draft(), BOARD);
    expect(url.startsWith(`${BOARD}/?new=1&title=`)).toBe(true);
    const p = params(url);
    expect([p.get('new'), p.get('title'), p.get('description'), p.get('repo'), p.get('base')]).toEqual(['1', 'Fix it', 'Details', 'os', 'dev']);
  });

  it('encodes spaces, ampersands, hashes, newlines and non-ASCII so they round-trip', () => {
    const text = 'a b & c # d\nline two é 日本 100%';
    const url = buildLink(draft({ title: text, description: text }), BOARD);
    expect(url).not.toMatch(/[\n #](?!$)/);
    expect(url.includes('#')).toBe(false);
    expect(params(url).get('title')).toBe(text);
    expect(params(url).get('description')).toBe(text);
  });

  it('caps the title at 200 and the description at 8000 characters', () => {
    const p = params(buildLink(draft({ title: 't'.repeat(300), description: 'd'.repeat(9000) }), BOARD));
    expect(p.get('title')).toHaveLength(200);
    expect(p.get('description')).toHaveLength(8000);
  });

  it('accepts every core repo id', () => {
    for (const repo of REPO_IDS) expect(params(buildLink(draft({ repo }), BOARD)).get('repo')).toBe(repo);
  });

  it('rejects an unknown repo', () => {
    expect(() => buildLink(draft({ repo: 'nope' }), BOARD)).toThrow('factory: unknown repo nope');
  });

  it('rejects a blank title', () => {
    expect(() => buildLink(draft({ title: '   ' }), BOARD)).toThrow(/title/);
    expect(() => buildLink(draft({ title: undefined }), BOARD)).toThrow(/title/);
  });

  it('strips trailing slashes from the board url', () => {
    expect(buildLink(draft(), `${BOARD}/`).startsWith(`${BOARD}/?new=1`)).toBe(true);
    expect(buildLink(draft(), `${BOARD}//`).startsWith(`${BOARD}/?new=1`)).toBe(true);
  });

  it('leaves base empty rather than inventing one', () => {
    expect(params(buildLink(draft({ base: undefined }), BOARD)).get('base')).toBe('');
  });
});

describe('link.mjs command line', () => {
  it('prints one url, using the default board url', () => {
    const r = runCli(draft());
    expect(r.status).toBe(0);
    expect(r.stdout.trim().startsWith('https://dfrsgz-eseqz.slsblx.com/?new=1&title=')).toBe(true);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
  });

  it('takes the board url from FACTORY_BOARD_URL', () => {
    const r = runCli(draft(), { FACTORY_BOARD_URL: 'https://other.test/' });
    expect(r.stdout.trim().startsWith('https://other.test/?new=1')).toBe(true);
  });

  it('exits 1 with the message for an unknown repo', () => {
    const r = runCli(draft({ repo: 'nope' }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('factory: unknown repo nope');
    expect(r.stdout).toBe('');
  });

  it('exits 1 for a missing or unreadable draft file', () => {
    const r = spawnSync(process.execPath, [script, '/nonexistent/draft.json'], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('factory:');
  });
});
