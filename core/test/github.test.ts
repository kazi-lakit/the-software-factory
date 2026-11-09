import { describe, expect, test, vi } from 'vitest';
import { ProtectedBranchError } from '../src/branchGuard.js';
import { FakeGitHub, OctokitGitHub, parseRemote } from '../src/github.js';

describe('parseRemote', () => {
  test.each([
    ['git@github.com:SELISEdigitalplatforms/blocks-data.git'],
    ['git@github.com:SELISEdigitalplatforms/blocks-data'],
    ['https://github.com/SELISEdigitalplatforms/blocks-data'],
    ['https://github.com/SELISEdigitalplatforms/blocks-data.git'],
  ])('parses %s', (r) => {
    expect(parseRemote(r)).toEqual({ owner: 'SELISEdigitalplatforms', repo: 'blocks-data' });
  });

  test('throws a plain Error for anything else', () => {
    expect(() => parseRemote('ftp://example.com/x')).toThrow(Error);
    expect(() => parseRemote('/local/path')).toThrow('unsupported remote');
  });
});

describe('OctokitGitHub', () => {
  test('mergePr to a protected base rejects before any network call', async () => {
    const fetchStub = vi.fn();
    const gh = new OctokitGitHub('t', { fetch: fetchStub as unknown as typeof fetch });
    await expect(gh.mergePr('https://github.com/o/r/pull/1', 'main')).rejects.toBeInstanceOf(ProtectedBranchError);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  test('openPr returns url and number', async () => {
    const fetchStub = vi.fn(async () => json({ html_url: 'https://github.com/o/r/pull/7', number: 7 }, 201));
    const gh = new OctokitGitHub('t', { fetch: fetchStub as unknown as typeof fetch });
    const res = await gh.openPr({ remote: 'git@github.com:o/r.git', head: 'factory/x', base: 'dev', title: 'T', body: 'B' });
    expect(res).toEqual({ url: 'https://github.com/o/r/pull/7', number: 7 });
  });

  test.each([
    [{ state: 'open', merged: false }, 'open'],
    [{ state: 'closed', merged: false }, 'closed'],
    [{ state: 'closed', merged: true }, 'merged'],
  ] as const)('prState maps %j to %s', async (body, expected) => {
    const fetchStub = vi.fn(async () => json(body));
    const gh = new OctokitGitHub('t', { fetch: fetchStub as unknown as typeof fetch });
    expect(await gh.prState('https://github.com/o/r/pull/3')).toBe(expected);
  });

  test('mergePr on an unprotected base uses the merge method', async () => {
    const fetchStub = vi.fn(async (_u: unknown, _i?: RequestInit) => json({ merged: true }));
    const gh = new OctokitGitHub('t', { fetch: fetchStub as unknown as typeof fetch });
    await gh.mergePr('https://github.com/o/r/pull/3', 'feature/x');
    const [url, init] = fetchStub.mock.calls[0] as [Request | string, RequestInit | undefined];
    const u = typeof url === 'string' ? url : (url as Request).url;
    expect(u).toContain('/repos/o/r/pulls/3/merge');
    const body = init?.body ?? (await (url as Request).text());
    expect(JSON.parse(String(body))).toMatchObject({ merge_method: 'merge' });
  });
});

describe('FakeGitHub', () => {
  test('open after openPr, merged after mergePr', async () => {
    const gh = new FakeGitHub();
    const a = await gh.openPr({ remote: 'git@github.com:o/r.git', head: 'h', base: 'feature/x', title: 't', body: 'b' });
    const b = await gh.openPr({ remote: 'git@github.com:o/r.git', head: 'h2', base: 'feature/x', title: 't', body: 'b' });
    expect(a).toEqual({ url: 'https://github.com/o/r/pull/1', number: 1 });
    expect(b.number).toBe(2);
    expect(await gh.prState(a.url)).toBe('open');
    await gh.mergePr(a.url, 'feature/x');
    expect(await gh.prState(a.url)).toBe('merged');
    gh.setState(b.url, 'closed');
    expect(gh.prs.get(b.url)).toEqual({ base: 'feature/x', head: 'h2', state: 'closed' });
  });

  test('mergePr to a protected base throws and leaves state', async () => {
    const gh = new FakeGitHub();
    const a = await gh.openPr({ remote: 'git@github.com:o/r.git', head: 'h', base: 'dev', title: 't', body: 'b' });
    await expect(gh.mergePr(a.url, 'dev')).rejects.toBeInstanceOf(ProtectedBranchError);
    expect(await gh.prState(a.url)).toBe('open');
  });
});
