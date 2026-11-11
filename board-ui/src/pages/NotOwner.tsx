import { useAuth } from "../app/providers/AuthProvider";
import { ScreenPanel } from "../shared/ui/ScreenPanel";

export const NOT_OWNER_MESSAGE = "This account doesn't have the factory-owner role.";

// A signed-in user without the factory-owner role. Signing out lets them
// sign in with another account.
export function NotOwnerPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { logout } = useAuth();

  async function handleSignOut() {
    await logout();
    onNavigate("/login");
  }

  return (
    <ScreenPanel title="Not a factory owner">
      <p className="sf-screen-text">{NOT_OWNER_MESSAGE}</p>
      <button type="button" className="sf-button sf-button-primary" onClick={handleSignOut}>Sign out</button>
    </ScreenPanel>
  );
}
