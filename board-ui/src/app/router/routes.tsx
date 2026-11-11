import { useEffect, useState } from "react";
import type { ComponentType } from "react";
import { AppShell } from "../AppShell";
import { RedirectIfAuthenticated, RequireAuth, RequireOwner } from "./guards";
import { ErrorPage } from "../../features/auth/ErrorPage";
import { NotFoundPage } from "../../features/auth/NotFoundPage";
import { BoardView } from "../../features/board/BoardView";
import { HistoryView } from "../../features/history/HistoryView";
import { SettingsView } from "../../features/settings/SettingsView";
import { TaskView } from "../../features/task/TaskView";
import { ProfilePage } from "../../features/profile/ProfilePage";
import { CallbackPage } from "../../pages/Callback";
import { LandingPage } from "../../pages/Landing";

type PageProps = { onNavigate: (path: string) => void };

const protectedRoutes: Record<string, ComponentType<PageProps>> = {
  "/": BoardView,
  "/error": ErrorPage,
  "/history": HistoryView,
  "/profile": ProfilePage,
  "/settings": SettingsView
};

export function AppRouter() {
  const [path, setPath] = useState(() => window.location.pathname);
  const [search, setSearch] = useState(() => window.location.search);

  useEffect(() => {
    const onPopState = () => {
      setPath(window.location.pathname);
      setSearch(window.location.search);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  function navigate(nextPath: string) {
    const [nextPathname = "/", queryString = ""] = nextPath.split("?");
    window.history.pushState({}, "", nextPath);
    setPath(nextPathname);
    setSearch(queryString ? `?${queryString}` : "");
  }

  // Never behind RequireAuth: the session does not exist until this page completes it.
  if (path === "/login/callback") {
    return <CallbackPage onNavigate={navigate} />;
  }

  if (path === "/login") {
    const returnTo = new URLSearchParams(search).get("returnTo") || undefined;
    return (
      <RedirectIfAuthenticated onNavigate={navigate}>
        <LandingPage returnTo={returnTo} />
      </RedirectIfAuthenticated>
    );
  }

  // /tasks/<taskId>: one task, shown under the Board view.
  const taskMatch = /^\/tasks\/([^/]+)$/.exec(path);
  const taskId = taskMatch ? decodeSegment(taskMatch[1] ?? "") : undefined;
  const Page = taskId === undefined ? protectedRoutes[path] : undefined;
  if (!taskId && !Page) {
    return <NotFoundPage onNavigate={navigate} />;
  }

  return (
    <RequireAuth currentPath={`${path}${search}`} onNavigate={navigate}>
      <RequireOwner onNavigate={navigate}>
        <AppShell activePath={path} onNavigate={navigate}>
          {taskId ? <TaskView key={taskId} taskId={taskId} onNavigate={navigate} /> : Page ? <Page onNavigate={navigate} /> : null}
        </AppShell>
      </RequireOwner>
    </RequireAuth>
  );
}

function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment) || undefined;
  } catch {
    return undefined;
  }
}
