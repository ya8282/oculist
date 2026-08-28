# Changelog

All notable changes to Oculist. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

The extension went straight from 1.0.0 to 1.5.0 with no intermediate releases, so everything
below the 1.5.0 heading is what landed across that span.

## [Unreleased]

### Added

* **Speed Lines.** A new effect that fires horizontal light streaks blasting outward from the
  match; the streak hue rides your beacon colour.
* **Chrono Tunnel.** A new effect with kaleidoscopic rings rushing outward in a slit-scan smear;
  hue rides your beacon colour within a bounded sweep.
* **Light Cycle.** A new effect where a cycle runs in on right angles, leaving a glowing wall
  that holds, boxes the match, then de-rezzes.
* **Cyber-Vision.** A new effect with scanlines, a sweeping bar, and thermal blocks over the
  match, plus targeting brackets and a readout showing the real match index and count.

## [1.7.0] — 2026-08-25

### Added

* **Multi-term search lists.** The find bar now keeps a working list of search terms shown as
  chips under the input, with one term active at a time. Each chip shows its own hit count.
  Matches for the inactive terms stay visible on the page as dim, background-highlighted marks
  so you can see where they are without switching to them. The working list carries over when
  you move to the next page and only re-runs a search when you ask it to, not on every
  navigation.
* **Named saved lists.** A new list button on the find bar saves the current working list under
  a name, and lets you load, rename, or delete saved lists later. Saved lists persist your
  search terms and sync across your devices — see the updated `PRIVACY.md` for what that means.
* **Lite Mode covers the new list features.** Inactive terms are counted without being
  materialised on the page, and a total match cap keeps the count-only path cheap on large or
  slow pages.
* **Magnifier.** An optional overlay (off by default, next to Match Labels in Custom Vision
  Settings) that renders the currently active match's own text enlarged in a card beside it,
  with the "N of M" counter shown small underneath — useful for telling which highlighted term
  the beacon is on at a glance when several are lit up at once, or just for reading tiny text.
  Sized relative to the match's own font, respects Motion Sensitivity like every other overlay,
  and is aria-hidden since the word is already page content.

### Fixed

* **Find-in-page no longer matches Oculist's own overlay text.** The page scan previously
  descended into Oculist's own find bar and chip row, so searching for a word that also appears
  in the overlay's own UI — for example "of", which appears in the "1 of 3" match counter —
  reported a phantom match that was not actually on the page. The overlay's own DOM is now
  excluded from the scan.
* **Oculist now respects your operating system's "reduce motion" setting.** Previously the
  beacon animation honoured only the extension's own Motion Sensitivity setting, so a system
  configured for reduced motion still got the full effect until you found and changed that
  setting yourself. The OS preference is treated as a downgrade only — it turns the full effect
  into the reduced one, and never overrides an explicit Reduced or Off choice upward. Toggling
  the system setting takes effect on the next match, with no page reload.
* **Scrolling away from a match no longer snaps you back.** The rescan that re-attaches
  highlights after the page's own DOM changes (lazy-loaded images, infinite feeds) also
  re-ran the scroll-into-view, yanking the viewport back to the active match while you were
  reading elsewhere. The rescan now re-highlights without navigating; typing a search and the
  prev/next/replay controls still scroll as before.

## [1.5.0] — 2026-07-31

The accessibility and reliability release. Published to the Chrome Web Store.

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
