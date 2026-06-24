# Chrome Web Store Submission Checklist

## Pre-submission

- [ ] `npm test` passes (7/7)
- [ ] Load unpacked in Chrome and smoke-test:
  - [ ] `Ctrl/Cmd+Shift+F` opens the finder overlay (not the popup)
  - [ ] Plain `Ctrl/Cmd+F` opens the overlay on enabled sites
  - [ ] Clicking the toolbar icon opens the popup
  - [ ] Fresh install opens `welcome.html` once
  - [ ] Disabling a site in the popup stops Ctrl+F interception after reload
  - [ ] All six effects fire; dark/light themes switch; settings persist

## Required store assets (MANUAL — not yet created)

- [ ] **Screenshots** (1280×800 or 640×400), 1–5 images:
  - [ ] Find bar open on a normal article page
  - [ ] An active beacon mid-animation
  - [ ] The settings panel (effects / colors / theme)
  - [ ] Two or three different effects for variety
- [ ] **Promo tile** — 440×280
- [x] **Icon** — 128×128 (`icon128.png`)

## Privacy

- [x] `PRIVACY.md` drafted
- [ ] Host it at a public URL (e.g. GitHub raw) and paste into the store's
      "Privacy policy URL" field — **required** because of the `storage` permission.

## Permission justifications (for the review form)

**`activeTab` + `scripting`:** Injects and runs the find overlay on the page the
user is currently viewing.

**`storage`:** Persists user preferences (theme, effect, colors, per-site
on/off). No personal data.

**`<all_urls>` host access:** Find-in-page must work on every site the user may
want to search. The content script auto-injects so the search bar feels native
(works on `Ctrl+F` without first clicking the icon). The extension reads page
text only to locate matches in-browser and transmits nothing.

## Store listing copy

**Name:** Oculist – High-Visibility Finder

**Summary:** Locate search matches instantly with animated visual beacons.

**Description:**

> Oculist makes finding text on a page effortless. Press Ctrl+Shift+F (or
> Cmd+Shift+F on Mac) to open the high-visibility find overlay. As you navigate
> matches, each one gets a dramatic animated beacon — so you can instantly spot
> it, even on long pages.
>
> Features:
> - Six effects: Anime Laser, Spotlight, Warp Drive, Inferno Flame, Lightning, Electron Cloud
> - Dark and light themes
> - Customizable beacon colors (effects adapt to your chosen color)
> - Per-site on/off toggle
> - Works on standard HTML pages, no setup required

## Post-submission

- [ ] Monitor review status
- [ ] Be ready to answer `<all_urls>` questions (justification above)
- [ ] Track store feedback for a v1.0.1 patch
