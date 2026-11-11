import { diffLines } from "diff";
import { useId, useState } from "react";
import type { Doc } from "@factory/core";

type Line = { kind: "added" | "removed" | "same"; text: string };

// Each body ends with a newline before diffing, so a last line without one still matches.
const withNewline = (body: string) => (body.endsWith("\n") ? body : `${body}\n`);

export function lineDiff(before: string, after: string): Line[] {
  const lines: Line[] = [];
  for (const part of diffLines(withNewline(before), withNewline(after))) {
    const kind = part.added ? "added" : part.removed ? "removed" : "same";
    for (const text of part.value.replace(/\n$/, "").split("\n")) lines.push({ kind, text });
  }
  return lines;
}

const PREFIX: Record<Line["kind"], string> = { added: "+ ", removed: "− ", same: "  " };
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A line diff: the +/− prefix carries the meaning, the token colours repeat it. */
export function DocDiff({ after, before, label }: { after: Doc; before: Doc; label: string }) {
  const lines = lineDiff(before.body, after.body);
  const added = lines.filter((l) => l.kind === "added").length;
  const removed = lines.filter((l) => l.kind === "removed").length;
  return (
    <section className="sf-diff-block" aria-label={`${label} changes from v${before.version} to v${after.version}`}>
      <p className="sf-diff-summary">{added === 0 && removed === 0 ? "No changes" : `${plural(added, "line")} added, ${removed} removed`}</p>
      <pre className="sf-diff">
        {lines.map((line, index) => (
          <span key={index} className={`sf-diff-line sf-diff-${line.kind}`}>{`${PREFIX[line.kind]}${line.text}`}</span>
        ))}
      </pre>
    </section>
  );
}

/**
 * One doc kind's versions: a picker (current by default), the body, and a diff against another version.
 * `to` opens on a version and `from` opens the diff from that version (the stale-gate case).
 * `compare="previous"` swaps the Compare select for a "Compare with v(N-1)" toggle button.
 */
export function DocVersions({ compare: compareMode = "select", docs, from, label, to }: {
  compare?: "select" | "previous";
  docs: readonly Doc[];
  from?: number;
  label: string;
  to?: number;
}) {
  const id = useId();
  // undefined: follow the current version as new versions arrive.
  const [shown, setShown] = useState<number | undefined>(to);
  const [compareFrom, setCompareFrom] = useState<number | undefined>(from);
  const [comparePrevious, setComparePrevious] = useState(false);
  const current = docs[docs.length - 1];
  if (!current) return <p className="sf-empty">No {label.toLowerCase()} yet.</p>;

  const shownVersion = shown ?? current.version;
  const compare = compareMode === "previous" ? (comparePrevious && shownVersion > 1 ? shownVersion - 1 : undefined) : compareFrom;

  const shownDoc = docs.find((d) => d.version === shownVersion);
  const compareDoc = compare === undefined ? undefined : docs.find((d) => d.version === compare);

  return (
    <div className="sf-doc">
      <div className="sf-doc-controls">
        <label htmlFor={`${id}-version`}>{label} version</label>
        <select
          id={`${id}-version`}
          className="sf-select sf-mono"
          value={String(shownVersion)}
          onChange={(event) => setShown(Number(event.target.value))}
        >
          {docs.map((doc) => (
            <option key={doc.version} value={doc.version}>{`v${doc.version}${doc === current ? " (current)" : ""}`}</option>
          ))}
        </select>
        {compareMode === "previous" ? (
          shownVersion > 1 ? (
            <button type="button" className="sf-button" aria-pressed={comparePrevious} onClick={() => setComparePrevious((on) => !on)}>
              Compare with v{shownVersion - 1}
            </button>
          ) : null
        ) : docs.length > 1 ? (
          <>
            <label htmlFor={`${id}-compare`}>Compare with</label>
            <select
              id={`${id}-compare`}
              className="sf-select sf-mono"
              value={compare === undefined ? "" : String(compare)}
              onChange={(event) => setCompareFrom(event.target.value === "" ? undefined : Number(event.target.value))}
            >
              <option value="">Nothing</option>
              {docs.map((doc) => (
                <option key={doc.version} value={doc.version}>{`v${doc.version}`}</option>
              ))}
            </select>
          </>
        ) : null}
        {shownDoc ? <span className="sf-muted">by {shownDoc.author}</span> : null}
      </div>
      {!shownDoc ? (
        <p className="sf-empty">Loading v{shown}…</p>
      ) : compareDoc && compareDoc.version !== shownDoc.version ? (
        <DocDiff before={compareDoc} after={shownDoc} label={label} />
      ) : compare !== undefined && !compareDoc ? (
        <p className="sf-empty">Loading v{compare}…</p>
      ) : (
        <pre className="sf-doc-body">{shownDoc.body}</pre>
      )}
    </div>
  );
}
