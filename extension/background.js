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
  }
});
