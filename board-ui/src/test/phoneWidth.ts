// 360px test helpers (T-33). jsdom does no layout, so a phone test cannot measure horizontal scroll. Instead it
// sets the window to 360px, renders the screen, and checks that no CSS rule that applies at 360px gives a
// rendered class a fixed width wider than the phone's content box. Content inside an `overflow-x: auto`
// container scrolls on purpose (the lane pills, tables, code blocks), so it is skipped.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classesOf, expand, parseItems, type Rule, specificity, stripComments, subject } from "./cssMedia";

const PHONE_WIDTH = 360;

/** The app's board.css as text. */
export const BOARD_CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../app/board.css"), "utf8");

/** Sets `window.innerWidth` to 360 and stubs `matchMedia` for width queries. Returns a function that restores both. */
export function atPhoneWidth(): () => void {
  const width = Object.getOwnPropertyDescriptor(window, "innerWidth");
  const matchMedia = window.matchMedia;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: PHONE_WIDTH, writable: true });
  window.matchMedia = (query: string) => ({
    addEventListener: () => undefined,
    addListener: () => undefined,
    dispatchEvent: () => false,
    matches: matchesAt360(query),
    media: query,
    onchange: null,
    removeEventListener: () => undefined,
    removeListener: () => undefined
  });
  return () => {
    if (width) Object.defineProperty(window, "innerWidth", width);
    else delete (window as { innerWidth?: number }).innerWidth;
    window.matchMedia = matchMedia;
  };
}

function matchesAt360(query: string): boolean {
  const q = query.trim();
  const max = /^\(\s*max-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)$/.exec(q);
  if (max) return Number(max[1]) >= PHONE_WIDTH;
  const min = /^\(\s*min-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)$/.exec(q);
  if (min) return Number(min[1]) <= PHONE_WIDTH;
  return false;
}

/** Base rules plus every `@media (max-width: N)` block with N of 360 or more, selector lists split, in file order. */
export function rulesAt360(css: string): Rule[] {
  const rules: Rule[] = [];
  for (const item of parseItems(stripComments(css))) {
    if (item.kind === "rule") rules.push(...expand([item], () => item.index));
    else {
      const max = /^@media\s*\(\s*max-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)$/.exec(item.prelude.replace(/\s+/g, " ").trim());
      if (max && Number(max[1]) >= PHONE_WIDTH) rules.push(...expand(parseItems(item.inner), () => item.index));
    }
  }
  return rules;
}

const px = (value: string): number | null => {
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(value.trim());
  return m ? Number(m[1]) : null;
};

