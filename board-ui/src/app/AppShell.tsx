import type { MouseEvent, ReactNode } from "react";
import { useAuth } from "./providers/AuthProvider";
import { useCurrentUser, userDisplayName } from "../features/profile/useCurrentUser";
import { useSettings } from "../features/settings/useSettings";

export const PROJECT_NAME = "the-software-factory";

const views = [
  { href: "/", label: "Board" },
  { href: "/history", label: "History" },
  { href: "/settings", label: "Settings" }
] as const;

type ShellProps = { activePath: string; children: ReactNode; onNavigate: (path: string) => void };

// The signed-in owner's frame: one top bar, then the view. Styling lives in
// board.css (sf-* classes and tokens) so light and dark come from the tokens.
export function AppShell({ activePath, children, onNavigate }: ShellProps) {
  const { logout } = useAuth();
  const me = useCurrentUser();
  const settings = useSettings();
  const user = userDisplayName(me.data?.data);
  const paused = settings.data?.global.paused === true;

  // A plain click stays in the app; a modified or middle click opens the link the browser's way.
  function follow(event: MouseEvent<HTMLAnchorElement>, href: string) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onNavigate(href);
  }

  async function signOut() {
    await logout();
    onNavigate("/login");
  }

  return (
    <div className="sf-app">
      <header className="sf-topbar">
        <span className="sf-project">{PROJECT_NAME}</span>
        <nav className="sf-views" aria-label="Views">
          {views.map((view) => (
            <a
              key={view.href}
              className="sf-view-link"
              href={view.href}
              aria-current={activePath === view.href ? "page" : undefined}
              onClick={(event) => follow(event, view.href)}
            >
              {view.label}
            </a>
          ))}
        </nav>
        <div className="sf-topbar-end">
          {paused ? <span className="sf-paused" role="status">Factory paused</span> : null}
          {user ? <span className="sf-user">{user}</span> : null}
          <button type="button" className="sf-button" onClick={() => void signOut()}>Sign out</button>
        </div>
      </header>
      <main className="sf-main">{children}</main>
    </div>
  );
}
