import { Moon, Sun } from "lucide-react";
import { setTheme, useTheme } from "../../lib/theme";

/** Sun/moon switch. Exported for the top bar to place later; AppShell does not render it yet. */
export function ThemeSwitch() {
  const theme = useTheme();
  return (
    <div aria-label="Theme" className="sf-theme-switch" role="group">
      <button aria-label="Light theme" aria-pressed={theme === "light"} onClick={() => setTheme("light")} type="button">
        <Sun aria-hidden="true" size={16} />
      </button>
      <button aria-label="Dark theme" aria-pressed={theme === "dark"} onClick={() => setTheme("dark")} type="button">
        <Moon aria-hidden="true" size={16} />
      </button>
    </div>
  );
}
