/** Declarations of the rule whose selector is exactly `selector`, comments stripped. Test helper. */
export function tokens(css: string, selector: string): Record<string, string> {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if ((m[1] ?? "").trim() !== selector) continue;
    const out: Record<string, string> = {};
    for (const d of (m[2] ?? "").split(";")) {
      const k = d.indexOf(":");
      if (k > 0) out[d.slice(0, k).trim()] = d.slice(k + 1).trim();
    }
    return out;
  }
  return {};
}
