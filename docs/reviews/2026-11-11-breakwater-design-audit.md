# Breakwater design fidelity and responsive audit

## Verdict

The application follows the Breakwater visual direction, but **is not a literal implementation of every detail in the supplied Markdown**. It is not accurate to call it 100% identical. The remaining differences below are explicit rather than hidden behind the old design guideline.

Source: `/home/kazi-lakit/Downloads/BREAKWATER-Harbour-Authority-Tynemouth-DESIGN.md`.

## Reference comparison

| Reference | Current implementation | Assessment |
|---|---|---|
| Instrument Serif display, regular weight | Used for display headings throughout landing, workspace, forms and decision panels | Follows direction |
| 122px display, 109.8px line height, -0.018em tracking | Landing scales up to 122px with 0.9 line height; workspace headings 44–56px | Dashboard/mobile adaptation, not an exact scale match |
| DM Mono body at 13.5px / 23.22px | Default body is 13.5px with 1.72 line height | Matches base; documents and mobile inputs have readability adaptations |
| 11px labels, weight 500, 2.2px tracking | Shared label token and class aligned during this audit | Matches shared labels; compact IDs/navigation/buttons use explicit local tracking |
| Harbour blue #4693C3, mist #EEF2F3, violet #5247CD | Used as palette anchors; dark secondary text aligned to #C4CFD6 | Follows palette, with theme surface/tint variants |
| Light background and pale primary text both #EEF2F3 | Dark text on light surfaces, pale text on dark surfaces | Necessary resolution of contradictory reference colours |
| Primary button: pale fill, ink text, 16px padding | Pale fill in dark mode; ink fill in light mode; desktop 12px/18px padding, mobile reductions | Explicit theme/compact-control adaptation, not a literal button recipe |
| Zero corner radius, flat panels | Shared surfaces and controls are square and flat | Matches; native radio indicators remain round for recognition |
| Grid, full bleed composition | Fluid workspace grid with a persistent desktop navigation rail and phone bottom navigation | Product layout adaptation; reference provides no matching screen wireframes |
| 4px base spacing rhythm with listed exceptions | Most structural spacing follows the rhythm; focus rings, label spacing and thin borders use optical exceptions | Follows rhythm rather than a literal exhaustive spacing scale |
| 220ms restrained transitions | Old 150ms row hover and 120ms switch motion corrected to 220ms | Aligned in this audit; reduced motion retained |
| Gradient border shell around main card | Flat hairline borders | **Reference effect not implemented** |
| Perspective grid, slow breathing, subtle pointer drift, CSS fallback and reduced motion | Custom native WebGL shader and CSS fallback | Visual concept implemented |
| Three.js renderer, 46-degree camera, sphere/custom geometry, ambient/key/rim lighting, tone mapping | Native fullscreen shader; no Three.js sphere/light/camera scene | **Reference implementation not reproduced** |

## Inherited rules and bugs corrected

- Shared transition selector accidentally included tab padding, minimum height and tracking, affecting account controls, badges and buttons. Removed geometry from that shared selector and scoped it to tabs.
- Six task progress labels overlapped at 320px. Phone layout now uses a three-column, two-row grid.
- Settings table's absolutely positioned screen-reader header text contributed to page overflow at 320px. Positioned the scroll wrapper so that content stays contained.
- Theme/view switches now have 44px targets; mobile branch removal and card actions also retain touch targets.
- Replaced remaining 9px/10px interface labels with 11px, except the deliberately compact 10px phone project masthead.
- Aligned dark secondary text and shared label typography with the supplied values.
- Removed the two old transition timings and stale account-radius comment. Aligned unused Tailwind colour aliases with the Breakwater palette so they cannot reintroduce the former colours.
- Corrected the header height token to match the actual 72px desktop header.

## Browser verification

Both light and dark modes were exercised using actual application components with isolated sample tasks, versioned documents, questions, events and factories. The live public sign-in page was checked separately. The live session was signed out, so this audit does **not** claim authenticated live-data verification.

| Screen/state | Widths in CSS pixels | Themes | Result after fixes |
|---|---|---|---|
| Board lanes | 320, 360, 390, 768, 1440 | Light and dark | No page-wide horizontal overflow |
| All stages | 320, 390, 1440 | Light and dark | Status strip/stack remains contained |
| Spec decision | 320, 390, 1440 | Light and dark | No clipped progress labels; actions reachable |
| Question/answer | 320, 390, 1440 | Light and dark | Options/explanations and action bar contained |
| History | 320, 390, 1440 | Light and dark | Table scroll stays inside its wrapper |
| Settings | 320, 390, 1440 | Light and dark | 320px overflow reproduced, fixed and rechecked |
| Expanded repository overrides | 320, 390, 1440 | Light and dark | Controls stay contained |
| New task | 320, 390, 1440 | Light and dark | Fields/actions contained |
| New factory | 320, 390, 1440 | Light and dark | Fields and phone branch controls contained |
| Live public sign-in | 320, 390, 1440 | Light and dark | No page-wide horizontal overflow |

Measurements compare document scroll width against client width; deliberate scrolling inside tables, lane pills and stage strips is allowed. Phone progress labels were also checked for element-level clipping. Screenshots cover the corrected phone decision page in both themes. These are responsive Chromium browser checks, not physical iOS/Android device tests.

## Validation

Retained behavior, keyboard, mobile specificity and colour-contrast tests. Added regression checks for the two-row progress layout, touch-sized segmented controls, shared-control CSS isolation and positioned table wrapper. No runtime dependency was added. Existing production bundle-size warning remains.

Final validation: TypeScript, production build and all 1,119 tests passed.
