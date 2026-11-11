import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Below 640px every text control must be 44px tall with 16px text, and that styling hangs on the shared
// classes sf-input and sf-select. A control without the class would stay small and make iOS zoom, so this
// scans every <input>, <select> and <textarea> in the non-test sources.

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Counted when this guard was written (T-18). A new control makes the count test fail, so it is looked at.
 *  +2 / +1 file: DependsOnPicker's checkboxes (task dependencies).
 *  +1: FactoryForm's per-stage agent model select (T-19).
 *  -1 / -1 file: FormField deleted (T-23). */
const EXPECTED_CONTROLS = 44;
const EXPECTED_FILES = 12;

type Control = { file: string; tag: string; text: string };

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) out.push(path);
  }
  return out;
}

/** The opening tags of every input, select and textarea in `source`. Tracks {} depth and quotes so `=>` does not end a tag. */
export function scanControls(source: string, file = "inline.tsx"): Control[] {
  const found: Control[] = [];
  for (const match of source.matchAll(/<(input|select|textarea)(?=[\s/>])/g)) {
    let depth = 0;
    let quote = "";
    let i = (match.index ?? 0) + match[0].length;
    const start = match.index ?? 0;
    for (; i < source.length; i++) {
      const ch = source[i] as string;
      if (quote) {
        if (ch === quote) quote = "";
      } else if (depth === 0 && (ch === '"' || ch === "'")) quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) break;
    }
    found.push({ file, tag: match[1] as string, text: source.slice(start, i + 1) });
  }
  return found;
}

/** Why the control is wrong, or null when it is fine. */
export function problemWith(control: Control): string | null {
  const classes = /className="([^"]*)"/.exec(control.text)?.[1]?.split(/\s+/) ?? [];
  if (control.tag === "select") return classes.includes("sf-select") ? null : `${control.file}: <select> lacks sf-select`;
  if (/type="(checkbox|radio|file)"/.test(control.text)) return null;
  return classes.includes("sf-input") ? null : `${control.file}: <${control.tag}> lacks sf-input`;
}

const controls: Control[] = sourceFiles(SRC).flatMap((path) => scanControls(readFileSync(path, "utf8"), relative(SRC, path)));

describe("control audit", () => {
  it("every non-checkbox control has sf-input or sf-select", () => {
    const problems = controls.map(problemWith).filter((p): p is string => p !== null);
    expect(problems).toEqual([]);
  });

  it("the audit finds the expected controls and files", () => {
    expect(controls).toHaveLength(EXPECTED_CONTROLS);
    expect(new Set(controls.map((c) => c.file)).size).toBe(EXPECTED_FILES);
  });

  it("the audit rejects an input without the class", () => {
    const bad = scanControls(`<div><input id="a" onChange={(e) => go(e)} /><select className="sf-mono"></select><textarea className="sf-input" /></div>`);
    expect(bad.map(problemWith)).toEqual(["inline.tsx: <input> lacks sf-input", "inline.tsx: <select> lacks sf-select", null]);
    expect(scanControls(`<input type="checkbox" />`).map(problemWith)).toEqual([null]);
    expect(scanControls(`<input\n  id="x"\n  type="date"\n  className="sf-input"\n/>`).map(problemWith)).toEqual([null]);
  });
});
