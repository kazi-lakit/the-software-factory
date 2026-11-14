// Pure (no Node API): shared by factories.ts and githubConfig.ts.
export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

/** A GitHub login: letters, digits and single inner hyphens, at most 39 characters. */
export const GH_USER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
