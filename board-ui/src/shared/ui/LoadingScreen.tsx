import { ScreenPanel } from "./ScreenPanel";

export function LoadingScreen() {
  return (
    <ScreenPanel>
      <p className="sf-label sf-muted" role="status">Loading…</p>
    </ScreenPanel>
  );
}
