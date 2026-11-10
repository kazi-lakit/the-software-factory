// Test helpers for the phone block of board.css. jsdom does not evaluate media queries, so the phone
// rules are read as text. Also computes selector specificity so a phone rule that an earlier, more
// specific base rule would override in a real browser fails a test (T-17: `.sf-question-title`
// lost to `.sf-view h3` and nothing caught it).

export type Rule = { selector: string; decls: Record<string, string>; index: number };
type Item = { kind: "rule"; selector: string; body: string; index: number } | { kind: "at"; prelude: string; inner: string; index: number };

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

function parseItems(css: string): Item[] {
  const items: Item[] = [];
  let i = 0;
  let index = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open < 0) break;
    const prelude = css.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
      j++;
    }
    const inner = css.slice(open + 1, j - 1);
    if (prelude.startsWith("@")) items.push({ kind: "at", prelude, inner, index: index++ });
    else items.push({ kind: "rule", selector: prelude, body: inner, index: index++ });
    i = j;
  }
  return items;
}

function parseDecls(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of body.split(";")) {
    const k = d.indexOf(":");
    if (k > 0) out[d.slice(0, k).trim()] = d.slice(k + 1).trim();
  }
  return out;
}

/** Split a selector list on commas that are not inside parentheses or brackets. */
function splitList(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function expand(items: Item[], offset: (item: Item) => number): Rule[] {
  const rules: Rule[] = [];
  for (const item of items) {
    if (item.kind !== "rule") continue;
    const decls = parseDecls(item.body);
    for (const selector of splitList(item.selector)) rules.push({ selector, decls, index: offset(item) });
  }
  return rules;
}

const isPhoneQuery = (prelude: string): boolean => /^@media\s*\(\s*max-width\s*:\s*639px\s*\)$/.test(prelude.replace(/\s+/g, " ").trim());

/** Rules inside every `@media (max-width: 639px)` block, selector lists split, in file order. */
export function phoneRules(css: string): Rule[] {
  const rules: Rule[] = [];
  for (const item of parseItems(stripComments(css))) {
    if (item.kind === "at" && isPhoneQuery(item.prelude)) rules.push(...expand(parseItems(item.inner), () => item.index));
  }
  return rules;
}

/** Top-level rules outside any at-rule, in file order. `index` is the item position (shared with phone blocks). */
export function baseRules(css: string): Rule[] {
  return expand(parseItems(stripComments(css)), (item) => item.index);
}

/** Number of top-level `@media (max-width: 639px)` blocks, and the number of top-level items after the last one. */
export function phoneBlockInfo(css: string): { blocks: number; itemsAfterLast: number } {
  const items = parseItems(stripComments(css));
  let last = -1;
  let blocks = 0;
  items.forEach((item, n) => {
    if (item.kind === "at" && isPhoneQuery(item.prelude)) {
      blocks++;
      last = n;
    }
  });
  return { blocks, itemsAfterLast: last < 0 ? 0 : items.length - 1 - last };
}

type Spec = [number, number, number];
const add = (a: Spec, b: Spec): Spec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const cmp = (a: Spec, b: Spec): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** [ids, classes/attributes/pseudo-classes, elements/pseudo-elements] of one complex selector. */
export function specificity(selector: string): Spec {
  let s: Spec = [0, 0, 0];
  let rest = selector;
  // :not(), :is(), :has() take the most specific argument; :where() counts nothing.
  rest = rest.replace(/:(not|is|has|where)\(([^()]*)\)/g, (_m, fn: string, arg: string) => {
    if (fn !== "where") {
      const best = splitList(arg).map(specificity).sort(cmp).pop();
      if (best) s = add(s, best);
    }
    return " ";
  });
  rest = rest.replace(/"[^"]*"|'[^']*'/g, "");
  s = add(s, [(rest.match(/#[\w-]+/g) ?? []).length, 0, 0]);
  s = add(s, [0, (rest.match(/\[[^\]]*\]/g) ?? []).length, 0]);
  rest = rest.replace(/\[[^\]]*\]/g, " ");
  s = add(s, [0, (rest.match(/\.[\w-]+/g) ?? []).length, 0]);
  s = add(s, [0, (rest.match(/(?<!:):(?!:)[\w-]+/g) ?? []).length, 0]);
  s = add(s, [0, 0, (rest.match(/::[\w-]+/g) ?? []).length]);
  const noPseudo = rest.replace(/::?[\w-]+/g, " ").replace(/#[\w-]+|\.[\w-]+/g, " ");
  s = add(s, [0, 0, (noPseudo.match(/(?:^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length]);
  return s;
}

/** The compound after the last combinator. */
function subject(selector: string): string {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i] as string;
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (depth === 0 && /[\s>+~]/.test(ch)) start = i + 1;
  }
  return selector.slice(start).trim();
}

const withoutNot = (compound: string): string => compound.replace(/:(not|is|has|where)\([^()]*\)/g, "");
const classesOf = (compound: string): string[] => [...withoutNot(compound).matchAll(/\.([\w-]+)/g)].map((m) => m[1] as string);
const elementOfCompound = (compound: string): string | null => /^[a-zA-Z][\w-]*/.exec(compound)?.[0] ?? null;
// State qualifiers on the subject: pseudo-classes, pseudo-elements and attribute selectors.
const states = (compound: string): string[] => [...withoutNot(compound).matchAll(/::?[\w-]+(?:\([^)]*\))?|\[[^\]]*\]/g)].map((m) => m[0]);

const related = (a: string, b: string): boolean => a === b || a.startsWith(`${b}-`) || b.startsWith(`${a}-`);

/**
 * Phone rules that a base rule would beat in a real browser: the base rule sets the same property on the
 * same element and is more specific and earlier, or at least as specific and later. `elementOf` maps a phone
 * subject class to its element (for example `sf-question-title` to `h3`) so bare-element base rules like
 * `.sf-view h3` are compared. `neverContains` lists base ancestors that cannot contain the phone subject
 * (for example `.sf-theme-switch` never contains a lane pill), so their bare-element rules are not compared. Base rules for a different state (`:hover`, `[aria-current]`) are skipped.
 */
export function outranked(css: string, elementOf: Record<string, string>, neverContains: string[] = []): string[] {
  const base = baseRules(css);
  const found: string[] = [];
  for (const phone of phoneRules(css)) {
    const subj = subject(phone.selector);
    const classes = classesOf(subj);
    const element = elementOfCompound(subj) ?? classes.map((c) => elementOf[c]).find(Boolean) ?? null;
    const phoneSpec = specificity(phone.selector);
    const phoneStates = states(subj);
    for (const b of base) {
      if (neverContains.some((c) => b.selector.startsWith(`${c} `))) continue;
      const bSubj = subject(b.selector);
      const sameClass = classesOf(bSubj).some((c) => classes.includes(c));
      const bElement = elementOfCompound(bSubj);
      const bareElement = bElement !== null && classesOf(bSubj).length === 0 && element !== null && bElement === element;
      if (!sameClass && !bareElement) continue;
      if (states(bSubj).some((st) => !phoneStates.includes(st))) continue;
      const order = cmp(specificity(b.selector), phoneSpec);
      const loses = b.index < phone.index ? order > 0 : order >= 0;
      if (!loses) continue;
      for (const prop of Object.keys(phone.decls)) {
        if (Object.keys(b.decls).some((p) => related(p, prop))) found.push(`${phone.selector} {${prop}} loses to ${b.selector}`);
      }
    }
  }
  return found;
}
