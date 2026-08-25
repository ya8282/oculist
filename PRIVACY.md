# Privacy Policy — Oculist

**Last updated:** 2026-08-25

<!-- KEEP IN SYNC WITH docs/privacy.html, the hosted copy the Chrome Web Store's
     Privacy tab points at. If you change one, change the other. -->

Oculist contacts no server, sends nothing to its developer or to any third
party, and has no analytics of any kind. Your settings stay in your own
browser's storage, synced between your own signed-in Chrome profiles by Google
and nowhere else. The text of the page you search is read in the browser,
matched, highlighted, and then forgotten.

## What it stores, and where

Oculist stores three kinds of data, and nothing else:

- **Settings**, in `chrome.storage.sync` under the key `oc-settings`: theme,
  highlight effect, beacon colors, Lite Mode, your vision accessibility
  profile and its individual settings, and the hostnames you have switched
  Oculist off on.
- **Saved search-term lists**, in `chrome.storage.sync`, one key per list
  (`oc-list-<id>`) holding that list's name and terms. A saved list is
  exactly what it sounds like: a named, persisted record of search terms you
  chose to keep, so you can load them again later. Like your settings, it
  syncs across your own signed-in Chrome profiles.
- **The working list of search terms for whatever you're currently
  searching**, in `chrome.storage.session`: the chips shown under the find
  input right now. This is separate from a saved list — it exists only for
  the current browser session, is never synced, and is gone when the browser
  closes.

Oculist writes to no other storage area — it never touches
`chrome.storage.local`. It keeps no history of what pages you searched or
what was on them. It does keep a history of search *terms*, but only the
ones you explicitly ask it to keep: the working list above, gone when the
browser closes, and any saved lists, which persist by design and sync across
your devices for as long as you keep them.

`chrome.storage.sync` is Chrome's own sync, between your own signed-in Chrome
profiles. It does not pass through any server operated by this extension's
author, because there is no such server. It does mean the hostnames in your
disabled-sites list and the terms in any saved list are visible to Google's
sync infrastructure the same way every other synced setting is, and reach
every Chrome profile where you have Oculist installed and Chrome's extension
sync turned on.

## Page content

To highlight matches, Oculist reads the text of the page you are actively
viewing when you use the find feature. That reading happens entirely inside
your browser, in the same tab you are already looking at. Page text is never
transmitted, never logged, and never written to storage: it is matched,
highlighted, and dropped when you close the overlay or leave the page.

## The github.com default

Oculist ships with `github.com` already in the disabled-sites list, because
GitHub's client-side navigation stops the finder working reliably there. This
is only a starting default — you can switch Oculist back on for github.com from
the toolbar popup at any time, and that choice is kept across extension
updates. No other site is disabled out of the box.

## What it does not do

- **No network requests.** There is no endpoint to send data to. The source
  contains exactly one `fetch()`, and it loads one of the extension's own
  bundled icon files from `chrome.runtime.getURL()` in order to draw the
  greyed-out toolbar icon shown on a disabled site. Check it yourself:
  `grep -rE 'fetch\(|XMLHttpRequest|sendBeacon|WebSocket' extension/`
- **No analytics, telemetry, or crash reporting.** None, of any kind.
- **No advertising, and no data sold or shared.**
- **No account, no login, no identifier.**
- **No search history beyond what you ask it to keep.** The working list in
  the find bar is used to match against the current page and is discarded
  when the browser session ends. A saved list is different — saving one is
  how you tell Oculist to keep those terms, and it does, synced across your
  devices, until you delete it.
- **No remote code.** Everything it runs is in the package you installed.

## Permissions, and why each exists

- **`storage`** — to save everything described above: settings, saved lists,
  and the current working list. Nothing else uses it.
- **`activeTab` / `scripting`** — to draw the find overlay and its beacons on
  the tab you are looking at when you invoke Oculist.
- **Host access to all sites (`<all_urls>`)** — find-in-page is only useful if
  it works on whatever page you happen to be reading, so the content script is
  declared for every site rather than a list of approved ones. Oculist reads
  page text to highlight it and sends nothing anywhere.

## Deleting your data

Removing Oculist from `chrome://extensions` deletes everything it stored. There
is nothing else to delete anywhere, because nothing was sent anywhere.

## Contact

Questions or concerns? Reach us through the feedback form:
<https://tally.so/r/Xx9GdL>
