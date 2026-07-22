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
  const profileGuidanceText = document.getElementById('profile-guidance');
  const overrideBanner = document.getElementById('override-banner');
  const profileNameBadge = document.getElementById('profile-name-badge');
  const unlockProfileBtn = document.getElementById('unlock-profile');
  const configureDrawer = document.getElementById('configure-drawer');
  const configureSummary = document.querySelector('.configure-summary');

  const effectsSection = document.getElementById('effects-section');
  const effectsLockBadge = document.getElementById('effects-lock-badge');
  const colorsSection = document.getElementById('colors-section');
  const colorsLockBadge = document.getElementById('colors-lock-badge');

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

  // Display name used in the override banner and lock badges.
  const PROFILE_NAMES = {
    'low-vision': 'Low Vision Profile',
    'color-blind-deuteranopia': 'Deuteranopia Profile',
    'color-blind-protanopia': 'Protanopia Profile',
    'color-blind-tritanopia': 'Tritanopia Profile',
    'eye-strain': 'Eye Strain Profile'
  };

  // Helper guidance text shown under the profile dropdown (VA-10).
  const PROFILE_GUIDANCE = {
    'low-vision': 'Maximizes beacon scale (2.25x), adds match-count labels, and draws thick outlines for maximum visibility.',
    'color-blind-deuteranopia': 'Optimized blue/yellow palette with distinct shape indicators for red-green color blindness.',
    'color-blind-protanopia': 'Optimized blue/yellow palette with distinct shape indicators for red-green color blindness.',
    'color-blind-tritanopia': 'Optimized red/cyan palette with shape indicators for blue-yellow color blindness.',
    'eye-strain': 'Warm amber color palette with reduced motion and quiet pulse transitions to prevent visual fatigue.'
  };

  // Mirrors content.js getProfileConstraints() so the popup locks the same
  // sections that the on-page settings panel locks for a given profile.
  function getProfileConstraints(profile) {
    return {
      effectDisabled: profile === 'eye-strain',
      colorsDisabled: !!(profile && (profile === 'eye-strain' || profile.indexOf('color-blind') === 0))
    };
  }

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
  updateProfileGuidance(activeProfile);

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
    updateProfileGuidance(selected);
    await saveSettings();
  });

  // Unlock / Customize Profile - shared by the top banner and the per-section lock badges
  async function unlockToCustom() {
    visionProfileSelect.value = 'custom';
    settings.visionProfile = 'custom';
    updateOverridesUI('custom');
    updateProfileGuidance('custom');
    await saveSettings();
  }

  unlockProfileBtn.addEventListener('click', unlockToCustom);
  document.querySelector('.unlock-effects-btn').addEventListener('click', unlockToCustom);
  document.querySelector('.unlock-colors-btn').addEventListener('click', unlockToCustom);

  // Keep aria-expanded in sync with the drawer's open state
  configureDrawer.addEventListener('toggle', () => {
    configureSummary.setAttribute('aria-expanded', String(configureDrawer.open));
  });

  function updateProfileGuidance(profile) {
    profileGuidanceText.textContent = PROFILE_GUIDANCE[profile] || '';
  }

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
    const isPreset = profile !== 'none' && profile !== 'custom';
    const profileLabel = PROFILE_NAMES[profile] || 'Custom Profile';

    overrideBanner.style.display = isPreset ? 'flex' : 'none';
    if (isPreset) {
      profileNameBadge.textContent = profileLabel;
    }

    // Lock badges mirror content.js's getProfileConstraints() so the popup
    // only locks the sections the active profile actually overrides.
    const constraints = getProfileConstraints(profile);

    effectsSection.classList.toggle('drawer-locked', constraints.effectDisabled);
    effectsLockBadge.style.display = constraints.effectDisabled ? 'flex' : 'none';
    if (constraints.effectDisabled) {
      effectsLockBadge.querySelector('.lock-badge-profile').textContent = profileLabel;
    }

    colorsSection.classList.toggle('drawer-locked', constraints.colorsDisabled);
    colorsLockBadge.style.display = constraints.colorsDisabled ? 'flex' : 'none';
    if (constraints.colorsDisabled) {
      colorsLockBadge.querySelector('.lock-badge-profile').textContent = profileLabel;
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
