import { Octokit } from '@octokit/rest';
import { isProtected, ProtectedBranchError } from './branchGuard.js';

export type PrState = 'open' | 'merged' | 'closed';

export interface GitHub {
  openPr(p: { remote: string; head: string; base: string; title: string; body: string }): Promise<{ url: string; number: number }>;
  prState(url: string): Promise<PrState>;
  mergePr(url: string, base: string): Promise<void>;
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

  async prState(url: string): Promise<PrState> {
    const { owner, repo, number } = parsePrUrl(url);
    const { data } = await this.octokit.rest.pulls.get({ owner, repo, pull_number: number });
    if (data.merged) return 'merged';
    return data.state === 'closed' ? 'closed' : 'open';
  }

  async mergePr(url: string, base: string): Promise<void> {
    if (isProtected(base)) throw new ProtectedBranchError(base);
    const { owner, repo, number } = parsePrUrl(url);
    await this.octokit.rest.pulls.merge({ owner, repo, pull_number: number, merge_method: 'merge' });
  }
}

export class FakeGitHub implements GitHub {
  readonly prs = new Map<string, { base: string; head: string; state: PrState }>();
  private next = 1;

  async openPr(p: { remote: string; head: string; base: string; title: string; body: string }): Promise<{ url: string; number: number }> {
    const { owner, repo } = parseRemote(p.remote);
    const prefix = `https://github.com/${owner}/${repo}/pull/`;
    for (const [u, pr] of this.prs) {
      if (u.startsWith(prefix) && pr.head === p.head && pr.base === p.base && pr.state === 'open') {
        throw new Error(`A pull request already exists for ${p.head} into ${p.base}`);
      }
    }
    const number = this.next++;
    const url = `${prefix}${number}`;
    this.prs.set(url, { base: p.base, head: p.head, state: 'open' });
    return { url, number };
  }

  async prState(url: string): Promise<PrState> {
    return this.pr(url).state;
  }

  async mergePr(url: string, base: string): Promise<void> {
    if (isProtected(base)) throw new ProtectedBranchError(base);
    this.pr(url).state = 'merged';
  }

  setState(url: string, state: PrState): void {
    this.pr(url).state = state;
  }

  private pr(url: string) {
    const pr = this.prs.get(url);
    if (!pr) throw new Error(`unknown pull request: ${url}`);
    return pr;
  }
}
