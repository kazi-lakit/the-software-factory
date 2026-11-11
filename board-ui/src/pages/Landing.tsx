import { useState } from "react";
import { useAuth } from "../app/providers/AuthProvider";
import { DotField } from "../features/landing/DotField";
import { isLoginConfigured } from "../lib/blocks/config";
import { useT } from "../lib/i18n/LocalizationProvider";
import { ThemeSwitch } from "../shared/ui/ThemeSwitch";

type Cell = { title: string; text: string; approve?: boolean };

const STEPS: Cell[] = [
  { title: "Spec", text: "Turns your task into acceptance criteria.", approve: true },
  { title: "Plan", text: "Breaks it into test-first steps.", approve: true },
  { title: "Build", text: "Writes the code, tests first." },
  { title: "Verify", text: "Checks every criterion." },
  { title: "Review", text: "Reads the diff against the spec." },
  { title: "PR", text: "Opens a pull request into dev or stg.", approve: true }
];

const CONTROLS: Cell[] = [
  { title: "Gates", text: "Nothing is built before you approve the spec." },
  { title: "Questions", text: "An agent that can't go on asks you, with options and a recommendation." },
  { title: "Never main", text: "Work reaches dev, stg or main only through a PR you merge." }
];

function Cells({ cells, className }: { cells: Cell[]; className: string }) {
  return (
    <ul className={className}>
      {cells.map((cell) => (
        <li className="sf-landing-cell" key={cell.title}>
          <h3 className="sf-landing-cell-title">{cell.title}</h3>
          <p className="sf-landing-cell-text">{cell.text}</p>
          {cell.approve ? <span className="sf-badge">You approve</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** The signed-out landing page at /login (and at / through the sign-in redirect). */
export function LandingPage({ returnTo }: { returnTo?: string }) {
  const { login } = useAuth();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const { t } = useT();
  const configured = isLoginConfigured();

  async function handleLogin() {
    setError(undefined);
    setPending(true);
    try {
      await login(returnTo);
    } catch (caught) {
      setError((caught as Error).message);
      setPending(false);
    }
  }

  return (
    <div className="sf-landing">
      <DotField />
      <header className="sf-topbar">
        <span className="sf-label sf-landing-brand">the-software-factory</span>
        <div className="sf-topbar-end">
          <ThemeSwitch />
          <button className="sf-button" disabled={!configured || pending} onClick={handleLogin} type="button">Sign in</button>
        </div>
      </header>
      <main className="sf-landing-main">
        <section className="sf-landing-hero">
          <h1 className="sf-landing-title">Write the task. Merge the PR.</h1>
          <p className="sf-landing-lead">
            The software factory turns a plain task into a reviewed pull request. Agents write the spec, plan, build test-first, verify and review. You approve at the gates and merge.
          </p>
          {!configured ? (
            <p className="sf-landing-notice" role="status">
              {t("auth.notConfigured")} <code>{window.location.origin}/login/callback</code>
            </p>
          ) : null}
          <div className="sf-landing-actions">
            <div className="sf-landing-cta">
              <button className="sf-button sf-button-primary" disabled={!configured || pending} onClick={handleLogin} type="button">
                {pending ? t("auth.redirecting") : t("auth.continue")}
              </button>
              {error ? <p className="sf-problem" role="alert">{error}</p> : null}
            </div>
            <a className="sf-button" href="#how-it-works">How it works</a>
          </div>
        </section>
        <section className="sf-landing-section" id="how-it-works">
          <span className="sf-label sf-landing-kicker">01</span>
          <h2 className="sf-landing-heading">How it works</h2>
          <Cells cells={STEPS} className="sf-landing-steps" />
        </section>
        <section className="sf-landing-section">
          <span className="sf-label sf-landing-kicker">02</span>
          <h2 className="sf-landing-heading">You stay in charge</h2>
          <Cells cells={CONTROLS} className="sf-landing-cards" />
        </section>
      </main>
      <footer>
        <p className="sf-label sf-landing-footer">the-software-factory · runs on Blocks</p>
      </footer>
    </div>
  );
}
