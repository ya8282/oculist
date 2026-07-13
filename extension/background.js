// background.js - Routes the keyboard command to the finder and handles first-run onboarding.

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

// First-run onboarding.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });

    // Auto-enable Lite Mode for low-spec devices. hardwareConcurrency is the only
    // capability signal available in a service worker (no rAF/DOM here for an FPS
    // sample), so cores is the whole heuristic — good enough as a starting default,
    // and the user can always flip it manually in the popup.
    if (navigator.hardwareConcurrency && navigator.hardwareConcurrency < 4) {
      chrome.storage.sync.get('oc-settings', (data) => {
        const settings = (data && data['oc-settings']) || {};
        settings.performanceMode = true;
        chrome.storage.sync.set({ 'oc-settings': settings });
      });
    }
  }
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
