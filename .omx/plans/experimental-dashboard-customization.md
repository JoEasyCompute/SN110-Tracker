# Experimental dashboard customization plan

Goal: let users personalize the experimental dashboard locally without affecting the stable layout or server-side data.

## Scope
- Reorder cards within sections.
- Show/hide specific cards within a section.
- Save preferences in `localStorage` only.
- Provide a visible reset-to-default action.
- Keep major sections fixed in v1.

## Sections to support
- Overview
- Key metrics
- Subnet stats
- What changed in the last 24h
- Financial perspective (signal / insight / watchlist)

## Out of scope for v1
- Server-side persistence.
- Cross-section freeform drag/drop.
- Hiding major sections like wallets, pool estimator, charts, or admin controls.

## Implementation steps
1. Assign stable card IDs and section IDs in the experimental render path.
2. Add a localStorage schema for order + hidden-card preferences.
3. Add a customize toggle with drag handles and hide/show controls.
4. Apply preferences on page load and persist edits immediately.
5. Add reset logic and a sane mobile fallback.
6. Verify with targeted tests and browser screenshots.

## Success criteria
- Cards can be reordered and hidden locally in experimental mode.
- Refreshing the page preserves the layout on the same browser.
- Reset restores the default layout.
- Stable dashboard remains unchanged.
