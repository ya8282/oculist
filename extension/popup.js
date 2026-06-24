// popup.js - Handles enabling/disabling Oculist next to the address bar

document.addEventListener('DOMContentLoaded', async () => {
  const domainEl = document.getElementById('domain-name');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const toggleInput = document.getElementById('toggle-site');
  const openFinderBtn = document.getElementById('open-finder');
  const shortcutText = document.getElementById('shortcut-text');
  const reloadTip = document.getElementById('reload-tip');

  // Detect platform to show the correct shortcut. Prefer userAgentData (navigator.platform is deprecated).
  const uaPlatform = navigator.userAgentData && navigator.userAgentData.platform;
  const isMac = uaPlatform
    ? uaPlatform.toLowerCase().includes('mac')
    : navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  shortcutText.textContent = isMac ? '⌘+Shift+F' : 'Ctrl+Shift+F';

  // 1. Get the current active tab
  let activeTab;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tabs[0];
  } catch (err) {
    console.error('Failed to query active tab:', err);
  }

  if (!activeTab || !activeTab.url) {
    domainEl.textContent = 'Restricted page';
    statusText.textContent = 'Unavailable';
    return;
  }

  // Parse hostname
  let hostname = '';
  try {
    const urlObj = new URL(activeTab.url);
    hostname = urlObj.hostname;
  } catch (e) {
    domainEl.textContent = 'Invalid URL';
    statusText.textContent = 'Unavailable';
    return;
  }

  // Check if privileged browser page
  const isPrivileged = 
    activeTab.url.startsWith('chrome://') || 
    activeTab.url.startsWith('chrome-extension://') || 
    activeTab.url.startsWith('edge://') || 
    activeTab.url.startsWith('about:') || 
    activeTab.url.startsWith('https://chrome.google.com/webstore') ||
    activeTab.url.startsWith('https://chromewebstore.google.com');

  if (isPrivileged || !hostname) {
    domainEl.textContent = hostname || 'Browser system page';
    statusText.textContent = 'Restricted';
    statusDot.className = 'status-dot disabled';
    toggleInput.disabled = true;
    openFinderBtn.disabled = true;
    openFinderBtn.title = 'Oculist cannot be run on privileged browser system pages.';
    return;
  }

  domainEl.textContent = hostname;
  toggleInput.disabled = false;
  openFinderBtn.disabled = false;

  // 2. Fetch settings and check if domain is blocked
  let settings = { disabledSites: [] };
  try {
    const data = await chrome.storage.sync.get('oc-settings');
    if (data && data['oc-settings']) {
      settings = data['oc-settings'];
      if (!Array.isArray(settings.disabledSites)) {
        settings.disabledSites = [];
      }
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  }

  function isEnabled() {
    return settings.disabledSites.indexOf(hostname) === -1;
  }

  function updateUI() {
    if (isEnabled()) {
      statusDot.className = 'status-dot enabled';
      statusText.textContent = 'Enabled';
      statusText.style.color = 'var(--accent-green)';
      toggleInput.checked = true;
    } else {
      statusDot.className = 'status-dot disabled';
      statusText.textContent = 'Disabled';
      statusText.style.color = 'var(--accent-red)';
      toggleInput.checked = false;
    }
  }

  updateUI();

  // 3. Handle Toggle switch changes
  toggleInput.addEventListener('change', async () => {
    const checked = toggleInput.checked;
    
    if (checked) {
      // Re-enable: Remove from disabledSites
      const index = settings.disabledSites.indexOf(hostname);
      if (index !== -1) {
        settings.disabledSites.splice(index, 1);
      }
      reloadTip.style.display = 'block';
    } else {
      // Disable: Add to disabledSites
      if (settings.disabledSites.indexOf(hostname) === -1) {
        settings.disabledSites.push(hostname);
      }
      reloadTip.style.display = 'none';
    }

    // Save back to storage
    try {
      await chrome.storage.sync.set({ 'oc-settings': settings });
    } catch (e) {
      console.error('Failed to save settings:', e);
    }

    updateUI();

    // If disabled, immediately kill Oculist on the current active page
    if (!checked) {
      chrome.tabs.sendMessage(activeTab.id, { action: 'destroy' }).catch(() => {});
    }
  });

  // 4. Handle Open Finder click
  openFinderBtn.addEventListener('click', async () => {
    // Opening the overlay is an explicit, one-off action — it works even when the site is
    // disabled (the toggle message bypasses the in-page Ctrl+F suppression). We deliberately
    // do NOT re-enable the site here, so the user's per-site preference is left untouched.

    // Toggle active state
    try {
      await chrome.tabs.sendMessage(activeTab.id, { action: 'toggle' });
    } catch (err) {
      // Content script not yet injected (page loaded before extension); inject then toggle
      try {
        await chrome.scripting.executeScript({ target: { tabId: activeTab.id }, files: ['content.js'] });
        await chrome.tabs.sendMessage(activeTab.id, { action: 'toggle' });
      } catch (err2) {
        console.error('Failed to trigger Oculist:', err2);
      }
    }

    // Close popup
    window.close();
  });
});
