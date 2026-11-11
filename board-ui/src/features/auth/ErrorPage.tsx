import { useT } from "../../lib/i18n/LocalizationProvider";
import { ScreenPanel } from "../../shared/ui/ScreenPanel";

export function ErrorPage({ onNavigate }: { onNavigate?: (path: string) => void }) {
  const { t } = useT();
  return (
    <ScreenPanel title={t("common.error")}>
      <p className="sf-screen-text">The page could not finish loading. Try again or return home.</p>
      <a
        href="/"
        className="sf-button sf-button-primary"
        onClick={(event) => {
          event.preventDefault();
          onNavigate?.("/");
        }}
      >
        {t("notFound.home")}
      </a>
    </ScreenPanel>
  );
}
