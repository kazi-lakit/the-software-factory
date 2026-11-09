import { createBlocksClient } from '@seliseblocks/client';
import type { BlocksCredential } from './credential.js';

/** Source of the bearer token for Blocks calls. */
export interface TokenSource {
  get(): Promise<string>;
  /** Drops the cached token so the next get() fetches a fresh one. */
  invalidate(): void;
}

export type Mint = (cred: BlocksCredential) => Promise<{ accessToken: string; expiresIn: number }>;

const REFRESH_WINDOW_MS = 120_000;
const FAILED = 'blocks: client-credentials token request failed';

/** Default mint through the SDK. The token endpoint's error body can echo request data, so it is never surfaced. */
export function sdkMint(options: { fetch?: typeof fetch } = {}): Mint {
  return async (cred) => {
  let answer: Record<string, unknown>;
  try {
    const client = createBlocksClient({ apiUrl: cred.apiUrl, xBlocksKey: cred.projectKey, ...(options.fetch ? { fetch: options.fetch } : {}) });
    answer = (await client.auth.oidc.clientCredentials({ clientId: cred.clientId, clientSecret: cred.clientSecret })) as Record<string, unknown>;
  } catch { throw new Error(FAILED); }
  // Blocks answers in camelCase ({ accessToken, expiresIn }); OAuth's snake_case is accepted too.
  const token = answer?.accessToken ?? answer?.access_token;
  const expiresIn = answer?.expiresIn ?? answer?.expires_in;
  if (typeof token !== 'string' || !token || typeof expiresIn !== 'number' || expiresIn <= 0) throw new Error(FAILED);
  return { accessToken: token, expiresIn };
  };
}

/** In-memory client-credentials token: refreshed when under 120 s are left, one mint in flight, never written to disk. */
export class ClientCredentialsToken implements TokenSource {
  private current: { accessToken: string; expiresAt: number } | null = null;
  private inFlight: Promise<string> | null = null;
  private generation = 0;

  constructor(
    private readonly cred: BlocksCredential,
    private readonly mint: Mint = sdkMint(),
    private readonly now: () => number = Date.now,
  ) {}

  get(): Promise<string> {
    if (this.current && this.current.expiresAt - this.now() >= REFRESH_WINDOW_MS) return Promise.resolve(this.current.accessToken);
    this.inFlight ??= this.obtain();
    return this.inFlight;
  }

  invalidate(): void {
    this.generation += 1;
    this.current = null;
    this.inFlight = null;
  }

  private async obtain(): Promise<string> {
    const started = this.generation;
    try {
      let minted: { accessToken: string; expiresIn: number };
      try { minted = await this.mint(this.cred); } catch { throw new Error(FAILED); }
      // A mint that began before invalidate() is returned to its caller but never cached.
      if (started === this.generation) this.current = { accessToken: minted.accessToken, expiresAt: this.now() + minted.expiresIn * 1000 };
      return minted.accessToken;
    } finally {
      if (started === this.generation) this.inFlight = null;
    }
  }
}
