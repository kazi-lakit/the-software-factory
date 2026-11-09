// Ported from ACR origin/main apps/web/src/lib/blocks/auth.ts (renewal fix, commit 9082852), cookie flow only:
// the bearer branch (persistTokens, sessionStorage tokens, jwt.ts) is gone.
import { blocksClient } from "./client";
import { blocksConfig } from "./config";

// The Board's OIDC client keeps both tokens in Secure, httpOnly cookies
// (useTokensCookie). This module never reads, stores or refreshes a token in
// JavaScript: the SDK sends every request with `credentials: "include"` and
// the browser attaches the cookies. Only the page to return to after sign-in
// is kept in sessionStorage, and it is not a secret.
const RETURN_KEY = "blocks-app:oidc-return-to";

export type CallbackResult = { ok: true; returnTo: string } | { ok: false; message: string };

// AuthProvider subscribes to this to learn the session died out-of-band (a
// renewal came back rejected) so it can flip status to unauthenticated and
// let RequireAuth redirect to /login -- this module has no router access.
const sessionExpiredListeners = new Set<() => void>();

export function onSessionExpired(listener: () => void): () => void {
  sessionExpiredListeners.add(listener);
  return () => sessionExpiredListeners.delete(listener);
}

export function notifySessionExpired(): void {
  for (const listener of sessionExpiredListeners) listener();
}

export type RenewOutcome = "renewed" | "rejected" | "unavailable";

let renewInFlight: Promise<RenewOutcome> | undefined;

// The access cookie lasts only minutes (the project's
// accessTokenValidForNumberMinutes). IAM renews it from the refresh cookie
// when the token endpoint is called with no refresh token in the body
// (`POST /iam/v4/oidc/token`, grant_type=refresh_token, client_id),
// answering `cookie_set` and setting fresh cookies. Without this the session
// ends when the first access cookie expires, however active the person is.
// "rejected" means IAM refused the refresh cookie (gone, expired or revoked);
// "unavailable" says nothing about the session (a network failure or an
// answer that is neither), so it must never sign anyone out. One renewal is
// in flight at a time; concurrent callers share it. This function never
// ends the session itself: callers decide what a "rejected" means for them.
export function renewSession(): Promise<RenewOutcome> {
  if (!renewInFlight) {
    renewInFlight = renewCookieSession().finally(() => {
      renewInFlight = undefined;
    });
  }
  return renewInFlight;
}

async function renewCookieSession(): Promise<RenewOutcome> {
  let response: Awaited<ReturnType<typeof blocksClient.auth.oidc.refreshToken>> | undefined;
  try {
    response = await blocksClient.auth.oidc.refreshToken({});
  } catch {
    return "unavailable";
  }

  // The SDK does not throw on IAM's 400: a refused cookie comes back as an
  // `error` body ("refresh token not found", invalid_grant).
  if (typeof response?.error === "string") return "rejected";
  if (response?.cookie_set === true || typeof response?.expires_in === "number") return "renewed";
  return "unavailable";
}

// Passed to createBlocksClient as `onUnauthorized`: a 401 on an IAM/Data call
// renews the cookie so the next call carries a fresh one. There is no bearer
// token to hand back, so the SDK does not retry this request itself; a
// refused cookie means the session really is over.
export async function handleUnauthorized(): Promise<undefined> {
  if (await renewSession() === "rejected") notifySessionExpired();
  return undefined;
}

// The session's source of truth is IAM, not a token this app can inspect.
// `auth.isAuthenticated()` checks the status of `GET /iam/v4/auth/me`;
// `auth.userInfo()` alone cannot decide it, because the SDK returns the
// error body of a 401 instead of throwing. The claims are informational: a
// live session whose claims cannot be read is still signed in.
// `iam.me()` is a different, heavier call -- the full IAM profile with roles --
// and is what the owner check reads.
export async function fetchSessionClaims(): Promise<Record<string, unknown> | undefined> {
  try {
    if (!(await blocksClient.auth.isAuthenticated())) return undefined;
  } catch {
    return undefined;
  }
  try {
    const claims = await blocksClient.auth.userInfo();
    return typeof claims === "object" && claims !== null && !Array.isArray(claims) ? claims : {};
  } catch {
    return {};
  }
}

// Only a page on this site: anything else (another origin, `//host`, a
// scheme, a path the URL parser turns into one) would make the post-sign-in
// navigation leave the app or throw. Parsed the way the browser will parse it.
function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/")) return "/";
  let url: URL;
  try {
    url = new URL(value, window.location.origin);
  } catch {
    return "/";
  }
  return url.origin === window.location.origin ? `${url.pathname}${url.search}${url.hash}` : "/";
}

export async function startLogin(returnTo?: string): Promise<void> {
  if (!blocksConfig.oidcClientId) {
    throw new Error("Login is not configured. Set VITE_BLOCKS_OIDC_CLIENT_ID in .env.");
  }

  sessionStorage.setItem(RETURN_KEY, safeReturnTo(returnTo));
  await blocksClient.auth.idp.redirectToProvider();
}

export async function completeLogin(callbackUrl: string): Promise<CallbackResult> {
  const returnTo = safeReturnTo(sessionStorage.getItem(RETURN_KEY));

  sessionStorage.removeItem(RETURN_KEY);

  const data = await blocksClient.auth.idp.callback(callbackUrl);

  if (data?.error) {
    return { message: data.error_description || data.error, ok: false };
  }

  // IAM sets the session via Set-Cookie on this same response. Any token in
  // the body is ignored: this app never keeps one in JavaScript.
  return { ok: true, returnTo };
}

export async function logout(): Promise<void> {
  // Ask IAM to end the session (clears the httpOnly cookies server-side);
  // best-effort so a network failure never blocks the user from leaving.
  await blocksClient.auth.logout({}).catch(() => undefined);
}
