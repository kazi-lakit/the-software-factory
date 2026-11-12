import { Moon, Sun } from "lucide-react";
import { setTheme, useTheme } from "../../lib/theme";

export function ThemeSwitch() {
  const theme = useTheme();
  const next = theme === "light" ? "dark" : "light";
  const Icon = next === "dark" ? Moon : Sun;
  return (
    <button type="button" className="sf-theme-switch" aria-label={`Switch to ${next} mode`} title={`Switch to ${next} mode`} onClick={() => setTheme(next)}>
      <Icon aria-hidden="true" size={20} />
    </button>
  );
}