/** Split on top-level whitespace (not inside parentheses). */
function words(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** Sum of the px minimums of a grid track list, with `repeat(n, …)` expanded. */
function trackMinimum(value: string): number {
  let sum = 0;
  for (const track of words(value)) {
    const repeat = /^repeat\(\s*([^,]+),(.*)\)$/.exec(track);
    if (repeat) {
      const n = Number(repeat[1]);
      sum += (Number.isFinite(n) ? n : 1) * trackMinimum(repeat[2] as string);
      continue;
    }
    const minmax = /^minmax\(\s*([^,]+),/.exec(track);
    sum += px(minmax ? (minmax[1] as string) : track) ?? 0;
  }
  return sum;
}

type Group = "width" | "min-width" | "basis" | "grid";

/** The property group and the px width a declaration asks for, or null when it does not set a fixed width. */
function widthOf(prop: string, value: string): { group: Group; amount: number } | null {
  if (prop === "width" || prop === "min-width") return { amount: px(value) ?? 0, group: prop };
  if (prop === "flex-basis") return { amount: px(value) ?? 0, group: "basis" };
  if (prop === "flex") return { amount: Math.max(0, ...words(value).map((w) => px(w) ?? 0)), group: "basis" };
  if (prop === "grid-template-columns") return { amount: trackMinimum(value), group: "grid" };
  return null;
}

const selectorClasses = (selector: string): string[] => classesOf(selector.replace(/:(is|has|where)\([^()]*\)/g, ""));
const sameSubject = (a: string, b: string): boolean => {
  const ca = classesOf(subject(a)).sort().join(" ");
  return ca !== "" && ca === classesOf(subject(b)).sort().join(" ");
};
const cmp = (a: number[], b: number[]): number => (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0) || (a[2] ?? 0) - (b[2] ?? 0);

/**
 * Rules that apply at 360px and give one of `classes` a fixed `width`, `min-width`, `flex-basis` (or the basis in
 * `flex`) above `limit`, or grid tracks whose px minimums add up to more than `limit`. The default limit is 360px
 * minus the 16px main padding on each side. A finding is dropped when a later or more specific rule on the same
 * subject sets that property to a value that fits. Returns `"<selector> {prop: value}"` strings.
 */
export function tooWide(css: string, classes: Iterable<string>, limit = PHONE_WIDTH - 32): string[] {
  const have = new Set(classes);
  const rules = rulesAt360(css);
  const found: string[] = [];
  rules.forEach((rule, pos) => {
    const all = selectorClasses(rule.selector);
    if (all.length === 0 || !all.every((c) => have.has(c))) return;
    const spec = specificity(rule.selector);
    for (const [prop, value] of Object.entries(rule.decls)) {
      const w = widthOf(prop, value);
      if (!w || w.amount <= limit) continue;
      const fixed = rules.some((other, otherPos) => {
        if (other === rule || !sameSubject(other.selector, rule.selector)) return false;
        // The override only counts when it applies to the rendered tree: every class it names must be rendered.
        if (!selectorClasses(other.selector).every((c) => have.has(c))) return false;
        const order = cmp(specificity(other.selector), spec);
        if (order < 0 || (order === 0 && otherPos < pos)) return false;
        return Object.entries(other.decls).some(([p, v]) => {
          const ow = widthOf(p, v);
          return ow !== null && ow.group === w.group && ow.amount <= limit;
        });
      });
      if (!fixed) found.push(`${rule.selector} {${prop}: ${value}}`);
    }
  });
  return found;
}

/** Rules at 360px that set `overflow-x` (or `overflow`), with the first `overflow-x` keyword they set. */
function overflowRules(css: string, root: Element): { selector: string; value: string; spec: number[]; pos: number }[] {
  const out: { selector: string; value: string; spec: number[]; pos: number }[] = [];
  rulesAt360(css).forEach((rule, pos) => {
    const value = rule.decls["overflow-x"] ?? rule.decls.overflow;
    if (value === undefined) return;
    try {
      root.ownerDocument.createDocumentFragment().querySelector(rule.selector);
    } catch {
      return;
    }
    out.push({ pos, selector: rule.selector, spec: specificity(rule.selector), value: value.split(/\s+/)[0] as string });
  });
  return out;
}

/** Whether the winning `overflow-x` on `el` (the most specific matching rule, later on a tie) scrolls. */
function scrolls(el: Element, rules: ReturnType<typeof overflowRules>): boolean {
  let best: (typeof rules)[number] | null = null;
  for (const r of rules) {
    if (!el.matches(r.selector)) continue;
    if (!best || cmp(r.spec, best.spec) > 0 || (cmp(r.spec, best.spec) === 0 && r.pos > best.pos)) best = r;
  }
  return best !== null && (best.value === "auto" || best.value === "scroll");
}

/** Classes of every element under `root`, skipping elements that are or sit inside an `overflow-x: auto` container. */
export function renderedClasses(root: Element, css: string): Set<string> {
  const rules = overflowRules(css, root);
  const out = new Set<string>();
  const elements = [root, ...root.querySelectorAll("*")];
  const scrolling = new Set(elements.filter((el) => scrolls(el, rules)));
  for (const el of elements) {
    let inside = false;
    for (let at: Element | null = el; at && !inside; at = at.parentElement) inside = scrolling.has(at);
    if (inside) continue;
    for (const c of el.classList) out.add(c);
  }
  return out;
}
