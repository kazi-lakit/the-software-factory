# Subtle component rounding proposal

Status: proposed for review. Planning only; no application changes or deployment.

## Goal
Soften component corners consistently across the application. This user request supersedes the original Breakwater requirement for square component geometry.

## Current findings
`board.css` defines `--sf-radius: 0px`; many components consume it. Some controls, switches and navigation surfaces also explicitly set zero radius. Changing one token alone would leave inconsistent corners and could round structural chrome unexpectedly.

## Recommended radius scale
- 4px: compact badges, chips, checkboxes and switch thumb.
- 6px: buttons, icon-button hit areas, text inputs, selects, textareas, segmented-control container and switch track.
- 8px: cards, panels, dropdown menus, dialogs, disclosures with bordered surfaces and table containers.
- 0px: page edges, full-width top/bottom navigation bars, sidebar, table cells and internal separators. Round only the outer edge of a grouped surface.
- Keep radios circular. Keep the single theme icon unboxed. Avoid fully pill-shaped buttons.

## Implementation sequence
1. Introduce shared small/control/surface radius tokens in `board.css`; map the existing radius token to the control default and assign surface tokens explicitly where appropriate.
2. Audit shared and feature-specific CSS, including explicit zero-radius overrides. Apply the scale to buttons, forms, switches, answer options, task cards, settings, menus, tooltips, code blocks and modal surfaces.
3. Round group containers once; ensure active segments fit their container and joined controls have no overlapping rounded internal edges. Clip table/menu backgrounds where needed without clipping focus outlines or popup content.
4. Update existing zero-radius assertions to the approved scale. Retain all control height, focus, contrast and responsive checks; avoid tests that merely duplicate every CSS declaration.
5. Visually review representative enabled, selected, disabled, hover, focus and error states in both themes at 320, 390, 768 and 1440 pixels. Check browser-native select appearance, switches, fixed action bars and long text.

## Completion criteria
Components use a consistent, subtle radius scale. Keyboard focus remains clearly visible, phone targets remain at least 44px where required, and grouped controls/tables have clean outer corners. Typography, palette, spacing and application behavior retain their established values. TypeScript/build and existing relevant suites pass; capture representative screenshots before deployment.

## Order
Apply the shared rounding first, then build the Manage factories layout using those tokens. Each change can be reviewed and verified independently.
