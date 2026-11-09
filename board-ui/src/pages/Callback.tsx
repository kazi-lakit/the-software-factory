import { useEffect, useRef, useState } from "react";
import { useAuth } from "../app/providers/AuthProvider";
import { completeLogin } from "../lib/blocks/auth";
import { useT } from "../lib/i18n/LocalizationProvider";
import { Alert } from "../shared/ui/Alert";
import { LoadingScreen } from "../shared/ui/LoadingScreen";

export function CallbackPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { refresh } = useAuth();
  const { t } = useT();
  const [error, setError] = useState<string | undefined>();
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    // Once only (StrictMode runs effects twice in dev): the authorization code
    // can be redeemed a single time. Ported from ACR apps/web/src/acr/auth-pages.tsx.
    const failed = () => setError("Sign-in could not be completed. Try again.");
    completeLogin(window.location.href).then(async (result) => {
      if (!result.ok) {
        setError(result.message);
        return;
      }
      try {
        // Learn the session before navigating, so RequireAuth does not bounce
        // the returning user back to /login while the status is still unknown.
        await refresh();
        onNavigate(result.returnTo);
      } catch {
        failed();
      }
    }, failed);
  }, [onNavigate, refresh]);

  if (error) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <h2>{t("auth.failed")}</h2>
          <Alert tone="error">{error}</Alert>
          <button className="primary-button auth-submit" onClick={() => onNavigate("/login")}>{t("auth.back")}</button>
        </div>
      </div>
    );
  }

  return <LoadingScreen />;
}
