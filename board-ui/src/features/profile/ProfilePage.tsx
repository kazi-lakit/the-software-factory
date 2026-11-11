import type { ReactNode } from "react";
import { useAuth } from "../../app/providers/AuthProvider";
import { blocksConfig } from "../../lib/blocks/config";
import { useT } from "../../lib/i18n/LocalizationProvider";
import { ChipList } from "../../shared/ui/Chip";
import { JsonPanel } from "../../shared/ui/JsonPanel";
import { ScreenPanel } from "../../shared/ui/ScreenPanel";
import { useCurrentUser, userDisplayName, userInitials } from "./useCurrentUser";

export function ProfilePage() {
  const me = useCurrentUser();
  const { claims } = useAuth();
  const { t } = useT();
  const profile = me.data?.data;
  const name = userDisplayName(profile);
  const issuedAt = typeof claims?.iat === "number" ? new Date((claims.iat as number) * 1000) : undefined;
  const expiresAt = typeof claims?.exp === "number" ? new Date((claims.exp as number) * 1000) : undefined;

  return (
    <ScreenPanel title={t("profile.title")}>
      <div className="sf-screen-who">
        <span className="sf-avatar" aria-hidden="true">{userInitials(profile)}</span>
        <div>
          <p className="sf-screen-name">{name || (me.isError ? "Session unavailable" : "Unknown user")}</p>
          {profile?.email ? <p className="sf-muted">{profile.email}</p> : null}
          <span className="sf-chip">{me.isSuccess ? "Authenticated" : "Session unavailable"}</span>
        </div>
      </div>

      {me.isLoading ? <p className="sf-muted" role="status">Loading…</p> : null}

      <dl className="sf-screen-facts">
        <Fact label="User ID"><span className="sf-mono">{profile?.itemId || "Not available"}</span></Fact>
        <Fact label="Tenant id (x-blocks-key)"><span className="sf-mono">{blocksConfig.xBlocksKey || "Not available"}</span></Fact>
        <Fact label="Session expires">{expiresAt?.toLocaleString() || "Not available"}</Fact>
        <Fact label="Roles"><ChipList empty="No roles assigned" items={profile?.roles} /></Fact>
        <Fact label={`Permissions (${profile?.permissions?.length ?? 0})`}>
          <ChipList empty="No permissions returned" items={profile?.permissions} />
        </Fact>
        <Fact label="Session">
          <ul className="sf-chips">
            <li className="sf-chip">Signed in {issuedAt ? issuedAt.toLocaleTimeString() : "unknown"}</li>
            <li className="sf-chip">Expires {expiresAt ? expiresAt.toLocaleTimeString() : "unknown"}</li>
          </ul>
        </Fact>
      </dl>

      <details className="sf-screen-raw">
        <summary className="sf-label">View raw response</summary>
        <JsonPanel value={profile ?? me.error ?? me.data} />
      </details>

      <div className="sf-actions">
        <button type="button" className="sf-button" onClick={() => void me.refetch()}>Refresh profile</button>
      </div>
    </ScreenPanel>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
