# Changelog

All notable changes to Oculist. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

The extension went straight from 1.0.0 to 1.5.0 with no intermediate releases, so everything
below the 1.5.0 heading is what landed across that span.

## [1.5.0] — unreleased

The accessibility and reliability release. Not yet published to the Chrome Web Store; new work
keeps landing here until it ships.

### Added

* **github.com is disabled by default.** GitHub re-renders through its own client-side router in
  a way the finder cannot reliably follow, so `Ctrl+F` there falls through to the browser's
  native find. This is a default rather than a lock — the popup's per-site toggle turns it back
  on, and that choice survives extension updates.

* **Vision Accessibility Suite.** Five predefined vision profiles that retune the whole finder in
  one selection:
  * **Low Vision** — extra-large beacons at maximum opacity, floating match-count labels, thick
    high-contrast active borders.
  * **Colour Blindness** (deuteranopia, protanopia, tritanopia) — optimised high-contrast
    palettes plus circular viewport-margin markers, so matches are encoded by shape and position
    as well as colour.
  * **Eye Strain / Comfort** — warm amber palette, slow opacity fades instead of rapid motion.
* **Onboarding setup wizard.** A three-question first-run guide with live-animated mockups that
  picks a starting profile for you.
* **Granular vision settings.** Beacon size, animation speed, match-count labels, motion
  sensitivity (`off` / `reduced` / `full`), border style, and colour palette, each adjustable
  independently of the presets.
* **Override lock protection.** Activating a profile locks the settings it governs and badges
  them in the popup, so an accessibility configuration cannot be undone by accident.
* **WCAG 2.1 AA pass.** Full keyboard navigation with visible `:focus-visible` states, explicit
  ARIA labels throughout, and compliant text contrast ratios.
* **Lite Mode.** Auto-enables on low-core-count devices (or by hand) to lengthen the search
  debounce and swap canvas-heavy beacons for the lightweight CSS-only Spotlight effect.
* **Unsupported-site warnings.** Detects canvas-rendered and virtualised editors (Google Docs,
  Notion) where DOM text search cannot reach the content, and says so instead of silently
  finding nothing.
* **Marketing and store assets.** Landing page, Chrome Web Store promo tiles, and a scripted
  screenshot capture pipeline.

### Changed

* **Infinite-scroll matches no longer vanish.** A debounced MutationObserver re-scans when a
  page swaps text nodes mid-search, which is what virtualised feeds like Reddit do constantly.
* **Stale range re-validation.** Cached match ranges are re-checked before navigation and input
  focus, and the page is re-scanned automatically if they have detached.

### Removed

* **The bookmarklet.** Oculist is a Chrome extension only. `oculist.js` and
  `bookmarklet.min.js` are gone, along with the terser and README-sync steps in the build.
  Its install instructions had already been dropped from the README back in June, and the
  source had fallen behind the extension — the no-match notice, SPA recovery, the colour
  picker fix, and the default blocklist never landed in it. `npm run build` now just
  packages the extension.
* The custom effects plugin API, which evaluated `new Function()` over `localStorage` data.
  Removing it eliminated that sink along with ~150 lines of unreachable code.
* The Soft Glow effect and the sunglasses tab-icon favicon swap.

### Fixed

* **Colour picker stays open while you use it.** Every settings write echoed back into the same
  tab and rebuilt the settings panel, detaching the live colour input and dismissing the native
  colour dialog. Two picks in quick succession made it reproducible every time.
* **Active-match overlays follow a window resize.** In Low Vision, the thick border and
  "Match #n of m" label were positioned once in document coordinates and stayed behind when the
  page reflowed.
* **The popover keeps a stable width.** Neither the no-match notice nor opening the settings
  panel stretches the find bar any more — both lay out inside the width the bar already has.
* **Finder survives client-side navigation** that replaces the whole `<body>` — it remounts and
  re-scans the new page instead of leaving a detached bar behind. (Not sufficient for
  github.com, which is disabled by default for this reason.)
* Publication-readiness audit covering security, memory, and accessibility — including an
  animation frame that was never cancelled on teardown.
* Unknown stored effect values now reset to the default on load rather than leaving the finder
  in a broken state.

## [1.0.0] — 2026-06-24

First packaged release, as both a Chrome extension and a bookmarklet.

### Added

* **High-visibility find-in-page.** Replaces the browser's find bar with animated beacons that
  show you where the match is, rather than relying on a small yellow highlight.
* **Split-node and Shadow DOM search.** Finds text that spans multiple DOM nodes and pierces
  open shadow roots, so matches are found where the native finder gives up.
* **Chrome-aligned matching.** Accent folding and whitespace normalisation, so results line up
  with what the browser's own find would return.
* **Shadow DOM encapsulation.** The finder's own UI is isolated from host page CSS, which keeps
  it legible and correctly laid out on sites with aggressive global styles.
* **Customisable appearance.** Beacon effects, match/active/beacon colours, panel position,
  light/dark/system theme, and scroll behaviour.
* **`Ctrl+F` / `Cmd+F` interception** on all pages, with a deliberate bypass in standalone PWA
  windows.
