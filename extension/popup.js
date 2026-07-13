// popup.js - Handles enabling/disabling Oculist and vision accessibility settings

document.addEventListener('DOMContentLoaded', async () => {
  const domainEl = document.getElementById('domain-name');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const toggleInput = document.getElementById('toggle-site');
  const shortcutText = document.getElementById('shortcut-text');
  const reloadTip = document.getElementById('reload-tip');
  const toggleLiteMode = document.getElementById('toggle-lite-mode');
  const liteModeText = document.getElementById('lite-mode-text');

  // Vision Accessibility controls
  const visionProfileSelect = document.getElementById('vision-profile');
  const overrideBanner = document.getElementById('override-banner');
  const unlockProfileBtn = document.getElementById('unlock-profile');
  const configureDrawer = document.getElementById('configure-drawer');
  const drawerContent = document.getElementById('drawer-content');

  const beaconSizeSelect = document.getElementById('beacon-size');
  const animationSpeedSelect = document.getElementById('animation-speed');
  const matchLabelsSelect = document.getElementById('match-labels');
  const motionSensitivitySelect = document.getElementById('motion-sensitivity');
  const borderStyleSelect = document.getElementById('border-style');
  const colorPaletteSelect = document.getElementById('color-palette');

  const customColorsGroup = document.getElementById('custom-colors-group');
  const customMatchColor = document.getElementById('custom-match-color');
  const customActiveColor = document.getElementById('custom-active-color');
  const customBeaconColor = document.getElementById('custom-beacon-color');

  const PRESETS = {
    'none': {
      beaconSize: 'm',
      animationSpeed: 'normal',
      textLabels: false,
      motionSensitivity: 'full',
      colorPalette: 'default',
      borderStyle: 'none'
    },
    'low-vision': {
      beaconSize: 'xl',
      animationSpeed: 'slow',
      textLabels: true,
      motionSensitivity: 'full',
      colorPalette: 'default',
      borderStyle: 'thick'
    },
    'color-blind-deuteranopia': {
      beaconSize: 'l',
      animationSpeed: 'normal',
      textLabels: true,
      motionSensitivity: 'full',
      colorPalette: 'deuteranopia',
      borderStyle: 'medium'
    },
    'color-blind-protanopia': {
      beaconSize: 'l',
      animationSpeed: 'normal',
      textLabels: true,
      motionSensitivity: 'full',
      colorPalette: 'protanopia',
      borderStyle: 'medium'
    },
    'color-blind-tritanopia': {
      beaconSize: 'l',
      animationSpeed: 'normal',
      textLabels: true,
      motionSensitivity: 'full',
      colorPalette: 'tritanopia',
      borderStyle: 'medium'
    },
    'eye-strain': {
      beaconSize: 'm',
      animationSpeed: 'slow',
      textLabels: false,
      motionSensitivity: 'reduced',
      colorPalette: 'warm',
      borderStyle: 'none'
    }
  };

  // Detect platform to show the correct shortcut.
  const uaPlatform = navigator.userAgentData && navigator.userAgentData.platform;
  const isMac = uaPlatform
    ? uaPlatform.toLowerCase().includes('mac')
    : navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  shortcutText.textContent = isMac ? '⌘+Shift+F' : 'Ctrl+Shift+F';

  // Load settings initially
  let settings = { disabledSites: [], performanceMode: false, visionProfile: null, visionSettings: {} };
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

  // Populate Lite Mode
  toggleLiteMode.checked = !!settings.performanceMode;
  liteModeText.textContent = toggleLiteMode.checked ? 'On' : 'Off';

  toggleLiteMode.addEventListener('change', async () => {
    liteModeText.textContent = toggleLiteMode.checked ? 'On' : 'Off';
    settings.performanceMode = toggleLiteMode.checked;
    await saveSettings();
  });

  // Populate Vision Profile
  const activeProfile = settings.visionProfile || 'none';
  visionProfileSelect.value = activeProfile;

  // Ensure visionSettings exist
  if (!settings.visionSettings) {
    settings.visionSettings = {};
  }
  
  // Fill custom settings fields
  updateCustomFieldsUI(settings.visionSettings);
  updateOverridesUI(activeProfile);

  // Profile Change Listener
  visionProfileSelect.addEventListener('change', async () => {
    const selected = visionProfileSelect.value;
    settings.visionProfile = selected === 'none' ? null : selected;

    if (selected !== 'custom') {
      const presetValues = PRESETS[selected] || PRESETS['none'];
      settings.visionSettings = {
        ...settings.visionSettings,
        ...presetValues
      };
      updateCustomFieldsUI(settings.visionSettings);
    }

    updateOverridesUI(selected);
    await saveSettings();
  });

  // Unlock / Customize Profile
  unlockProfileBtn.addEventListener('click', async () => {
    visionProfileSelect.value = 'custom';
    settings.visionProfile = 'custom';
    updateOverridesUI('custom');
    await saveSettings();
  });

  // Listeners for individual custom inputs
  const customControls = [
    [beaconSizeSelect, 'beaconSize'],
    [animationSpeedSelect, 'animationSpeed'],
    [motionSensitivitySelect, 'motionSensitivity'],
    [borderStyleSelect, 'borderStyle'],
    [colorPaletteSelect, 'colorPalette']
  ];

  customControls.forEach(([selectEl, key]) => {
    selectEl.addEventListener('change', async () => {
      // Force profile to 'custom' when tweaking values
      settings.visionProfile = 'custom';
      visionProfileSelect.value = 'custom';
      updateOverridesUI('custom');

      settings.visionSettings[key] = selectEl.value;
      
      if (key === 'colorPalette') {
        toggleCustomColors(selectEl.value === 'custom');
      }

      await saveSettings();
    });
  });

  // Match labels listener (boolean conversion)
  matchLabelsSelect.addEventListener('change', async () => {
    settings.visionProfile = 'custom';
    visionProfileSelect.value = 'custom';
    updateOverridesUI('custom');

    settings.visionSettings.textLabels = matchLabelsSelect.value === 'true';
    await saveSettings();
  });

  // Color Picker listeners
  const colorPickers = [
    [customMatchColor, 'matchColor'],
    [customActiveColor, 'activeColor'],
    [customBeaconColor, 'beaconColor']
  ];

  colorPickers.forEach(([inputEl, key]) => {
    inputEl.addEventListener('change', async () => {
      settings.visionProfile = 'custom';
      visionProfileSelect.value = 'custom';
      updateOverridesUI('custom');

      if (!settings.visionSettings.customColors) {
        settings.visionSettings.customColors = {};
      }
      settings.visionSettings.customColors[key] = inputEl.value;
      await saveSettings();
    });
  });

  function updateCustomFieldsUI(vs) {
    beaconSizeSelect.value = vs.beaconSize || 'm';
    animationSpeedSelect.value = vs.animationSpeed || 'normal';
    matchLabelsSelect.value = vs.textLabels ? 'true' : 'false';
    motionSensitivitySelect.value = vs.motionSensitivity || 'full';
    borderStyleSelect.value = vs.borderStyle || 'none';
    colorPaletteSelect.value = vs.colorPalette || 'default';

    // Show custom colors group if palette is custom
    toggleCustomColors(vs.colorPalette === 'custom');

    if (vs.customColors) {
      customMatchColor.value = vs.customColors.matchColor || '#fef08a';
      customActiveColor.value = vs.customColors.activeColor || '#f59e0b';
      customBeaconColor.value = vs.customColors.beaconColor || '#fbbf24';
    } else {
      customMatchColor.value = '#fef08a';
      customActiveColor.value = '#f59e0b';
      customBeaconColor.value = '#fbbf24';
    }
  }

  function toggleCustomColors(show) {
    customColorsGroup.style.display = show ? 'block' : 'none';
  }

  function updateOverridesUI(profile) {
    if (profile === 'none' || profile === 'custom') {
      overrideBanner.style.display = 'none';
      drawerContent.classList.remove('drawer-locked');
    } else {
      overrideBanner.style.display = 'flex';
      drawerContent.classList.add('drawer-locked');
    }
  }

  async function saveSettings() {
    try {
      await chrome.storage.sync.set({ 'oc-settings': settings });
      // Notify active tab that settings updated
      if (activeTab && activeTab.id) {
        chrome.tabs.sendMessage(activeTab.id, { action: 'settingsUpdated', settings: settings }).catch(() => {});
      }
    } catch (e) {
      console.error('Failed to save settings:', e);
    }
  }

  // --- Active Tab & Domain settings (Site Toggle) ---
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

  let hostname = '';
  try {
    const urlObj = new URL(activeTab.url);
    hostname = urlObj.hostname;
  } catch (e) {
    domainEl.textContent = 'Invalid URL';
    statusText.textContent = 'Unavailable';
    return;
  }

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
    return;
  }

  domainEl.textContent = hostname;
  toggleInput.disabled = false;

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

  toggleInput.addEventListener('change', async () => {
    const checked = toggleInput.checked;
    
    if (checked) {
      const index = settings.disabledSites.indexOf(hostname);
      if (index !== -1) {
        settings.disabledSites.splice(index, 1);
      }
      reloadTip.style.display = 'block';
    } else {
      if (settings.disabledSites.indexOf(hostname) === -1) {
        settings.disabledSites.push(hostname);
      }
      reloadTip.style.display = 'none';
    }

    await saveSettings();
    updateUI();

    if (!checked) {
      chrome.tabs.sendMessage(activeTab.id, { action: 'destroy' }).catch(() => {});
    }
  });

  // Intercept Cmd+F / Ctrl+F to close popover and trigger Oculist on active tab
  window.addEventListener('keydown', (e) => {
    const isCmdOrCtrl = e.metaKey || e.ctrlKey;
    if (isCmdOrCtrl && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      if (activeTab && activeTab.id) {
        chrome.tabs.sendMessage(activeTab.id, { action: 'toggle' }).catch(() => {});
      }
      window.close();
    }
  });
});
