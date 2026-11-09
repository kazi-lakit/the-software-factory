import { describe, expect, it } from 'vitest';
import { ClientCredentialsToken } from '../../src/blocks/token.js';
import type { BlocksCredential } from '../../src/blocks/credential.js';

const cred: BlocksCredential = { clientId: 'c', clientSecret: 's', projectKey: 'p', apiUrl: 'https://a.example.com' };

function setup(expiresIn = 900) {
  let t = 1_000_000;
  let n = 0;
  const mint = async () => { n += 1; return { accessToken: `tok${n}`, expiresIn }; };
  const src = new ClientCredentialsToken(cred, mint, () => t);
  return { src, advance: (s: number) => { t += s * 1000; }, count: () => n };
}

describe('ClientCredentialsToken', () => {
  it('reuses a token with 121 s left', async () => {
    const { src, advance, count } = setup();
    await src.get();
    advance(900 - 121);
    expect(await src.get()).toBe('tok1');
    expect(count()).toBe(1);
  });
  it('refreshes with 119 s left', async () => {
    const { src, advance } = setup();
    await src.get();
    advance(900 - 119);
    expect(await src.get()).toBe('tok2');
  });
  it('mints once for concurrent gets', async () => {
    const { src, count } = setup();
    const [a, b] = await Promise.all([src.get(), src.get()]);
    expect(a).toBe(b);
    expect(count()).toBe(1);
  });
  it('invalidate forces a new mint', async () => {
    const { src, count } = setup();
    await src.get();
    src.invalidate();
    expect(await src.get()).toBe('tok2');
    expect(count()).toBe(2);
  });
  it('does not let an in-flight mint revive after invalidate', async () => {
    let n = 0;
    const releases: (() => void)[] = [];
    const mint = () => new Promise<{ accessToken: string; expiresIn: number }>((res) => { n += 1; const id = n; releases.push(() => res({ accessToken: `tok${id}`, expiresIn: 900 })); });
    const src = new ClientCredentialsToken(cred, mint, () => 0);
    const first = src.get();
    src.invalidate();
    const second = src.get();
    releases[0](); releases[1]();
    await first;
    expect(await second).toBe('tok2');
    expect(await src.get()).toBe('tok2');
  });
  it('hides the underlying mint error', async () => {
    const src = new ClientCredentialsToken(cred, async () => { throw new Error('echoed LEAKME'); }, () => 0);
    const err = await src.get().catch((e: Error) => e);
    expect((err as Error).message).toBe('blocks: client-credentials token request failed');
    // a failure does not poison later calls
    const ok = new ClientCredentialsToken(cred, async () => ({ accessToken: 'x', expiresIn: 900 }), () => 0);
    expect(await ok.get()).toBe('x');
  });
});
