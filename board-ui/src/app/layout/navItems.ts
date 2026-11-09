import { LayoutGrid, UserRound } from "lucide-react";

export const navItems = [
  { href: "/", labelKey: "nav.board", icon: LayoutGrid },
  { href: "/profile", labelKey: "nav.profile", icon: UserRound }
] as const;
