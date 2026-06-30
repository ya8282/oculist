# oculist

This Chrome bookmarklet adds a high-visibility page text search experience. When performing searches with the search bar it activates, it instantly locates the matches and fires animated beacons to help you instantly spot text occurrences without interfering with host-page styles, layouts, or security policies.

## How it Works

1. **Activate:** Launch the bookmarklet. A sleek search bar appears in the corner of your viewport (top-right by default).
2. **Search-as-you-Type:** Simply type your search term. Matches are indexed and highlighted across the page instantly using a lightweight, debounced DOM text scanner.
3. **Navigate:** Press **Enter** / **Shift+Enter** or click **▼ ▲** to cycle through matches. The active match scrolls smoothly into view and plays your selected visual animation.
4. **Customize:** Click the settings icon (**⚙**) to choose an effect (Pulse, Spotlight, Ring), reposition the bar (Top-Left, Top-Right, Bottom-Left, Bottom-Right), or toggle themes (Dark/Light). Settings persist across sessions via local storage.
5. **Close:** Press **Escape** or click the **x** (**✕**) to close. All custom highlights, styles, and event listeners are fully purged from the host page.

## Core Refined Architecture

Unlike typical search overlays, oculist is designed to run safely on complex, modern web applications:

* **CSS Custom Highlight API:** Instead of injecting wrapper tags or modifying the DOM structure—which can break React/Vue Single Page Applications (SPAs) and trigger expensive layout reflows—`oculist` registers matches directly with Chrome's native highlight rendering engine.
* **Web Animations API:** All search beacon animations are executed programmatically via JavaScript. This avoids injecting stylesheet `@keyframes`, making the bookmarklet fully compatible with secure websites enforcing strict Content Security Policies (CSPs) that block inline style elements (such as GitHub, Twitter, and Google).
* **Deterministic Navigation State:** Match navigation indices are bound directly to standard in-memory `Range` collections. This ensures the search counter ("Match X of Y") is completely accurate and synchronized, even if you click around the page or change focus manually.
* **Scroll-Locked Beacons:** Animation elements are positioned absolutely using page scroll offsets. When you scroll the page manually or programmatically, the beacon remains physically anchored to the target word rather than floating static on the viewport.

## Installation

1. Download the zip archive of this repository. Click **Code**. Then select **Download ZIP**.
1. Extract the archive to a non-temporary directory.
1. Open Google Chrome and navigate to `chrome://extensions/`.
1. Enable **Developer mode** using the toggle switch in the top-right corner.
1. Click the **Load unpacked** button in the top-left corner.
1. Select the `extension` subdirectory within the unzipped project.
1. The **Oculist** extension is now installed. You can pin it to your toolbar, or trigger it using the **Cmd+Shift+F** (Mac) or **Ctrl+Shift+F** (Windows/Linux) keyboard shortcut.

## Usage

1. Visit any standard HTML page (e.g., [Wikipedia](https://en.wikipedia.org)).
2. Click the **Oculist** bookmark in your Bookmarks bar to activate the overlay.
3. Type your search query. Highlights will display as you type.
4. Press **Enter** or **Shift+Enter** to cycle through matches and trigger animations.

## Custom Animation Plugins

Oculist features a CSP-compliant plugin API that allows you to dynamically register custom highlight animations. Because it avoids `eval()` or `new Function()`, it works seamlessly under the strictest Content Security Policy headers (and Content Scripts context).

To register a custom animation, define a function that acts on a bounding rectangle (`DOMRect`) and register it under a unique ID using `window.Oculist.registerEffect()`:

```javascript
window.Oculist = window.Oculist || {};
window.Oculist.registerEffect('grow-pulse', 'Grow & Pulse', function (rect) {
  if (!rect || rect.width === 0 || rect.height === 0) return;

  var div = document.createElement('div');
  div.className = 'oc-beacon';
  div.style.cssText = [
    'position: absolute',
    'left: ' + (rect.left + window.scrollX) + 'px',
    'top: ' + (rect.top + window.scrollY) + 'px',
    'width: ' + rect.width + 'px',
    'height: ' + rect.height + 'px',
    'border: 2px solid #ec4899',
    'box-shadow: 0 0 10px #ec4899',
    'border-radius: 4px',
    'pointer-events: none',
    'z-index: 2147483643',
    'transform-origin: center'
  ].join(';');
  document.documentElement.appendChild(div);

  div.animate([
    { transform: 'scale(1)', opacity: 1 },
    { transform: 'scale(1.5)', opacity: 0 }
  ], {
    duration: 800,
    easing: 'ease-out',
    fill: 'forwards'
  });

  setTimeout(function () {
    div.remove();
  }, 900);
});
```

Once registered, your custom effect will dynamically appear as a selectable preference button under **Highlight Effect** in the options panel!

## Known Limitations

- **Browser Compatibility:** Chrome 105+ (due to reliance on the native CSS Custom Highlight API).
- **Security Contexts:** Does not traverse or highlight text inside cross-origin `<iframe>` boundaries (enforced by browser sandbox security).
- **State Lifecycle:** Deactivates on page reload (stateless by design).
