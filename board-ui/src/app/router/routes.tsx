import { useEffect, useState } from "react";
import { AppShell } from "../AppShell";
import { RedirectIfAuthenticated, RequireAuth, RequireOwner } from "./guards";
import { ErrorPage } from "../../features/auth/ErrorPage";
import { NotFoundPage } from "../../features/auth/NotFoundPage";
import { ProfilePage } from "../../features/profile/ProfilePage";
import { CallbackPage } from "../../pages/Callback";
import { LoginPage } from "../../pages/Login";

// Placeholders until the Board, History and Settings views land.
function placeholder(title: string) {
  return function PlaceholderView() {
    return (
      <section>
        <h2>{title}</h2>
      </section>
    );
  };
}

const protectedRoutes = {
  "/": placeholder("Board"),
  "/error": ErrorPage,
  "/history": placeholder("History"),
  "/profile": ProfilePage,
  "/settings": placeholder("Settings")
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
        <LoginPage returnTo={returnTo} />
      </RedirectIfAuthenticated>
    );
  }

  const Page = protectedRoutes[path as keyof typeof protectedRoutes];
  if (!Page) {
    return <NotFoundPage onNavigate={navigate} />;
  }

  return (
    <RequireAuth currentPath={path} onNavigate={navigate}>
      <RequireOwner onNavigate={navigate}>
        <AppShell activePath={path} onNavigate={navigate}>
          <Page />
        </AppShell>
      </RequireOwner>
    </RequireAuth>
  );
}
