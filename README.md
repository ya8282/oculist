# oculist

[Chrome Web Store - Oculist](https://chromewebstore.google.com/detail/inghjgagoegkoejncaecgfoagkhidaan?utm_source=item-share-cb)

This Chrome extension adds a high-visibility page text search experience. When performing searches with the search bar it activates, it instantly locates the matches and fires animated beacons to help you instantly spot text occurrences without interfering with host-page styles, layouts, or security policies.

## How it Works

1. **Activate:** Press **Cmd+Shift+F** (Mac) or **Ctrl+Shift+F** (Windows/Linux), or click the Oculist toolbar icon. A sleek search bar appears in the corner of your viewport (top-right by default).
2. **Search-as-you-Type:** Simply type your search term. Matches are indexed and highlighted across the page instantly using a lightweight, debounced DOM text scanner.
3. **Navigate:** Press **Enter** / **Shift+Enter** or click **▼ ▲** to cycle through matches. The active match scrolls smoothly into view and plays your selected visual animation.
4. **Customize:** Click the settings icon (**⚙**) to choose an effect (for example, Anime Laser, Inferno Flame, or Spotlight), reposition the bar (Top-Left, Top-Right, Bottom-Left, Bottom-Right), or toggle themes (Dark/Light/System preference). Settings persist across sessions via local storage.
5. **Close:** Press **Escape** or click the **x** (**✕**) to close. All custom highlights, styles, and event listeners are fully purged from the host page.

## Core Refined Architecture

Unlike typical search overlays, oculist is designed to run safely on complex, modern web applications:

* **CSS Custom Highlight API:** Instead of injecting wrapper tags or modifying the DOM structure—which can break React/Vue Single Page Applications (SPAs) and trigger expensive layout reflows—`oculist` registers matches directly with Chrome's native highlight rendering engine.
* **Web Animations API:** All search beacon animations are executed programmatically via JavaScript. This avoids injecting stylesheet `@keyframes`, making Oculist fully compatible with secure websites enforcing strict Content Security Policies (CSPs) that block inline style elements (such as GitHub, Twitter, and Google).
* **Deterministic Navigation State:** Match navigation indices are bound directly to standard in-memory `Range` collections. This ensures the search counter ("Match X of Y") is completely accurate and synchronized, even if you click around the page or change focus manually.
* **Scroll-Locked Beacons:** Animation elements are positioned absolutely using page scroll offsets. When you scroll the page manually or programmatically, the beacon remains physically anchored to the target word rather than floating static on the viewport.
* **Stale Range Re-validation:** Match ranges can detach from the DOM during dynamic re-renders. Before navigation or input focus, Oculist re-validates cached ranges and scans the page again automatically if they have become stale.

## Vision Accessibility Suite (since v1.5.0)

Oculist features a comprehensive suite of vision-specific enhancements to support users with low vision, color blindness, or eye strain:

* **Onboarding Setup Wizard:** On first installation, a 3-question interactive setup guide displays live-animated mockups to help users calibrate and select their perfect profile settings.
* **Predefined Presets:**
  * **Low Vision:** Enables extra-large (`xl`) scale beacons, maximum opacity, floating active match-count labels, and high-contrast active borders.
  * **Color Blindness (Deuteranopia/Protanopia/Tritanopia):** Switches to optimized, high-contrast color palettes and renders small circular outline markers in the viewport margins for all matches to provide redundant shape encoding.
  * **Eye Strain / Comfort:** Bypasses rapid motion in favor of a soft, slow opacity fade and Sepia/Warm Amber color palettes.
* **Granular Custom Settings:** Adjust individual parameters including beacon size, animation speed, floating match-count labels, motion sensitivity (`off`, `reduced`, `full`), borders, and custom palettes.
* **Lock Override Protection:** Activating an accessibility profile injects a lock overlay in the settings popup to protect users against accidental overrides of accessibility parameters.
* **WCAG 2.1 AA Certified:** Fully keyboard navigable (with clear `:focus-visible` states), screen-reader friendly (using explicit ARIA labels), and compliant with text contrast ratios.

## Reliability & Performance Features (since v1.5.0)

* **MutationObserver Infinite-Scroll Scanning:** Listens for DOM changes and dynamically re-scans match collections when virtual feeds (like Reddit or Twitter) swap text nodes, ensuring highlights never vanish.
* **Lite Mode Auto-Throttling:** Automatically detects low-core count devices (or runs via manual settings) to extend the debounce threshold and replace complex GPU/canvas animations with the lightweight CSS-only "Spotlight" effect.
* **Unsupported Site Override Warnings:** Detects and alerts when visiting canvas-rendered text areas or rich text editors (like Google Docs or Notion) where standard browser DOM traversing and key interception are blocked.


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
2. Press **Cmd+Shift+F** (Mac) or **Ctrl+Shift+F** (Windows/Linux) to activate the overlay.
3. Type your search query. Highlights will display as you type.
4. Press **Enter** or **Shift+Enter** to cycle through matches and trigger animations.

## Known Limitations

- **Browser Compatibility:** Chrome 105+ (due to reliance on the native CSS Custom Highlight API).
- **Security Contexts:** Does not traverse or highlight text inside cross-origin `<iframe>` boundaries (enforced by browser sandbox security).
- **State Lifecycle:** Deactivates on page reload (stateless by design).
