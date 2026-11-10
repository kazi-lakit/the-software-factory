import { Octokit } from '@octokit/rest';
import { isProtected, ProtectedBranchError } from './branchGuard.js';

/** The client for a factory's PAT (its Keychain account). */
export type GitHubFor = (patAccount: string) => GitHub;

export type PrState = 'open' | 'merged' | 'closed';

export interface GitHub {
  /** Resolves the credential up front; rejects with PatMissingError when the factory has none. Clients without a lazy credential omit it. */
  ensureReady?(): Promise<void>;
  openPr(p: { remote: string; head: string; base: string; title: string; body: string }): Promise<{ url: string; number: number }>;
  /** The open PR from `head` into `base` in the remote's repo, or null. */
  findOpenPr(p: { remote: string; head: string; base: string }): Promise<{ url: string; number: number } | null>;
  prState(url: string): Promise<PrState>;
  /** Merges only when the PR's real base is `base` and not protected (in `protectedBranches`, default dev/stg/main); throws ProtectedBranchError or PrBaseMismatchError otherwise. */
  mergePr(url: string, base: string, protectedBranches?: readonly string[]): Promise<void>;
}

/** The PR targets another base than the one the caller expects; it is never merged. */
export class PrBaseMismatchError extends Error {
  constructor(url: string, actual: string, expected: string) {
    super(`${url} targets ${actual}, not ${expected}; not merged`);
    this.name = 'PrBaseMismatchError';
  }
}

/** Refuses a merge unless the PR's stored base is unprotected and equals the expected base. */
function assertMergeBase(url: string, actual: string, expected: string, protectedBranches?: readonly string[]): void {
  if (isProtected(actual, protectedBranches)) throw new ProtectedBranchError(actual);
  if (actual !== expected) throw new PrBaseMismatchError(url, actual, expected);
}

/** Parses `git@github.com:O/R(.git)` and `https://github.com/O/R(.git)`. */
export function parseRemote(remote: string): { owner: string; repo: string } {
  const m = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(remote) ?? /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(remote);
  if (!m) throw new Error(`unsupported remote: ${remote}`);
  return { owner: m[1]!, repo: m[2]! };
}

function parsePrUrl(url: string): { owner: string; repo: string; number: number } {
  const m = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)$/.exec(url);
  if (!m) throw new Error(`unsupported pull request url: ${url}`);
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
}

export class OctokitGitHub implements GitHub {
  private readonly octokit: Octokit;

  constructor(token: string, opts?: { fetch?: typeof fetch }) {
    this.octokit = new Octokit({ auth: token, ...(opts?.fetch ? { request: { fetch: opts.fetch } } : {}) });
  }

  async openPr(p: { remote: string; head: string; base: string; title: string; body: string }): Promise<{ url: string; number: number }> {
    const { owner, repo } = parseRemote(p.remote);
    const res = await this.octokit.rest.pulls.create({ owner, repo, head: p.head, base: p.base, title: p.title, body: p.body });
    return { url: res.data.html_url, number: res.data.number };
  }

  async findOpenPr(p: { remote: string; head: string; base: string }): Promise<{ url: string; number: number } | null> {
    const { owner, repo } = parseRemote(p.remote);
    const { data } = await this.octokit.rest.pulls.list({ owner, repo, head: `${owner}:${p.head}`, base: p.base, state: 'open' });
    const pr = data[0];
    return pr ? { url: pr.html_url, number: pr.number } : null;
  }

  async prState(url: string): Promise<PrState> {
    const { owner, repo, number } = parsePrUrl(url);
    const { data } = await this.octokit.rest.pulls.get({ owner, repo, pull_number: number });
    if (data.merged) return 'merged';
    return data.state === 'closed' ? 'closed' : 'open';
  }

  async mergePr(url: string, base: string, protectedBranches?: readonly string[]): Promise<void> {
    if (isProtected(base, protectedBranches)) throw new ProtectedBranchError(base);
    const { owner, repo, number } = parsePrUrl(url);
    const { data } = await this.octokit.rest.pulls.get({ owner, repo, pull_number: number });
    assertMergeBase(url, data.base.ref, base, protectedBranches);
    await this.octokit.rest.pulls.merge({ owner, repo, pull_number: number, merge_method: 'merge', sha: data.head.sha });
  }
}

export class FakeGitHub implements GitHub {
  readonly prs = new Map<string, { base: string; head: string; state: PrState }>();
  private next = 1;

  async openPr(p: { remote: string; head: string; base: string; title: string; body: string }): Promise<{ url: string; number: number }> {
    if (await this.findOpenPr(p)) throw new Error(`A pull request already exists for ${p.head} into ${p.base}`);
    const number = this.next++;
    const url = `${this.prefix(p.remote)}${number}`;
    this.prs.set(url, { base: p.base, head: p.head, state: 'open' });
    return { url, number };
  }

  async findOpenPr(p: { remote: string; head: string; base: string }): Promise<{ url: string; number: number } | null> {
    const prefix = this.prefix(p.remote);
    for (const [url, pr] of this.prs) {
      if (url.startsWith(prefix) && pr.head === p.head && pr.base === p.base && pr.state === 'open') {
        return { url, number: Number(url.slice(prefix.length)) };
      }
    }
    return null;
  }

  async prState(url: string): Promise<PrState> {
    return this.pr(url).state;
  }

  async mergePr(url: string, base: string, protectedBranches?: readonly string[]): Promise<void> {
    if (isProtected(base, protectedBranches)) throw new ProtectedBranchError(base);
    const pr = this.pr(url);
    assertMergeBase(url, pr.base, base, protectedBranches);
    pr.state = 'merged';
  }

  setState(url: string, state: PrState): void {
    this.pr(url).state = state;
  }

  private prefix(remote: string): string {
    const { owner, repo } = parseRemote(remote);
    return `https://github.com/${owner}/${repo}/pull/`;
  }

  private pr(url: string) {
    const pr = this.prs.get(url);
    if (!pr) throw new Error(`unknown pull request: ${url}`);
    return pr;
  }
}
