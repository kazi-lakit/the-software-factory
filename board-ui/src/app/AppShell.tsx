import type { MouseEvent, ReactNode } from "react";
import { useAuth } from "./providers/AuthProvider";
import { useCurrentUser, userDisplayName } from "../features/profile/useCurrentUser";
import { useSettings } from "../features/settings/useSettings";
import { clearAllUnsent } from "../lib/unsent";
import { blocksSettings } from "../lib/blocksSettings";

export const PROJECT_NAME = "the-software-factory";

const views = [
  { href: "/", label: "Board" },
  { href: "/history", label: "History" },
  { href: "/settings", label: "Settings" }
] as const;

// A task page (/tasks/<id>) belongs to the Board view.
const isCurrent = (href: string, activePath: string): boolean =>
  href === "/" ? activePath === "/" || activePath.startsWith("/tasks/") : activePath === href;

type ShellProps = { activePath: string; children: ReactNode; onNavigate: (path: string) => void };

// The signed-in owner's frame: one top bar, then the view. Styling lives in
// board.css (sf-* classes and tokens) so light and dark come from the tokens.
export function AppShell({ activePath, children, onNavigate }: ShellProps) {
  const { logout } = useAuth();
  const me = useCurrentUser();
  const settings = useSettings();
  const user = userDisplayName(me.data?.data);
  const paused = (settings.data ? blocksSettings(settings.data).factory.paused : false) === true;
  // Without settings the shell cannot say whether the factory runs; it says so rather than show nothing.
  const pauseUnknown = !settings.data && settings.isError;
  const pauseText = paused ? "Factory paused" : pauseUnknown ? "Pause state unknown" : "";
  const pauseClass = paused ? "sf-paused" : pauseUnknown ? "sf-paused-unknown" : "sf-paused-off";

  // A plain click stays in the app; a modified or middle click opens the link the browser's way.
  function follow(event: MouseEvent<HTMLAnchorElement>, href: string) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onNavigate(href);
  }

  // A deliberate sign out drops unsent text (a session that merely ended keeps it). A failed logout
  // still leaves for /login and never becomes an unhandled rejection.
  async function signOut() {
    clearAllUnsent();
    try {
      await logout();
    } catch {
      // logout is best-effort; /login shows whether the session is still alive.
    } finally {
      onNavigate("/login");
    }
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
              aria-current={isCurrent(view.href, activePath) ? "page" : undefined}
              onClick={(event) => follow(event, view.href)}
            >
              {view.label}
            </a>
          ))}
        </nav>
        <div className="sf-topbar-end">
          {/* Always present, so a screen reader hears the change when the factory pauses. */}
          <span className={pauseClass} role="status">{pauseText}</span>
          {user ? <span className="sf-user" title={user}>{user}</span> : null}
          <button type="button" className="sf-button" onClick={() => void signOut()}>Sign out</button>
        </div>
      </header>
      <main className="sf-main">{children}</main>
    </div>
  );
}
