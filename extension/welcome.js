// welcome.js - Handles the first-install onboarding setup wizard for Oculist

document.addEventListener('DOMContentLoaded', () => {
  const startWizardBtn = document.getElementById('start-wizard');
  const wizardModal = document.getElementById('wizard-modal');
  const backBtn = document.getElementById('wizard-back');
  const nextBtn = document.getElementById('wizard-next');
  const previewEffectSelect = document.getElementById('preview-effect');
  const replayAnimBtn = document.getElementById('trigger-preview-beacon');

  // Captured via its own stable id, not startWizardBtn.parentElement — #start-wizard itself
  // gets destroyed the first time saveProfileAndFinish() rewrites this container's innerHTML
  // (replaced by the completion banner + "Run Setup Again" button), so anything derived from
  // re-querying #start-wizard on a second run would resolve to null. #wizard-hero-banner is
  // the stable container itself and survives every rewrite.
  const heroBanner = document.getElementById('wizard-hero-banner');

  let currentStep = 1;
  let colorBlindAnswer = 'none';
  let lowVisionAnswer = 'false';
  let eyeStrainAnswer = 'false';
  let selectedProfile = 'none';

  // oculist-rnr.12 (corrected scope): step 1's wizard-option buttons now carry a functional
  // data-value ('amber-sky'/'amber-indigo'/'rose-cyan' — see welcome.html near line 247),
  // matching what colorPalette now persists as, so colorBlindAnswer picks that functional
  // value straight up. The PRESETS object below keeps its clinical-shaped keys unchanged
  // ('color-blind-deuteranopia' etc. — in-memory/UI-facing, not persisted, per the agreed
  // design), so this table translates colorBlindAnswer back to the PRESETS key suffix it
  // must interpolate into, at the one place that happens (buildPreviewSummary below).
  const COLOR_ANSWER_TO_PRESET_SUFFIX = {
    'amber-sky': 'deuteranopia',
    'amber-indigo': 'protanopia',
    'rose-cyan': 'tritanopia'
  };

  // oculist-rnr.12: chrome.storage.sync's 'oc-settings.displayPreset' field now holds only
  // functional rendering keys, never a clinical label. selectedProfile/PRESETS/badge and
  // summary text above and below stay in this wizard's own clinical-shortcut vocabulary
  // (that's the UI rnr.13 owns) — this table translates only at the point saveProfileAndFinish()
  // persists the choice.
  // oculist-rnr.16: this used to be its own trimmed copy of settings-migration.js's
  // LEGACY_DISPLAY_PRESET_MAP (identical, minus the 'custom' entry). Referencing the
  // canonical table directly below removes that drift risk, so the 'custom' exclusion is
  // made explicit at the one call site instead (saveProfileAndFinish(), below) — this wizard
  // never sets selectedProfile to 'custom' (see the state machine above; no step maps to
  // it), but if it ever did, saveProfileAndFinish() must still send it to null rather than
  // the canonical table's 'custom' -> 'custom' entry, since 'custom' has no PRESETS-driven
  // meaning here the way it does in popup.js.

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
      colorPalette: 'amber-sky',
      borderStyle: 'medium'
    },
    'color-blind-protanopia': {
      beaconSize: 'l',
      animationSpeed: 'normal',
      textLabels: true,
      motionSensitivity: 'full',
      colorPalette: 'amber-indigo',
      borderStyle: 'medium'
    },
    'color-blind-tritanopia': {
      beaconSize: 'l',
      animationSpeed: 'normal',
      textLabels: true,
      motionSensitivity: 'full',
      colorPalette: 'rose-cyan',
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

  const PALETTE_COLORS = {
    'default': { match: '#fef08a', active: '#f59e0b', beacon: '#fbbf24' },
    'amber-sky': { match: '#fef08a', active: '#0284c7', beacon: '#0284c7' },
    'amber-indigo': { match: '#fef08a', active: '#2563eb', beacon: '#2563eb' },
    'rose-cyan': { match: '#ffcbd1', active: '#06b6d4', beacon: '#06b6d4' },
    'warm': { match: '#fef08a', active: '#d97706', beacon: '#eab308' }
  };

  // oculist-336: single source of truth for the composed vision profile + settings.
  // Resolves selectedProfile by the same priority as before (low-vision > color-blind >
  // eye-strain), then — when low-vision AND a color-vision answer are both present —
  // overlays the user's chosen palette onto the low-vision preset instead of discarding it.
  // colorBlindAnswer already holds the functional palette value ('amber-sky' /
  // 'amber-indigo' / 'rose-cyan', see COLOR_ANSWER_TO_PRESET_SUFFIX above), so it can be
  // assigned to colorPalette directly, no translation needed. displayPreset/selectedProfile
  // stay 'low-vision' either way (sizing/contrast/motion/border still come from that
  // preset) — only colorPalette is overridden.
  // All three consumers below (buildPreviewSummary, runMockupAnimation,
  // saveProfileAndFinish) call this so the summary, the mockup preview, and the persisted
  // settings can never disagree.
  function resolveVisionSettings() {
    let profile;
    if (lowVisionAnswer === 'true') {
      profile = 'low-vision';
    } else if (colorBlindAnswer !== 'none') {
      profile = `color-blind-${COLOR_ANSWER_TO_PRESET_SUFFIX[colorBlindAnswer] || colorBlindAnswer}`;
    } else if (eyeStrainAnswer === 'true') {
      profile = 'eye-strain';
    } else {
      profile = 'none';
    }

    let settings = PRESETS[profile] || PRESETS['none'];

    if (profile === 'low-vision' && colorBlindAnswer !== 'none') {
      settings = { ...settings, colorPalette: colorBlindAnswer };
    }

    return { profile, settings };
  }

  // 1. Show Wizard modal
  function openWizard() {
    resetWizardState();
    wizardModal.style.display = 'flex';
    currentStep = 1;
    showStep(1);
  }

  if (startWizardBtn) {
    startWizardBtn.addEventListener('click', openWizard);
  }

  // Step 1 has two entry points into the same colorBlindAnswer: a named-condition
  // shortcut for a user who already knows their diagnosis, and a sample-comparison
  // path for a user who doesn't (or prefers not to say). Both panels' buttons share
  // the '.wizard-option' class, so the stepsOptions wiring below already saves either
  // one into colorBlindAnswer identically — this block only toggles which panel is
  // visible/focusable, it does not touch selection logic.
  const step1Tabs = [
    { tab: document.getElementById('step1-tab-named'), panel: document.getElementById('step1-panel-named') },
    { tab: document.getElementById('step1-tab-sample'), panel: document.getElementById('step1-panel-sample') }
  ];
  // Single source of truth for switching the active step-1 tab: mouse click, arrow-key
  // navigation, and resetWizardState() all funnel through this one function so there is
  // exactly one place that flips .active/aria-selected/hidden/tabindex together (oculist-rnr.19).
  // Also drives the WAI-ARIA APG roving-tabindex convention for the tablist: the selected
  // tab gets tabindex="0" (the tablist's one Tab stop) and the unselected tab gets
  // tabindex="-1" (removed from the Tab order, reachable only by arrowing over from the
  // selected tab).
  function selectStep1Tab(tab) {
    step1Tabs.forEach(({ tab: t, panel: p }) => {
      const active = t === tab;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', String(active));
      t.setAttribute('tabindex', active ? '0' : '-1');
      p.hidden = !active;
    });
  }

  step1Tabs.forEach(({ tab }) => {
    tab.addEventListener('click', () => selectStep1Tab(tab));
  });

  // APG tabs pattern keyboard support: ArrowRight/ArrowLeft move (and wrap, since there are
  // only two tabs) between tabs, Home/End jump to the first/last. This is "automatic
  // activation" mode (APG's recommended default when revealing the panel is cheap, which it
  // is here) — the arrow key both moves focus AND selects/activates the newly focused tab.
  // Only the keys above call preventDefault(); every other key (notably Tab, and Enter/Space
  // which a <button> already activates natively) passes through untouched so focus still
  // leaves the tablist normally and native button activation keeps working.
  const step1Tablist = document.querySelector('.wizard-tabs');
  if (step1Tablist) {
    step1Tablist.addEventListener('keydown', (e) => {
      const currentIndex = step1Tabs.findIndex(({ tab }) => tab === e.target);
      if (currentIndex === -1) return;

      let newIndex;
      if (e.key === 'ArrowRight') {
        newIndex = (currentIndex + 1) % step1Tabs.length;
      } else if (e.key === 'ArrowLeft') {
        newIndex = (currentIndex - 1 + step1Tabs.length) % step1Tabs.length;
      } else if (e.key === 'Home') {
        newIndex = 0;
      } else if (e.key === 'End') {
        newIndex = step1Tabs.length - 1;
      } else {
        return;
      }

      e.preventDefault();
      const newTab = step1Tabs[newIndex].tab;
      selectStep1Tab(newTab);
      newTab.focus();
    });
  }

  // 2. Click option choices
  const stepsOptions = [
    { step: 1, selector: '#step-1 .wizard-option', save: (val) => { colorBlindAnswer = val; } },
    { step: 2, selector: '#step-2 .wizard-option', save: (val) => { lowVisionAnswer = val; } },
    { step: 3, selector: '#step-3 .wizard-option', save: (val) => { eyeStrainAnswer = val; } }
  ];

  stepsOptions.forEach(({ step, selector, save }) => {
    const opts = document.querySelectorAll(selector);
    opts.forEach(btn => {
      btn.addEventListener('click', () => {
        opts.forEach(o => o.classList.remove('selected'));
        btn.classList.add('selected');
        save(btn.getAttribute('data-value'));
        
        // Auto progress to next step on option selection for smoother onboarding flow
        setTimeout(() => {
          navigateNext();
        }, 300);
      });
    });
  });

  // Restores every piece of in-memory wizard state (answers, selected-option highlighting,
  // and step 1's active tab) back to its opening default. Called both for the initial page
  // load below and from openWizard() on every re-run — without this, re-running the wizard
  // (via "Run Setup Again") would silently inherit whatever answers a prior run left behind
  // for any step the user clicks past with Next, rather than starting fresh each time.
  function resetWizardState() {
    colorBlindAnswer = 'none';
    lowVisionAnswer = 'false';
    eyeStrainAnswer = 'false';
    selectedProfile = 'none';

    // Step 1 always reopens on the named-condition shortcut tab, not wherever a prior run
    // left it. Goes through the same selectStep1Tab() the click/keyboard handlers use, so
    // the roving tabindex (tabindex="0" on named, "-1" on sample) is restored too.
    selectStep1Tab(step1Tabs[0].tab);

    // Default-select the first option in steps 1, 2, and 3, clearing any prior selection.
    ['#step-1 .wizard-option', '#step-2 .wizard-option', '#step-3 .wizard-option'].forEach((selector) => {
      const opts = document.querySelectorAll(selector);
      opts.forEach((o) => o.classList.remove('selected'));
      if (opts[0]) opts[0].classList.add('selected');
    });
  }

  resetWizardState();

  // Navigation Listeners
  backBtn.addEventListener('click', () => {
    if (currentStep > 1) {
      currentStep--;
      showStep(currentStep);
    }
  });

  nextBtn.addEventListener('click', () => {
    navigateNext();
  });

  function navigateNext() {
    if (currentStep < 4) {
      currentStep++;
      showStep(currentStep);
    } else {
      // Save settings and close
      saveProfileAndFinish();
    }
  }

  function showStep(stepNum) {
    currentStep = stepNum;
    
    // Toggle active state
    for (let s = 1; s <= 4; s++) {
      const stepEl = document.getElementById(`step-${s}`);
      if (stepEl) {
        stepEl.classList.toggle('active', s === stepNum);
      }
    }

    // Toggle Back button visibility
    backBtn.style.visibility = stepNum === 1 ? 'hidden' : 'visible';

    // Toggle Next button text
    if (stepNum === 4) {
      nextBtn.textContent = 'Save and Get Started';
      buildPreviewSummary();
      runMockupAnimation();
    } else {
      nextBtn.textContent = 'Next';
    }
  }

  function buildPreviewSummary() {
    const resolved = resolveVisionSettings();
    selectedProfile = resolved.profile;

    // Update Profile badge
    const badge = document.getElementById('profile-badge');
    const badgeTexts = {
      'none': 'None (Standard)',
      'low-vision': 'Low Vision Profile',
      'color-blind-deuteranopia': 'Color Blind (Deuteranopia)',
      'color-blind-protanopia': 'Color Blind (Protanopia)',
      'color-blind-tritanopia': 'Color Blind (Tritanopia)',
      'eye-strain': 'Eye Strain Profile'
    };
    badge.textContent = badgeTexts[selectedProfile] || 'Custom';

    // Build configuration listing
    const vs = resolved.settings;
    const summaryList = document.getElementById('summary-list');
    summaryList.innerHTML = '';

    const displayFields = [
      { label: 'Beacon Sizing', val: vs.beaconSize === 'xl' ? 'Extra Large' : vs.beaconSize === 'l' ? 'Large' : 'Medium' },
      { label: 'Animation Speed', val: vs.animationSpeed.charAt(0).toUpperCase() + vs.animationSpeed.slice(1) },
      { label: 'Match Indicator Label', val: vs.textLabels ? 'Enabled (Match #X of Y)' : 'Disabled' },
      { label: 'Motion Sensitivity', val: vs.motionSensitivity.charAt(0).toUpperCase() + vs.motionSensitivity.slice(1) },
      { label: 'Border Overlay', val: vs.borderStyle.charAt(0).toUpperCase() + vs.borderStyle.slice(1) },
      { label: 'Color Palette', val: vs.colorPalette.charAt(0).toUpperCase() + vs.colorPalette.slice(1) }
    ];

    displayFields.forEach(f => {
      const li = document.createElement('li');
      li.style.display = 'flex';
      li.style.justifyContent = 'space-between';
      li.style.borderBottom = '1px solid #27272a';
      li.style.paddingBottom = '4px';
      
      const lblSpan = document.createElement('span');
      lblSpan.textContent = f.label;
      lblSpan.style.color = '#a1a1aa';

      const valSpan = document.createElement('span');
      valSpan.textContent = f.val;
      valSpan.style.fontWeight = '600';
      valSpan.style.color = '#fafafa';

      li.appendChild(lblSpan);
      li.appendChild(valSpan);
      summaryList.appendChild(li);
    });
  }

  // Preview event listeners
  if (previewEffectSelect) {
    previewEffectSelect.addEventListener('change', () => {
      runMockupAnimation();
    });
  }

  if (replayAnimBtn) {
    replayAnimBtn.addEventListener('click', () => {
      runMockupAnimation();
    });
  }

  function hexToRgba(hex, alpha) {
    if (!hex) return `rgba(245, 158, 11, ${alpha})`;
    const c = hex.replace('#', '');
    const rgb = parseInt(c, 16);
    const r = (rgb >> 16) & 0xff;
    const g = (rgb >> 8) & 0xff;
    const b = (rgb >> 0) & 0xff;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function clearMockupBeacons() {
    const card = document.getElementById('mockup-card');
    const oldBeacons = card.querySelectorAll('.oc-mockup-beacon');
    oldBeacons.forEach(b => b.remove());
  }

  function runMockupAnimation() {
    clearMockupBeacons();

    const target = document.getElementById('preview-target');
    const card = document.getElementById('mockup-card');
    const targetRect = target.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();

    const x = targetRect.left - cardRect.left;
    const y = targetRect.top - cardRect.top;
    const w = targetRect.width;
    const h = targetRect.height;

    const vs = resolveVisionSettings().settings;
    const effect = previewEffectSelect.value;
    const colors = PALETTE_COLORS[vs.colorPalette] || PALETTE_COLORS['default'];
    
    // Apply sizes & speeds
    const sizeScales = { s: 0.7, m: 1.0, l: 1.5, xl: 2.25 };
    const scale = sizeScales[vs.beaconSize] || 1.0;
    const speedFactors = { fast: 0.5, normal: 1.0, slow: 1.75, off: 0 };
    const speedFactor = speedFactors[vs.animationSpeed] || 1.0;
    const duration = (ms) => ms * speedFactor;
    const motion = vs.motionSensitivity;

    // Set mockup highlight target color dynamically
    target.style.background = hexToRgba(colors.match, 0.45);
    target.style.color = colors.active;

    // 1. Draw Active Match Border
    if (vs.borderStyle !== 'none') {
      let bw = '2px';
      if (vs.borderStyle === 'thin') bw = '1px';
      else if (vs.borderStyle === 'thick') bw = '4px';

      const borderEl = document.createElement('div');
      borderEl.className = 'oc-mockup-beacon';
      borderEl.style.cssText = `
        position: absolute;
        left: ${x - 2}px; top: ${y - 2}px;
        width: ${w + 4}px; height: ${h + 4}px;
        border: ${bw} solid ${colors.active};
        border-radius: 4px;
        pointer-events: none;
        z-index: 10;
        box-shadow: 0 0 8px ${colors.active};
        opacity: 0;
      `;
      card.appendChild(borderEl);
      borderEl.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, fill: 'forwards' });
    }

    // 2. Draw Active Match Label
    if (vs.textLabels) {
      const label = document.createElement('div');
      label.className = 'oc-mockup-beacon';
      label.style.cssText = `
        position: absolute;
        background: #0f172a;
        color: #ffffff;
        border: 2px solid ${colors.beacon};
        border-radius: 4px;
        padding: 2px 6px;
        font-family: system-ui, sans-serif;
        font-size: 10px;
        font-weight: 700;
        z-index: 15;
        pointer-events: none;
        white-space: nowrap;
        box-shadow: 0 2px 6px rgba(0,0,0,0.4);
        opacity: 0;
      `;
      label.textContent = 'Match #1 of 1';
      card.appendChild(label);
      
      const lw = 75;
      const lh = 18;
      label.style.left = `${x + w/2 - lw/2}px`;
      label.style.top = `${y - lh - 6}px`;
      label.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 250, fill: 'forwards' });
    }

    // 3. Motion sensitivity
    if (motion === 'off') {
      const staticBorder = document.createElement('div');
      staticBorder.className = 'oc-mockup-beacon';
      staticBorder.style.cssText = `
        position: absolute;
        left: ${x - 3}px; top: ${y - 3}px;
        width: ${w + 6}px; height: ${h + 6}px;
        border: 3px solid ${colors.beacon};
        border-radius: 4px;
        pointer-events: none;
        z-index: 8;
      `;
      card.appendChild(staticBorder);
      return;
    }

    if (motion === 'reduced') {
      if (selectedProfile === 'eye-strain') {
        const sw = Math.max(w + 30, 70) * scale;
        const sh = Math.max(h + 20, 36) * scale;
        const cx = x + w / 2;
        const cy = y + h / 2;

        const overlay = document.createElement('div');
        overlay.className = 'oc-mockup-beacon';
        overlay.style.cssText = `
          position: absolute;
          top: 0; left: 0; right: 0; bottom: 0;
          pointer-events: none;
          z-index: 7;
          border-radius: 8px; /* match card border radius */
          background: radial-gradient(ellipse ${sw * 1.5}px ${sh * 1.5}px at ${cx}px ${cy}px, transparent 20%, rgba(28, 25, 22, 0.45) 80%);
          opacity: 0;
        `;
        card.appendChild(overlay);

        const glow = document.createElement('div');
        glow.className = 'oc-mockup-beacon';
        glow.style.cssText = `
          position: absolute;
          left: ${x - 5}px; top: ${y - 5}px;
          width: ${w + 10}px; height: ${h + 10}px;
          background: ${hexToRgba(colors.beacon, 0.15)};
          border: 2px solid ${colors.beacon};
          border-radius: 4px;
          box-shadow: 0 0 14px ${colors.beacon};
          pointer-events: none;
          z-index: 8;
          opacity: 0;
        `;
        card.appendChild(glow);

        overlay.animate([
          { opacity: 0 },
          { opacity: 1, offset: 0.15 },
          { opacity: 1, offset: 0.85 },
          { opacity: 0 }
        ], { duration: duration(2500), fill: 'forwards' });

        glow.animate([
          { opacity: 0 },
          { opacity: 1, offset: 0.15 },
          { opacity: 1, offset: 0.85 },
          { opacity: 0 }
        ], { duration: duration(2500), fill: 'forwards' });
      } else {
        const glow = document.createElement('div');
        glow.className = 'oc-mockup-beacon';
        glow.style.cssText = `
          position: absolute;
          left: ${x - 4}px; top: ${y - 4}px;
          width: ${w + 8}px; height: ${h + 8}px;
          background: ${hexToRgba(colors.beacon, 0.25)};
          border: 2px solid ${colors.beacon};
          border-radius: 4px;
          box-shadow: 0 0 12px ${colors.beacon};
          pointer-events: none;
          z-index: 8;
          opacity: 0;
        `;
        card.appendChild(glow);
        glow.animate([
          { opacity: 0 },
          { opacity: 1, offset: 0.15 },
          { opacity: 1, offset: 0.85 },
          { opacity: 0 }
        ], { duration: duration(3000), easing: 'ease-in-out', fill: 'forwards' });
      }
      return;
    }

    // 4. Full effects
    // `effect` is the value of #preview-effect, which uses the real
    // extension/content.js effectsRegistry keys (hud/iris/sweep/...). Only a
    // subset of keys have a dedicated preview branch below; any other key
    // (including real registry keys like iris/dispersion/trail/speedlines/
    // chrono/cybervision that have no bespoke preview yet) falls through to
    // the generic spotlight-ring preview in the `else` branch. This preview
    // is never persisted to settings.effect (see saveProfileAndFinish).
    if (effect === 'hud') {
      const container = document.createElement('div');
      container.className = 'oc-mockup-beacon';
      container.style.cssText = `
        position: absolute;
        left: ${x - 30}px; top: ${y - 8}px;
        width: ${w + 60}px; height: ${h + 16}px;
        pointer-events: none;
        transform: scale(${scale});
        transform-origin: center;
      `;
      card.appendChild(container);

      const line = document.createElement('div');
      line.style.cssText = `
        position: absolute;
        top: 50%; left: 0; width: 100%; height: 2px;
        background: ${colors.beacon};
        box-shadow: 0 0 8px ${colors.beacon};
        transform: scaleX(0);
      `;
      container.appendChild(line);
      line.animate([
        { transform: 'scaleX(0)', opacity: 0 },
        { transform: 'scaleX(1)', opacity: 1, offset: 0.15 },
        { transform: 'scaleX(1)', opacity: 1, offset: 0.85 },
        { transform: 'scaleX(0)', opacity: 0 }
      ], { duration: duration(1000), fill: 'forwards' });
    } else if (effect === 'sweep') {
      const container = document.createElement('div');
      container.className = 'oc-mockup-beacon';
      container.style.cssText = `
        position: absolute;
        left: ${x - 20}px; top: ${y - 20}px;
        width: ${w + 40}px; height: ${h + 40}px;
        pointer-events: none;
        transform: scale(${scale});
        transform-origin: center;
      `;
      card.appendChild(container);

      const ring = document.createElement('div');
      ring.style.cssText = `
        position: absolute;
        top: 50%; left: 50%;
        width: 20px; height: 20px;
        border: 2px solid ${colors.beacon};
        border-radius: 50%;
        transform: translate(-50%, -50%) scale(0.5);
        opacity: 0;
      `;
      container.appendChild(ring);
      ring.animate([
        { transform: 'translate(-50%, -50%) scale(0.5)', opacity: 0 },
        { transform: 'translate(-50%, -50%) scale(1.5)', opacity: 0.8, offset: 0.5 },
        { transform: 'translate(-50%, -50%) scale(2)', opacity: 0 }
      ], { duration: duration(800), fill: 'forwards' });
    } else if (effect === 'flame') {
      const container = document.createElement('div');
      container.className = 'oc-mockup-beacon';
      container.style.cssText = `
        position: absolute;
        left: ${x - 5}px; top: ${y - 20}px;
        width: ${w + 10}px; height: ${h + 30}px;
        pointer-events: none;
        transform: scale(${scale});
        transform-origin: center bottom;
      `;
      card.appendChild(container);

      const p = document.createElement('div');
      p.style.cssText = `
        position: absolute;
        bottom: 0; left: 50%; width: 16px; height: 16px;
        background: ${colors.beacon};
        border-radius: 50% 50% 20% 80%;
        filter: blur(3px);
        transform: translate(-50%, 0) scale(0.5);
        opacity: 0;
      `;
      container.appendChild(p);
      p.animate([
        { transform: 'translate(-50%, 0) scale(0.5)', opacity: 0 },
        { transform: 'translate(-50%, -10px) scale(1.3)', opacity: 0.8, offset: 0.5 },
        { transform: 'translate(-50%, -25px) scale(0)', opacity: 0 }
      ], { duration: duration(1000), fill: 'forwards' });
    } else if (effect === 'lightning') {
      const container = document.createElement('div');
      container.className = 'oc-mockup-beacon';
      container.style.cssText = `
        position: absolute;
        left: ${x - 5}px; top: ${y - 25}px;
        width: ${w + 10}px; height: ${h + 25}px;
        pointer-events: none;
        transform: scale(${scale});
        transform-origin: center;
      `;
      card.appendChild(container);

      const bolt = document.createElement('div');
      bolt.style.cssText = `
        position: absolute;
        top: 0; left: 50%; width: 2px; height: 100%;
        background: #ffffff;
        box-shadow: 0 0 6px ${colors.beacon};
        opacity: 0;
      `;
      container.appendChild(bolt);
      bolt.animate([
        { opacity: 0 },
        { opacity: 1, offset: 0.1 },
        { opacity: 0, offset: 0.2 },
        { opacity: 0.8, offset: 0.3 },
        { opacity: 0 }
      ], { duration: duration(600), fill: 'forwards' });
    } else if (effect === 'electron') {
      const container = document.createElement('div');
      container.className = 'oc-mockup-beacon';
      container.style.cssText = `
        position: absolute;
        left: ${x - 10}px; top: ${y - 10}px;
        width: ${w + 20}px; height: ${h + 20}px;
        pointer-events: none;
        transform: scale(${scale});
        transform-origin: center;
      `;
      card.appendChild(container);

      const dot = document.createElement('div');
      dot.style.cssText = `
        position: absolute;
        top: 0; left: 0; width: 4px; height: 4px;
        background: ${colors.beacon};
        border-radius: 50%;
        box-shadow: 0 0 4px ${colors.beacon};
      `;
      container.appendChild(dot);
    } else if (effect === 'arrows') {
      const leftArrow = document.createElement('div');
      leftArrow.className = 'oc-mockup-beacon';
      leftArrow.textContent = '▶';
      const arrowSize = Math.max(16, 20 * scale);
      leftArrow.style.cssText = `
        position: absolute;
        left: ${x - 26}px;
        top: ${y + h/2 - arrowSize/2}px;
        width: 20px; height: ${arrowSize}px;
        line-height: ${arrowSize}px;
        font-size: ${arrowSize}px;
        font-weight: bold;
        color: ${colors.beacon};
        pointer-events: none;
        z-index: 9;
        text-align: right;
        opacity: 0;
      `;
      card.appendChild(leftArrow);

      const rightArrow = document.createElement('div');
      rightArrow.className = 'oc-mockup-beacon';
      rightArrow.textContent = '◀';
      rightArrow.style.cssText = `
        position: absolute;
        left: ${x + w + 6}px;
        top: ${y + h/2 - arrowSize/2}px;
        width: 20px; height: ${arrowSize}px;
        line-height: ${arrowSize}px;
        font-size: ${arrowSize}px;
        font-weight: bold;
        color: ${colors.beacon};
        pointer-events: none;
        z-index: 9;
        text-align: left;
        opacity: 0;
      `;
      card.appendChild(rightArrow);

      leftArrow.animate([
        { opacity: 0, transform: `translateX(-${8 * scale}px)` },
        { opacity: 1, transform: 'translateX(0)', offset: 0.15 },
        { opacity: 1, transform: 'translateX(0)', offset: 0.85 },
        { opacity: 0, transform: `translateX(-${4 * scale}px)` }
      ], { duration: duration(2500), fill: 'forwards' });

      rightArrow.animate([
        { opacity: 0, transform: `translateX(${8 * scale}px)` },
        { opacity: 1, transform: 'translateX(0)', offset: 0.15 },
        { opacity: 1, transform: 'translateX(0)', offset: 0.85 },
        { opacity: 0, transform: `translateX(${4 * scale}px)` }
      ], { duration: duration(2500), fill: 'forwards' });
    } else {
      const container = document.createElement('div');
      container.className = 'oc-mockup-beacon';
      container.style.cssText = `
        position: absolute;
        left: ${x - 20}px; top: ${y - 20}px;
        width: ${w + 40}px; height: ${h + 40}px;
        pointer-events: none;
        transform: scale(${scale});
        transform-origin: center;
      `;
      card.appendChild(container);

      const spotlight = document.createElement('div');
      spotlight.style.cssText = `
        position: absolute;
        top: 0; left: 0; width: 100%; height: 100%;
        border: 2px solid ${colors.beacon};
        border-radius: 50%;
        box-shadow: 0 0 10px ${colors.beacon};
        transform: scale(1.4);
        opacity: 0;
      `;
      container.appendChild(spotlight);
      spotlight.animate([
        { transform: 'scale(1.4)', opacity: 0 },
        { transform: 'scale(1)', opacity: 1, offset: 0.3 },
        { transform: 'scale(0.9)', opacity: 0 }
      ], { duration: duration(1200), fill: 'forwards' });
    }
  }

  async function saveProfileAndFinish() {
    const resolved = resolveVisionSettings();
    selectedProfile = resolved.profile;
    const vs = resolved.settings;

    // Save to sync storage
    try {
      const data = await chrome.storage.sync.get('oc-settings');
      const settings = (data && data['oc-settings']) || {};

      // oculist-rnr.12 (review fix, gap 1): a not-yet-updated install's stored object can
      // still carry a legacy 'visionProfile' key (content scripts don't re-inject into
      // already-open tabs after an update, so welcome.html can be the first surface to
      // touch a pre-update settings object). Strip it before this wizard's own fresh choice
      // gets written below, or the legacy key would ride along into the write-back
      // untouched forever. The displayPreset value normalizeOcSettings() computes here is
      // immediately overwritten by the wizard's own selection on the next line regardless —
      // only the deletion of the legacy key matters at this call site.
      OculistSettingsMigration.normalizeOcSettings(settings);

      // 'custom' excluded explicitly here (see the table comment above) rather than via a
      // trimmed copy of the canonical table: this wizard has no PRESETS entry or UI path
      // that produces selectedProfile === 'custom', so there is nothing meaningful for it
      // to translate to.
      settings.displayPreset = (selectedProfile === 'none' || selectedProfile === 'custom')
        ? null
        : (OculistSettingsMigration.LEGACY_DISPLAY_PRESET_MAP[selectedProfile] || null);
      settings.visionSettings = {
        ...settings.visionSettings,
        ...vs
      };
      settings.setupWizardCompleted = true;

      await chrome.storage.sync.set({ 'oc-settings': settings });
    } catch (e) {
      console.error('Failed to save settings:', e);
    }

    wizardModal.style.display = 'none';

    if (!heroBanner) return;
    heroBanner.innerHTML = `
      <h3 style="font-size: 18px; font-weight: 700; color: #10b981; margin-bottom: 8px;">✓ Vision Setup Completed!</h3>
      <p style="font-size: 14px; color: #a1a1aa; margin-bottom: 12px; line-height: 1.5;">Oculist has been successfully configured with your <strong>${selectedProfile === 'none' ? 'Standard' : selectedProfile.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}</strong> profile. Fine-tune it any time from the extension's Settings popup.</p>
      <button id="rerun-wizard" class="nav-btn" style="max-width: 240px; margin: 0 auto;" aria-label="Run the setup wizard again">Run Setup Again</button>
    `;

    // Only the functional preset (settings.displayPreset, already persisted above) survives
    // once this page reloads or the wizard is re-run — the clinical selection made above
    // lives only in this closure's selectedProfile/colorBlindAnswer variables and is never
    // written anywhere. Re-running the picker here (or via the Settings popup's own Active
    // Vision Profile dropdown, which is always available) is the only way to see the named
    // shortcut again; nothing is faked to make it look otherwise.
    const rerunBtn = document.getElementById('rerun-wizard');
    if (rerunBtn) {
      rerunBtn.addEventListener('click', openWizard);
    }
  }
});
