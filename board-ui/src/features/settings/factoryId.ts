/**
 * The factory id the New factory page suggests from a name: lowercase, runs of anything outside a-z0-9 become
 * one hyphen, nothing before the first letter, no hyphen at either end, at most 40 characters.
 */
export function idFromName(name: string): string {
  const hyphenated = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const start = hyphenated.search(/[a-z]/);
  if (start < 0) return "";
  const trim = (s: string) => s.replace(/^-+|-+$/g, "");
  return trim(trim(hyphenated.slice(start)).slice(0, 40));
}
