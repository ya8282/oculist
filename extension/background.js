// background.js - Routes the keyboard command to the finder and handles first-run onboarding.

// Content scripts cannot read chrome.storage.session at all until this is set — it
// defaults to trusted (extension) contexts only. Wrapped in try/catch: older Chrome
// builds don't have setAccessLevel, and the call also returns a promise that can
// reject; either failure must not stop the rest of the worker (listener registration
// below) from running.
try {
  var setAccessLevelResult = chrome.storage.session && chrome.storage.session.setAccessLevel &&
    chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
  if (setAccessLevelResult && typeof setAccessLevelResult.catch === 'function') {
    setAccessLevelResult.catch(function (err) {
      console.error('Oculist: chrome.storage.session.setAccessLevel failed.', err);
    });
  }
} catch (err) {
  console.error('Oculist: chrome.storage.session.setAccessLevel threw.', err);
}

var BLOCKED_PREFIXES = [
  'chrome://', 'chrome-extension://', 'edge://', 'about:',
  'https://chrome.google.com/webstore', 'https://chromewebstore.google.com'
];

function isBlockedUrl(url) {
  if (!url) return true;
  for (var i = 0; i < BLOCKED_PREFIXES.length; i++) {
    if (url.indexOf(BLOCKED_PREFIXES[i]) === 0) return true;
  }
  return false;
}

// Keyboard shortcut (Ctrl/Cmd+Shift+F) opens the finder directly, separate from the popup.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-finder') return;

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length) return;
  const tab = tabs[0];
  if (isBlockedUrl(tab.url)) return;

  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'toggle' });
  } catch (err) {
    // Content script not yet present (page loaded before extension) — inject then toggle.
    await injectAndToggle(tab.id);
  }
});

async function injectAndToggle(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tabId, { action: 'toggle' });
  } catch (err) {
    console.error('Oculist: Failed to inject content script.', err);
  }
}

// Sites Oculist is switched off on out of the box. github.com re-renders through its
// own client-side router in a way the finder cannot reliably follow — the bar goes
// missing and matches stop highlighting mid-session — so it starts disabled and Ctrl+F
// falls through to the browser's native find. This is a default, not a hard block: the
// popup's per-site toggle still turns it on, and seededDefaultBlocklist makes sure a
// later extension update does not undo that choice.
const DEFAULT_DISABLED_SITES = ['github.com'];

// chrome.storage.sync has no transaction or compare-and-swap primitive, so a write
// from another context (the popup, or a concurrent extension update) can still land
// in the gap between this get() and this set() — that residual window cannot be
// closed without a CAS API Chrome doesn't offer. What this DOES buy: every write
// goes through one fresh get() taken immediately before its own set(), so this file's
// own multiple write sites never base a write on a snapshot an earlier write (of ours)
// has already superseded. `mutate` may return `false` to skip the write entirely
// (e.g. nothing to change) — in that case `done` still fires, but with no set() call.
function updateSettings(mutate, done) {
  chrome.storage.sync.get('oc-settings', (data) => {
    const settings = (data && data['oc-settings']) || {};
    const result = mutate(settings);
    if (result === false) {
      if (done) done();
      return;
    }
    chrome.storage.sync.set({ 'oc-settings': settings }, done);
  });
}

function seedDefaultBlocklist(done) {
  updateSettings((settings) => {
    if (settings.seededDefaultBlocklist) return false;
    if (!Array.isArray(settings.disabledSites)) settings.disabledSites = [];
    DEFAULT_DISABLED_SITES.forEach((host) => {
      if (settings.disabledSites.indexOf(host) === -1) settings.disabledSites.push(host);
    });
    settings.seededDefaultBlocklist = true;
  }, done);
}

// First-run onboarding.
chrome.runtime.onInstalled.addListener((details) => {
  // Runs on update too, so existing installs pick the default up once. The flag inside
  // keeps it to exactly once. The performanceMode write below (when it runs) waits for
  // this one to finish first — see updateSettings — so neither write clobbers the other.
  seedDefaultBlocklist(() => {
    if (details.reason === 'install') {
      chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });

      // Auto-enable Lite Mode for low-spec devices. hardwareConcurrency is the only
      // capability signal available in a service worker (no rAF/DOM here for an FPS
      // sample), so cores is the whole heuristic — good enough as a starting default,
      // and the user can always flip it manually in the popup.
      if (navigator.hardwareConcurrency && navigator.hardwareConcurrency < 4) {
        updateSettings((settings) => {
          settings.performanceMode = true;
        });
      }
    }
  });
});

let cachedDisabledImageDatas = null;

async function getDisabledImageDatas() {
  if (cachedDisabledImageDatas) return cachedDisabledImageDatas;
  
  const iconSizes = [16, 48, 128];
  const imageDatas = {};
  for (const size of iconSizes) {
    try {
      const imgUrl = chrome.runtime.getURL(`icon${size}.png`);
      const response = await fetch(imgUrl);
      const blob = await response.blob();
      const imageBitmap = await createImageBitmap(blob);
      
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(imageBitmap, 0, 0, size, size);
      
      // White backing line for contrast
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(3, size * 0.15);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(size * 0.15, size * 0.15);
      ctx.lineTo(size * 0.85, size * 0.85);
      ctx.stroke();
      
      // Red slash line
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = Math.max(1.5, size * 0.08);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(size * 0.15, size * 0.15);
      ctx.lineTo(size * 0.85, size * 0.85);
      ctx.stroke();
      
      imageDatas[size] = ctx.getImageData(0, 0, size, size);
    } catch (e) {
      console.error(`Failed to generate disabled icon for size ${size}:`, e);
    }
  }
  
  cachedDisabledImageDatas = imageDatas;
  return imageDatas;
}

async function updateIcon(tabId, url) {
  if (!url || isBlockedUrl(url)) {
    chrome.action.setIcon({
      tabId: tabId,
      path: {
        "16": "icon16.png",
        "48": "icon48.png",
        "128": "icon128.png"
      }
    }).catch(() => {});
    return;
  }

  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch (e) {
    return;
  }

  chrome.storage.sync.get('oc-settings', async (data) => {
    const settings = (data && data['oc-settings']) || {};
    const disabledSites = settings.disabledSites || [];
    const isDisabled = disabledSites.indexOf(hostname) !== -1;

    try {
      if (isDisabled) {
        const imageDatas = await getDisabledImageDatas();
        if (imageDatas && Object.keys(imageDatas).length > 0) {
          chrome.action.setIcon({ tabId: tabId, imageData: imageDatas }).catch(() => {});
        }
      } else {
        chrome.action.setIcon({
          tabId: tabId,
          path: {
            "16": "icon16.png",
            "48": "icon48.png",
            "128": "icon128.png"
          }
        }).catch(() => {});
      }
    } catch (err) {
      console.error('Oculist: Failed to update action icon:', err);
    }
  });
}

// Listen for tab URL updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') {
    updateIcon(tabId, tab.url || changeInfo.url);
  }
});

// Listen for tab activation changes
chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    // The tab can be gone before this callback runs (closing tabs in a burst activates
    // each neighbour in turn, and a sleeping service worker adds wake-up latency).
    // Reading lastError is what marks it handled — without this Chrome logs
    // "Unchecked runtime.lastError: No tab with id" on the extensions page.
    if (chrome.runtime.lastError) return;
    if (tab && tab.url) {
      updateIcon(activeInfo.tabId, tab.url);
    }
  });
});

// Listen for storage settings changes to sync icon states immediately
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && changes['oc-settings']) {
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        if (tab.id && tab.url) {
          updateIcon(tab.id, tab.url);
        }
      }
    });
  }
});
