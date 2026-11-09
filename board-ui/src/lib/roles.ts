// Ported from ACR apps/web/src/acr/roles.ts (`hasRole`), fail-closed.
const FACTORY_OWNER_ROLE = "factory-owner";

// `me` is the answer of `blocksClient.iam.me()`; the roles are at `data.roles`.
// Anything that is not a `roles` array of strings containing the role counts
// as not an owner. This only gates the UI: Blocks Data rules enforce the role.
export function isFactoryOwner(me: unknown): boolean {
  if (!isRecord(me) || !isRecord(me.data)) return false;
  const roles = me.data.roles;
  return Array.isArray(roles) && roles.every(item => typeof item === "string") && roles.includes(FACTORY_OWNER_ROLE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
