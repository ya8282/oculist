# Privacy Policy — Oculist

**Last updated:** 2026-07-30

Oculist does not collect, transmit, sell, or share any personal data. There are
no analytics, no tracking, and no external servers.

## What is stored

Oculist stores your preferences — theme, highlight effect, beacon colors,
per-site enable/disable list, and your vision accessibility profile and
settings — using Chrome's
`chrome.storage.sync` API. These settings live in your browser. If you are
signed into Chrome, they sync across your own devices through your Google
account; they are never sent to the developer or any third party.

Oculist ships with `github.com` in the per-site disabled list by default,
because GitHub's client-side navigation prevents the finder from working
reliably there. This is only a starting default — you can enable Oculist on
github.com from the toolbar popup at any time, and that choice is kept across
extension updates. No other site is disabled out of the box.

## Page content

To highlight matches, Oculist reads the text of the page you are actively
viewing when you use the find feature. This reading happens entirely within
your browser. Page content is never transmitted, logged, or stored.

## Permissions

- **activeTab / scripting** — used to display the find overlay on the page you
  are viewing.
- **storage** — used to remember your settings (described above).
- **host access (all sites)** — find-in-page must be able to run on any site
  you choose to search. The extension does not read or send page data anywhere.

## Contact

Questions or concerns? Reach us through the feedback form:
<https://tally.so/r/Xx9GdL>
