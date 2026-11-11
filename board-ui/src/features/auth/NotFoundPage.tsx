import { useT } from "../../lib/i18n/LocalizationProvider";
import { ScreenPanel } from "../../shared/ui/ScreenPanel";

export function NotFoundPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { t } = useT();
  return (
    <ScreenPanel title={t("notFound.title")}>
      <p className="sf-screen-text">{t("notFound.message")}</p>
      <a
        href="/"
        className="sf-button sf-button-primary"
        onClick={(event) => {
          event.preventDefault();
          onNavigate("/");
        }}
      >
        {t("notFound.home")}
      </a>
    </ScreenPanel>
  );
}
