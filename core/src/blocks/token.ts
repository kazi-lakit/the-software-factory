/** Source of the bearer token for Blocks calls. The implementation arrives in a later task. */
export interface TokenSource {
  get(): Promise<string>;
  /** Drops the cached token so the next get() fetches a fresh one. */
  invalidate(): void;
}
