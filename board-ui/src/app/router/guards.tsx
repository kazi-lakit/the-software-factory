import { useEffect } from "react";
import type { ReactNode } from "react";
import { useAuth } from "../providers/AuthProvider";
import { useCurrentUser } from "../../features/profile/useCurrentUser";
import { isFactoryOwner } from "../../lib/roles";
import { NotOwnerPage } from "../../pages/NotOwner";
import { LoadingScreen } from "../../shared/ui/LoadingScreen";
import { ScreenPanel } from "../../shared/ui/ScreenPanel";

type GuardProps = { children: ReactNode; onNavigate: (path: string) => void };

// Ported from ACR apps/web/src/app/router/guards.tsx.
// currentPath is passed in from router state rather than read live from
// window.location.pathname: under StrictMode's dev-only double-invoked
// effects, the first invocation's pushState() already mutates
// window.location before the second invocation runs, which would nest the
// returnTo query param (e.g. /login?returnTo=%2Flogin) if read live here.
export function RequireAuth({ children, currentPath, onNavigate }: GuardProps & { currentPath: string }) {
  const { status } = useAuth();

  useEffect(() => {
    if (status === "unauthenticated") {
      onNavigate(`/login?returnTo=${encodeURIComponent(currentPath)}`);
    }
  }, [currentPath, status, onNavigate]);

  if (status !== "authenticated") return <LoadingScreen />;
  return <>{children}</>;
}

export function RedirectIfAuthenticated({ children, onNavigate }: GuardProps) {
  const { status } = useAuth();

  useEffect(() => {
    if (status === "authenticated") onNavigate("/");
  }, [status, onNavigate]);

  if (status === "loading" || status === "authenticated") return <LoadingScreen />;
  return <>{children}</>;
}

// Inside RequireAuth: the Board is for the factory owner only. Roles come from
// `iam.me()` and the check fails closed; a profile that could not be read is
// an error to retry, not a missing role. Once a profile has loaded it decides,
// so a later failed refetch does not take the Board away.
export function RequireOwner({ children, onNavigate }: GuardProps) {
  const me = useCurrentUser();

  if (me.data !== undefined) {
    return isFactoryOwner(me.data) ? <>{children}</> : <NotOwnerPage onNavigate={onNavigate} />;
  }
  if (me.isError) {
    return (
      <ScreenPanel title="Could not load your account">
        <p className="sf-screen-text">Check your connection and try again.</p>
        <button type="button" className="sf-button sf-button-primary" onClick={() => void me.refetch()}>Try again</button>
      </ScreenPanel>
    );
  }
  return <LoadingScreen />;
}
