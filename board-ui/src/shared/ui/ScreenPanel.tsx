import type { ReactNode } from "react";

// One centred surface panel on the page field, for the screens outside the
// Board (not-owner, sign-in errors, loading, 404, error, profile).
export function ScreenPanel({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <div className="sf-screen">
      <section className="sf-screen-panel">
        {title ? <h1 className="sf-page-title">{title}</h1> : null}
        {children}
      </section>
    </div>
  );
}
