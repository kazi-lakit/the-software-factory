let guard: (() => boolean) | undefined;

export function setNavigationGuard(next: (() => boolean) | undefined) {
  guard = next;
}

export function allowNavigation(): boolean {
  return guard?.() ?? true;
}
