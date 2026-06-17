// background.js - Listen for the extension toolbar icon click or keyboard shortcut
chrome.action.onClicked.addListener((tab) => {
  // Ignore privileged pages where content scripts cannot run
  if (!tab.url || 
      tab.url.startsWith('chrome://') || 
      tab.url.startsWith('chrome-extension://') || 
      tab.url.startsWith('edge://') || 
      tab.url.startsWith('about:') || 
      tab.url.startsWith('https://chrome.google.com/webstore')) {
    return;
  }

  // Inject content.js dynamically into the active tab's MAIN world
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['content.js'],
    world: 'MAIN'
  });
});
