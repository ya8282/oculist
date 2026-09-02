# Chrome Web Store submission

How to ship a new version of Oculist to the Chrome Web Store. Every command assumes
you are in the repo root.

The single most common way this goes wrong is uploading a zip whose version is not
higher than what is already published. Start at step 1, not step 2.

---

## 1. Decide the version

The store rejects any upload whose version is not strictly greater than the published
one. Check the current listing in the Developer Console before anything else.

The version lives in **two** files and they must match:

- `extension/manifest.json` -> `version`  (this is the one the store reads)
- `package.json` -> `version`

`build.js` derives the zip filename from `extension/manifest.json`, so a stale zip is
easy to upload by accident. If you bump, rebuild.

```bash
node -p "'manifest: ' + require('./extension/manifest.json').version"
node -p "'package:  ' + require('./package.json').version"
```

Both should print the same number.

Also confirm there is actually something to ship. Test-only and tooling changes do not
enter the zip:

```bash
git diff --stat <last-shipped-tag>..HEAD -- extension/
```

Empty output means no shipped code changed and the store does not need a new version.

Add a `CHANGELOG.md` entry under a new `## [x.y.z]` heading for anything user-facing.

---

## 2. Build the zip

```bash
node build.js
# Extension zip created: dist/oculist---high-visibility-finder-v<version>.zip (11 files)
```

Confirm it contains only runtime source, no tests, docs, `node_modules`, or `.git`:

```bash
unzip -l dist/oculist---high-visibility-finder-v*.zip
```

Expect 11 files: `manifest.json`, `background.js`, `content.js`, `settings-migration.js`,
`popup.html`, `popup.js`, `welcome.html`, `welcome.js`, and the three icons.

Run the suite first; a green suite is the cheapest check that the packaged code is the
code you tested.

```bash
npm test    # expect: pass 308, fail 0
```

Run only one `npm test` at a time. The suite is not robust to concurrent invocations
(see the beads for `oculist-3sx`).

---

## 3. Generate the graphic assets

The promo tiles are generated, not committed. `dist/` is gitignored, so they will not
exist in a fresh clone until you build them.

```bash
npm run promo
# Captured dist/promo-small.png (440x280)
# Captured dist/promo-marquee.png (1400x560)
```

Source lives in `docs/promo-small.html` and `docs/promo-marquee.html`. Edit those, not
the PNGs.

| Asset | Size | Where |
|---|---|---|
| Icon | 128x128 | `extension/icon128.png` |
| Screenshots | 1280x800 | `screenshots/01..05-*.png` |
| Promo tile | 440x280 | `dist/promo-small.png` |
| Marquee (optional) | 1400x560 | `dist/promo-marquee.png` |

Verify sizes rather than trusting filenames:

```bash
for f in dist/promo-*.png screenshots/*.png extension/icon128.png; do
  printf '%s: ' "$f"
  sips -g pixelWidth -g pixelHeight "$f" | awk '/pixelWidth/{w=$2}/pixelHeight/{h=$2}END{print w"x"h}'
done
```

`screenshots/unused/` holds older captures. Do not upload from there.

---

## 4. Store Listing tab

- **Name** (<=45 chars): `Oculist - High-Visibility Finder`
- **Summary** (<=150 chars): the `description` field from `extension/manifest.json`
- **Category**: whatever the listing already uses. Accessibility fits the extension if
  you are ever choosing afresh; do not change it on an existing listing without reason.
- **Description**: lead with the pain point, then grouped feature bullets, then close
  with the local-only privacy line. Pull the feature list from the newest `CHANGELOG.md`
  section so the listing and the release agree.
- Upload the 5 screenshots in numbered order. `01-find-bar` first: the core interaction
  on a real page converts best.

---

## 5. Privacy tab

This is where submissions actually get rejected. The text below is written to match
`PRIVACY.md`; reviewers do compare them, so if you change one, change the other.

### Single purpose

> Oculist is a find-in-page tool. It locates text you search for on the page you are
> currently viewing and makes each match highly visible with high-contrast highlighting
> and animated beacons, so you can spot occurrences without squinting or scrolling
> blindly. Everything it does happens in the tab you are already looking at.

### activeTab

> Used to draw the Oculist find overlay, its search bar, and the match highlights on the
> tab the user is actively viewing, only after the user invokes the extension via the
> toolbar icon or the Ctrl+Shift+F (Command+Shift+F on Mac) keyboard shortcut. It is not
> used to read or act on any tab the user has not invoked Oculist on.

