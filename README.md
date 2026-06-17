# oculist

A high-performance Chrome bookmarklet that provides a non-disruptive, highly visual find-in-page experience. It maps search matches instantly and fires animated beacons to help you instantly spot text occurrences without interfering with host-page styles, layouts, or security policies.

## How it Works

1. **Activate:** Launch the bookmarklet. A sleek search bar appears in the corner of your viewport (top-right by default).
2. **Search-as-you-Type:** Simply type your search term. Matches are indexed and highlighted across the page instantly using a lightweight, debounced DOM text scanner.
3. **Navigate:** Press **Enter** / **Shift+Enter** or click **▼ ▲** to cycle through matches. The active match scrolls smoothly into view and plays your selected visual animation.
4. **Customize:** Click **⚙** to choose an effect (Pulse, Spotlight, Ring), reposition the bar (Top-Left, Top-Right, Bottom-Left, Bottom-Right), or toggle themes (Dark/Light). Settings persist across sessions via local storage.
5. **Close:** Press **Escape** or click **✕** to close. All custom highlights, styles, and event listeners are fully purged from the host page.

## Core Refined Architecture

Unlike typical search overlays, `oculist` is designed to run safely on complex, modern web applications:

* **CSS Custom Highlight API:** Instead of injecting wrapper tags or modifying the DOM structure—which can break React/Vue Single Page Applications (SPAs) and trigger expensive layout reflows—`oculist` registers matches directly with Chrome's native highlight rendering engine.
* **Web Animations API:** All search beacon animations are executed programmatically via JavaScript. This avoids injecting stylesheet `@keyframes`, making the bookmarklet fully compatible with secure websites enforcing strict Content Security Policies (CSPs) that block inline style elements (such as GitHub, Twitter, and Google).
* **Deterministic Navigation State:** Match navigation indices are bound directly to standard in-memory `Range` collections. This ensures the search counter ("Match X of Y") is completely accurate and synchronized, even if you click around the page or change focus manually.
* **Scroll-Locked Beacons:** Animation elements are positioned absolutely using page scroll offsets. When you scroll the page manually or programmatically, the beacon remains physically anchored to the target word rather than floating static on the viewport.

## Installation

_Coming in Phase 3 — bookmarklet compiler and URL will be pasted here._

## Known Limitations

- **Browser Compatibility:** Chrome 105+ (due to reliance on the native CSS Custom Highlight API).
- **Security Contexts:** Does not traverse or highlight text inside cross-origin `<iframe>` boundaries (enforced by browser sandbox security).
- **State Lifecycle:** Deactivates on page reload (stateless by design).
