import { useAuth } from "../app/providers/AuthProvider";

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
    <div className="sf-status-screen">
      <div className="sf-status-card">
        <h2>Not a factory owner</h2>
        <p>{NOT_OWNER_MESSAGE}</p>
        <button className="sf-button sf-button-primary" onClick={handleSignOut}>Sign out</button>
      </div>
    </div>
  );
}
