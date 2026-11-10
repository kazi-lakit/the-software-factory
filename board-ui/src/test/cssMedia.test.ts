import { describe, expect, it } from "vitest";
import { baseRules, outranked, phoneOutranked, phoneBlockInfo, phoneRules, specificity } from "./cssMedia";

describe("cssMedia", () => {
  it("phoneRules returns only rules inside the max-width 639px block", () => {
    const css = `/* c */ .a{color:red} @media (max-width: 639px){ .b, .c:not(.d){display:none; margin:0} } .e{x:y}`;
    expect(phoneRules(css).map((r) => r.selector)).toEqual([".b", ".c:not(.d)"]);
    expect(phoneRules(css)[0]?.decls).toEqual({ display: "none", margin: "0" });
  });

  it("phoneRules ignores other media blocks", () => {
    const css = `@media (max-width: 1023px){.a{x:y}} @media (prefers-reduced-motion: reduce){.b{x:y}} @media (max-width:639px){.c{x:y}}`;
    expect(phoneRules(css).map((r) => r.selector)).toEqual([".c"]);
  });

  it("specificity counts ids, classes, attributes, pseudo-classes and :not args, and elements", () => {
    expect(specificity(".sf-view h3")).toEqual([0, 1, 1]);
    expect(specificity('.sf-view .sf-lane[data-selected="false"]')).toEqual([0, 3, 0]);
    expect(specificity(".sf-task a:not(.sf-button)")).toEqual([0, 2, 1]);
    expect(specificity(".a:hover")).toEqual([0, 2, 0]);
    expect(specificity("#x .a::before")).toEqual([1, 1, 1]);
    expect(specificity(".sf-panel-needs-you form")).toEqual([0, 1, 1]);
  });

  it("baseRules returns top-level rules in file order with their index", () => {
    const css = `.a{x:1} @media (max-width: 639px){.p{x:2}} .b,.c{x:3}`;
    expect(baseRules(css).map((r) => [r.selector, r.index])).toEqual([[".a", 0], [".b", 2], [".c", 2]]);
  });

  it("phoneBlockInfo counts the blocks and what follows the last", () => {
    expect(phoneBlockInfo(`.a{x:1} @media (max-width: 639px){.p{x:2}}`)).toEqual({ blocks: 1, itemsAfterLast: 0 });
    expect(phoneBlockInfo(`@media (max-width: 639px){.p{x:2}} .a{x:1}`)).toEqual({ blocks: 1, itemsAfterLast: 1 });
  });

  it("outranked flags a phone rule beaten by an earlier more specific rule", () => {
    const map = { "sf-x": "h3" };
    expect(outranked(`.sf-view h3{margin:0} @media(max-width:639px){.sf-x{margin:8px}}`, map)).toEqual([".sf-x {margin} loses to .sf-view h3"]);
    expect(outranked(`.sf-view h3{margin:0} @media(max-width:639px){.sf-view .sf-x{margin:8px}}`, map)).toEqual([]);
    expect(outranked(`.sf-x{margin:0} @media(max-width:639px){.sf-x{margin:8px}}`, map)).toEqual([]);
    // shorthand versus longhand, and a base rule for another state is skipped
    expect(outranked(`.sf-view h3{margin-top:0} @media(max-width:639px){.sf-x{margin:8px}}`, map)).toHaveLength(1);
    expect(outranked(`.sf-x:hover{margin:0} @media(max-width:639px){.sf-x{margin:8px}}`, map)).toEqual([]);
    // a later base rule of equal specificity also wins
    expect(outranked(`@media(max-width:639px){.sf-x{margin:8px}} .sf-x{margin:0}`, map)).toHaveLength(1);
  });

  it("phoneOutranked flags a later, more specific phone rule over an earlier one that can match the same element", () => {
    const bar = `.sf-action-bar .sf-button{min-height:48px}`;
    const form = `.sf-form .sf-actions .sf-button{min-height:44px}`;
    const wrap = (r: string) => `@media(max-width:639px){${r}}`;
    // H10: same subject class, later rule more specific
    expect(phoneOutranked(wrap(bar + form))).toHaveLength(1);
    // the earlier rule is the more specific one: no flag
    expect(phoneOutranked(wrap(form + bar))).toEqual([]);
    // prefixed with :not, the pair cannot overlap
    expect(phoneOutranked(wrap(bar + `.sf-form .sf-actions:not(.sf-action-bar) .sf-button{min-height:44px}`))).toEqual([]);
    // different property, or unrelated subjects: no flag
    expect(phoneOutranked(wrap(bar + `.sf-form .sf-actions .sf-button{color:red}`))).toEqual([]);
    expect(phoneOutranked(wrap(`.sf-a{min-height:1px} .sf-form .sf-b{min-height:2px}`))).toEqual([]);
  });
});
