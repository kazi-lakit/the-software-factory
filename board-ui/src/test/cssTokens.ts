/**
 * Declarations of the rule whose selector is exactly `selector`, comments stripped. With no such rule, the first rule
 * whose selector list holds `selector` (as in `.a, .b { … }`). Test helper.
 */
export function tokens(css: string, selector: string): Record<string, string> {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = Array.from(clean.matchAll(/([^{}]+)\{([^{}]*)\}/g), (m) => ({ body: m[2] ?? "", prelude: (m[1] ?? "").trim() }));
  const rule =
    rules.find((r) => r.prelude === selector) ??
    rules.find((r) => r.prelude.split(",").map((s) => s.trim()).includes(selector));
  if (!rule) return {};
  const out: Record<string, string> = {};
  for (const d of rule.body.split(";")) {
    const k = d.indexOf(":");
    if (k > 0) out[d.slice(0, k).trim()] = d.slice(k + 1).trim();
  }
  return out;
}
