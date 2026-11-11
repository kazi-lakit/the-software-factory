import { ArrowUpRight, Blocks, History, LayoutDashboard, Settings2 } from "lucide-react";
import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useAuth } from "./providers/AuthProvider";
import { useCurrentUser, userDisplayName, userInitials } from "../features/profile/useCurrentUser";
import { useFactories, useSelectedFactory } from "../features/factories/useFactories";
import { useBoard } from "../features/board/useBoard";
import { NEEDS_YOU } from "../features/board/status";
import { ThemeSwitch } from "../shared/ui/ThemeSwitch";
import { useSettings } from "../features/settings/useSettings";
import { clearAllUnsent } from "../lib/unsent";
import { TopBarLeadContext, type Lead } from "./topBarLead";

export const PROJECT_NAME = "the-software-factory";

const views = [
  { href: "/", label: "Board", icon: LayoutDashboard },
  { href: "/history", label: "History", icon: History },
  { href: "/settings", label: "Settings", icon: Settings2 }
] as const;

// A task page (/tasks/<id>) belongs to the Board view.
const isCurrent = (href: string, activePath: string): boolean =>
  href === "/" ? activePath === "/" || activePath.startsWith("/tasks/") : activePath === href || activePath.startsWith(`${href}/`);

type ShellProps = { activePath: string; children: ReactNode; onNavigate: (path: string) => void };

// The signed-in owner's frame: one top bar, then the view. Styling lives in
// board.css (sf-* classes and tokens) so light and dark come from the tokens.
export function AppShell({ activePath, children, onNavigate }: ShellProps) {
  const { logout } = useAuth();
  const [lead, setLead] = useState<Lead | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const signOutRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const me = useCurrentUser();
  const settings = useSettings();
  const profile = me.data?.data;
  const user = userDisplayName(profile);
  const first = profile?.firstName?.trim() || user;
  const [picked] = useSelectedFactory();
  // While tasks load or fail there is no data, so nothing waits and no badge shows.
  const board = useBoard();
  const waiting = (board.data ?? []).filter((t) => NEEDS_YOU.has(t.status) && (picked === "all" || t.factoryId === picked)).length;
  const factories = useFactories();
  const stored = settings.data?.factories ?? {};
  // One factory picked: its own pause. All: every paused factory, by id. A factory without stored settings is running.
  // Once the list is known, settings of a factory that is gone or invalid do not count. While it loads, or if it failed,
  // the settings alone say what is paused, so a paused factory is never shown as running.
  const listKnown = !factories.loading && !(factories.error && factories.byId.size === 0);
  const pausedIds = Object.entries(stored)
    .filter(([id, entry]) => (!listKnown || factories.byId.has(id)) && (picked === "all" || picked === id) && entry.factory.paused === true)
    .map(([id]) => id);
  const listFailed = !factories.loading && Boolean(factories.error) && factories.byId.size === 0;
  const paused = pausedIds.length > 0;
  // Without settings the shell cannot say whether the factory runs; it says so rather than show nothing.
  const pauseUnknown = (!settings.data && settings.isError) || listFailed;
  const pausedText = picked === "all" ? `${pausedIds.length === 1 ? "Factory" : "Factories"} paused: ${pausedIds.join(", ")}` : "Factory paused";
  const pauseText = paused ? pausedText : pauseUnknown ? "Pause state unknown" : "";
  const pauseClass = paused ? "sf-paused" : pauseUnknown ? "sf-paused-unknown" : "sf-paused-off";

  // A plain click stays in the app; a modified or middle click opens the link the browser's way.
  function follow(event: MouseEvent<HTMLAnchorElement>, href: string) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onNavigate(href);
  }

  // The open account menu takes focus on Sign out and closes on a press anywhere outside it and the pill.
  useEffect(() => {
    if (!menuOpen) return;
    signOutRef.current?.focus();
    const onDown = (event: globalThis.MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  function closeMenu(returnFocus: boolean) {
    setMenuOpen(false);
    if (returnFocus) pillRef.current?.focus();
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
    <TopBarLeadContext.Provider value={setLead}>
    <div className={lead ? "sf-app sf-shell-detail" : "sf-app"}>
      <a className="sf-skip-link" href="#workspace-content">Skip to content</a>
      <aside className="sf-sidebar" aria-label="Workspace navigation">
        <a className="sf-sidebar-brand" aria-label="Software Factory home" href="/" onClick={(event) => follow(event, "/")}><Blocks size={30} strokeWidth={1.25} aria-hidden="true" /><span>Software<br /><strong>Factory</strong></span></a>
        <p className="sf-sidebar-label">Your workspace</p>
        <nav className="sf-views" aria-label="Views">
          {views.map((view) => (
            <a
              key={view.href}
              className="sf-view-link"
              href={view.href}
              aria-label={view.label}
              title={view.label}
              aria-current={isCurrent(view.href, activePath) ? "page" : undefined}
              onClick={(event) => follow(event, view.href)}
            >
              <view.icon size={18} aria-hidden="true" /><span>{view.label}</span>
            </a>
          ))}
        </nav>
        <div className="sf-sidebar-note">
          <span className="sf-label">From idea to release</span>
          <p>You set the direction.<br />The factory does the work.</p>
          <a href="/tasks/new" onClick={(event) => follow(event, "/tasks/new")}>Start a task <ArrowUpRight size={16} aria-hidden="true" /></a>
        </div>
        <span className="sf-sidebar-footer">Built on Blocks</span>
      </aside>
      <header className="sf-topbar">
        {lead ? (
          <button type="button" className="sf-topbar-lead" onClick={lead.onClick}>
            {lead.label}
          </button>
        ) : null}
        <a className="sf-project sf-label" href="/" onClick={(event) => follow(event, "/")}>
          {PROJECT_NAME}
        </a>
        <span className="sf-workspace-context"><span className="sf-context-dot" />Workspace / {activePath.startsWith("/settings") ? "Settings" : activePath === "/history" ? "Activity" : "Operations"}</span>
        <div className="sf-topbar-end">
          <ThemeSwitch />
          {waiting > 0 ? <span className="sf-badge">{`${waiting} waiting for you`}</span> : null}
          {/* Always present, so a screen reader hears the change when the factory pauses. */}
          <span className={pauseClass} role="status">{pauseText}</span>
          <div className="sf-account-wrap" ref={wrapRef}>
            <button
              ref={pillRef}
              type="button"
              className="sf-account"
              title={user || undefined}
              aria-label={first ? `Account (${first})` : "Account"}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-controls={menuId}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <span className="sf-avatar" aria-hidden="true">{userInitials(profile)}</span>
              <span className="sf-account-name">{first}</span>
            </button>
            {menuOpen ? (
              <div
                id={menuId}
                role="menu"
                aria-label="Account"
                className="sf-account-menu sf-label"
                onKeyDown={(event) => {
                  if (event.key === "Escape") closeMenu(true);
                }}
              >
                {profile?.email ? (
                  <span role="none" className="sf-account-email">
                    {profile.email}
                  </span>
                ) : null}
                <button ref={signOutRef} type="button" role="menuitem" className="sf-account-menu-item" onClick={() => void signOut()}>
                  Sign out
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>
      <main id="workspace-content" className="sf-main" tabIndex={-1}>{children}</main>
    </div>
    </TopBarLeadContext.Provider>
  );
}
