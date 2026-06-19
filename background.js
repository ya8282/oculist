// background.js - Toggle Oculist when the icon is clicked or command is executed

chrome.action.onClicked.addListener(async (tab) => {
  // Ignore privileged browser/store pages
  if (!tab.url || 
      tab.url.startsWith('chrome://') || 
      tab.url.startsWith('chrome-extension://') || 
      tab.url.startsWith('edge://') || 
      tab.url.startsWith('about:') || 
      tab.url.startsWith('https://chrome.google.com/webstore')) {
    return;
  }

  try {
    // Try to trigger toggle if already loaded
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        if (typeof window.__ocToggle === 'function') {
          window.__ocToggle();
          return true;
        }
        return false;
      },
      world: 'MAIN'
    });

    const wasToggled = results && results[0] && results[0].result;
    if (!wasToggled) {
      // Fallback: inject content.js dynamically and then toggle
      await injectAndToggle(tab.id);
    }
  } catch (err) {
    // Fallback in case of any execution environment error
    await injectAndToggle(tab.id);
  }
});

async function injectAndToggle(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['content.js'],
      world: 'MAIN'
    });
    // Toggle active state after injection
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        if (typeof window.__ocToggle === 'function') {
          window.__ocToggle();
        }
      },
      world: 'MAIN'
    });
  } catch (err) {
    console.error('Oculist: Failed to inject content script.', err);
  }
}