### scripting

> Used to inject and run the extension's own bundled content scripts
> (settings-migration.js and content.js) into the active page. These implement the find
> overlay, the match highlighting, and the beacon effects. Only scripts packaged inside
> the extension are injected; no remote or dynamically fetched code is ever executed.

### storage

> Used to persist the user's own preferences and search terms across sessions and, via
> chrome.storage.sync, across their signed-in Chrome profiles: display and beacon
> settings, per-site enable/disable choices, and any search-term lists the user
> explicitly chooses to save. The in-progress working list is held in
> chrome.storage.session and is discarded when the browser closes. No personal data,
> account identifier, browsing history, or page content is stored. Nothing is sent to
> the developer, who operates no server.

### Host permission (`<all_urls>`)

Declared as the content script's `matches` pattern; there is no separate
`host_permissions` grant. This is the field reviewers push back on, so it names the
triggering behaviour explicitly.

> Oculist declares its content script for <all_urls> because find-in-page is only useful
> if it works on whatever page the user happens to be reading. The content script must
> already be present to listen for the Ctrl+Shift+F command, so the shortcut opens the
> finder instantly rather than requiring a toolbar click first. There is no separate
> host_permissions grant in the manifest.
>
> The content script reads the visible text of the page solely to locate and highlight
> matches. That matching happens entirely in memory in the local browser sandbox. Page
> text is never transmitted, never logged, and never written to storage; it is discarded
> when the overlay closes or the user leaves the page. The extension never modifies the
> page's own content, makes no network requests, and collects no user data.

### Remote code

Answer **No**.

> All code executed by Oculist ships inside the package. The extension makes no network
> requests: the single fetch() call in background.js loads one of the extension's own
> bundled icon files via chrome.runtime.getURL() to draw the greyed-out toolbar icon on
> a disabled site. No script, stylesheet, or module is fetched or evaluated from any
> remote source.

Re-verify that claim before each submission:

```bash
grep -rnE 'fetch\(|XMLHttpRequest|sendBeacon|WebSocket' extension/
```

The only hit should be the `chrome.runtime.getURL` icon load in `background.js`.

### Data usage

Check **no** data categories, and certify all three statements.

Google's disclosure asks what you *collect*, meaning transmit off the user's device.
Oculist has no server and no endpoint, so it collects nothing. `chrome.storage.sync`
moves data through Google's own sync infrastructure to the user's other profiles, never
to the developer.

**Health information** deserves a deliberate look each time, because the setup wizard
asks which vision condition applies. Leaving it unchecked is correct: the answer only
picks a display preset and is never persisted. That is enforced by a test, not merely
intended -- `test/wizard_no_clinical_persistence.test.js` asserts persisted settings
never match `/deuteranopia|protanopia|tritanopia|color[-_]?blind|eye[-_]?strain/i`.
Cite that test if a reviewer asks.

### Privacy policy URL

Use the **raw** URL. Google's crawler wants raw text, and a rendered GitHub blob page
is a silent rejection.

```
https://raw.githubusercontent.com/ya8282/oculist/main/PRIVACY.md
```

Open it in a private window before submitting. If it 404s, `PRIVACY.md` is not on the
default branch yet.

---

## 6. Submit

1. Developer Console -> the Oculist item -> **Package** -> upload the new zip.
2. Fill the Store Listing tab (step 4).
3. Fill the Privacy tab (step 5).
4. Submit for review. Low-permission MV3 extensions typically clear in 24-72h.

---

## 7. After it is approved

Tag the release so the next submission can diff against it:

```bash
git tag -a v<version> -m "v<version>"
git push origin v<version>
```

Without a tag, step 1's "is there anything to ship" check has nothing to compare to.

---

## Known rejection causes

- Version not incremented above the published one. Check the Console first, every time.
- Zip rebuilt from a stale manifest after a last-minute fix. Rebuild, then re-upload.
- Privacy policy URL pointing at the rendered GitHub page instead of the raw URL.
- A vague `<all_urls>` justification. The accepted shape is the specific triggering
  behaviour -- the Ctrl+Shift+F listener needing the script already present -- plus the
  no-collection confirmation. Do not shorten it to "needed for functionality".
- Uploading screenshots from `screenshots/unused/`.
