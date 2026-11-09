// Renewal timing ported from ACR origin/main apps/web/src/app/providers/AuthProvider.tsx (commit 9082852).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { fetchSessionClaims, logout as endSession, onSessionExpired, renewSession, startLogin } from "../../lib/blocks/auth";

type AuthStatus = "authenticated" | "loading" | "unauthenticated";

type AuthContextValue = {
  claims: Record<string, unknown> | undefined;
  login: (returnTo?: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  status: AuthStatus;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);
// A long backup interval, not the primary signal -- polling auth/me every
// few seconds would hit IAM constantly even while the tab sits idle in the
// background. Regaining focus (below) is what actually needs to be prompt,
// e.g. after signing out in another tab or the session expiring meanwhile.
// Each tick while signed in also renews the session cookie, so this must
// stay well under the access cookie's lifetime (15 minutes in ACR).
const STATUS_POLL_MS = 5 * 60_000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [claims, setClaims] = useState<Record<string, unknown> | undefined>();
  // Read by the timer and the checks below without re-creating them.
  const statusRef = useRef<AuthStatus>("loading");
  // Checks overlap (mount, the timer, focus, /login/callback): only the latest
  // one may set the status, so a slow older answer cannot undo a newer one.
  const checkSeq = useRef(0);

  const signOutLocally = useCallback(() => {
    checkSeq.current += 1;
    statusRef.current = "unauthenticated";
    setClaims(undefined);
    setStatus("unauthenticated");
  }, []);

  // The session's source of truth is IAM's GET /iam/v4/auth/me (see
  // fetchSessionClaims), not a token this app can inspect -- hosted login
  // keeps the session in Secure, httpOnly cookies that never reach this
  // app's JS, so a successful check is what "signed in" means.
  const refresh = useCallback(async () => {
    const seq = ++checkSeq.current;
    const stale = () => seq !== checkSeq.current;
    let sessionClaims = await fetchSessionClaims();
    if (stale()) return;
    if (!sessionClaims && statusRef.current !== "unauthenticated") {
      // The access cookie may have run out while the refresh cookie still
      // holds (a sleeping laptop, a long-hidden tab): renew once before
      // calling the session over. Once signed out there is nothing to renew.
      const renewal = await renewSession();
      if (stale()) return;
      if (renewal === "renewed") {
        sessionClaims = await fetchSessionClaims();
        if (stale()) return;
      }
      // A renewal that could not reach IAM says nothing about the session:
      // keep a signed-in user signed in until a check gets an answer.
      else if (renewal === "unavailable" && statusRef.current === "authenticated") return;
    }
    statusRef.current = sessionClaims ? "authenticated" : "unauthenticated";
    setClaims(sessionClaims);
    setStatus(statusRef.current);
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(async () => {
      if (statusRef.current === "authenticated") await renewSession();
      await refresh();
    }, STATUS_POLL_MS);

    function onVisible() {
      if (document.visibilityState === "visible") void refresh();
    }
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  // Fires when a 401 forced a renewal and IAM rejected the refresh cookie
  // outright -- the session is over, so flip to signed out and let
  // RequireAuth redirect to /login.
  useEffect(() => onSessionExpired(signOutLocally), [signOutLocally]);

  const login = useCallback(async (returnTo?: string) => {
    await startLogin(returnTo);
  }, []);

  // Signed out locally once IAM was asked to end the session; renewing the
  // cookie that sign-out just cleared would only cost a request.
  const logout = useCallback(async () => {
    await endSession();
    signOutLocally();
  }, [signOutLocally]);

  const value = useMemo<AuthContextValue>(() => ({
    claims,
    login,
    logout,
    refresh,
    status
  }), [claims, login, logout, refresh, status]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
