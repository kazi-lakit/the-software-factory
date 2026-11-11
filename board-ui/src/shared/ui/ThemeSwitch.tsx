import { Moon, Sun } from "lucide-react";
import { setTheme, useTheme } from "../../lib/theme";

/** Sun/moon switch in the top bar; it shares the segmented style with the Board view switch. */
export function ThemeSwitch() {
  const theme = useTheme();
  return (
    <div aria-label="Theme" className="sf-segmented sf-theme-switch" role="group">
      <button aria-label="Light theme" aria-pressed={theme === "light"} className="sf-segment" onClick={() => setTheme("light")} type="button">
        <Sun aria-hidden="true" size={16} />
      </button>
      <button aria-label="Dark theme" aria-pressed={theme === "dark"} className="sf-segment" onClick={() => setTheme("dark")} type="button">
        <Moon aria-hidden="true" size={16} />
      </button>
    </div>
  );
}
