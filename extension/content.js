(function () {
  'use strict';

  if (window.__ocDestroy) { window.__ocDestroy(); return; }

  // ── Settings (persisted) ──────────────────────────────────────────────────────

  var settings = {
    effect: 'hud',
    position: 'tr',
    theme: 'dark',
    matchColor: '#fef08a',
    activeColor: '#f59e0b',
    beaconColor: '#fbbf24',
    scrollBehavior: 'smooth',
    disabledSites: [],
    performanceMode: false,
    visionProfile: null,
    visionSettings: {
      beaconSize: 'm',
      animationSpeed: 'normal',
      textLabels: false,
      motionSensitivity: 'full',
      colorPalette: 'default',
      borderStyle: 'none',
      customColors: {
        matchColor: '#fef08a',
        activeColor: '#f59e0b',
        beaconColor: '#fbbf24'
      }
    },
    setupWizardCompleted: false
  };

  var SETTINGS_KEYS = [
    'effect', 'position', 'theme', 'matchColor', 'activeColor', 'beaconColor', 
    'scrollBehavior', 'disabledSites', 'performanceMode', 
    'visionProfile', 'visionSettings', 'setupWizardCompleted'
  ];

  function saveSettings() {
    chrome.storage.sync.set({ 'oc-settings': settings });
  }

  function getEffectiveColors() {
    var palette = (settings.visionSettings && settings.visionSettings.colorPalette) ? settings.visionSettings.colorPalette : 'default';
    var mc = settings.matchColor || '#fef08a';
    var ac = settings.activeColor || '#f59e0b';
    var bc = settings.beaconColor || '#fbbf24';

    if (palette === 'deuteranopia') {
      mc = '#fef08a'; ac = '#0284c7'; bc = '#0284c7';
    } else if (palette === 'protanopia') {
      mc = '#fef08a'; ac = '#2563eb'; bc = '#2563eb';
    } else if (palette === 'tritanopia') {
      mc = '#ffcbd1'; ac = '#06b6d4'; bc = '#06b6d4';
    } else if (palette === 'warm') {
      mc = '#fef08a'; ac = '#d97706'; bc = '#eab308';
    } else if (palette === 'custom' && settings.visionSettings && settings.visionSettings.customColors) {
      mc = settings.visionSettings.customColors.matchColor || mc;
      ac = settings.visionSettings.customColors.activeColor || ac;
      bc = settings.visionSettings.customColors.beaconColor || bc;
    }
    return { match: mc, active: ac, beacon: bc };
  }

  function getBeaconScale() {
    var size = (settings.visionSettings && settings.visionSettings.beaconSize) ? settings.visionSettings.beaconSize : 'm';
    if (size === 's') return 0.7;
    if (size === 'l') return 1.5;
    if (size === 'xl') return 2.25;
    return 1.0;
  }

  function getBeaconDuration(baseDuration) {
    var speed = (settings.visionSettings && settings.visionSettings.animationSpeed) ? settings.visionSettings.animationSpeed : 'normal';
    if (speed === 'fast') return baseDuration * 0.5;
    if (speed === 'slow') return baseDuration * 1.75;
    return baseDuration;
  }

  // ── Central i18n Localization Dictionary ─────────────────────────────────────

  var i18n = {
    findPlaceholder: 'Find…',
    prevTitle: 'Previous  Shift+Enter',
    nextTitle: 'Next  Enter',
    replayTitle: 'Replay Effect',
    optionsTitle: 'Options',
    closeTitle: 'Close  Esc',
    noMatch: 'no match',
    of: 'of',
    
    // Preference Panel Strings
    prefTitle: 'OCULIST PREFERENCES',
    prefSubtitle: 'Configure appearance and effects',
    resetBtn: 'Reset',
    visualTheme: 'Visual Theme',
    themeDesc: 'Sleek interface color palette',
    dark: 'Dark',
    light: 'Light',
    system: 'System',
    scrollBehavior: 'Scroll Behavior',
    scrollBehaviorDesc: 'Viewport movement style',
    smooth: 'Smooth',
    instant: 'Instant',
    highlightEffect: 'Highlight Effect',
    effectDesc: 'Choose match visual transition',
    panelPosition: 'Panel Position',
    positionDesc: 'Screen quadrant placement',
    topLeft: 'Top left',
    topRight: 'Top right',
    bottomLeft: 'Bottom left',
    bottomRight: 'Bottom right',
    customColors: 'Custom Colors',
    colorsDesc: 'Interactive effect colors',
    matchLabel: 'Match',
    matchTitle: 'Normal Match Color',
    activeLabel: 'Active',
    activeTitle: 'Active Match Color',
    beaconLabel: 'Beacon',
    beaconTitle: 'Beacon Animation Color',
    supportTitle: 'Support Oculist',
    supportDesc: 'Keep this open-source tool going',
    coffeeBtn: '☕ Buy me a coffee',
    feedbackTitle: 'Share Feedback',
    feedbackDesc: 'Help us improve Oculist',
    feedbackBtn: '💬 Send Feedback',
    
    // Site Toggle Strings
    siteToggleLabel: 'Active on this Site',
    siteToggleDesc: 'Toggle Oculist for this domain',
    enabled: 'Enabled',
    disabled: 'Disabled',

    // Highlight Effects
    effectAnimeLaser: 'Anime Laser',
    effectSpotlight: 'Spotlight',
    effectWarpDrive: 'Warp Drive',
    effectInfernoFlame: 'Inferno Flame',
    effectLightning: 'Lightning',
    effectElectronCloud: 'Electron Cloud',
    effectPointingArrows: 'Pointing Arrows'
  };

  // ── Theme + position tables ───────────────────────────────────────────────────

  var THEMES = {
    dark: {
      bg: 'rgba(9, 9, 11, 0.94)', text: '#fafafa', subtle: '#fafafa',
      inputBg: 'rgba(24, 24, 27, 0.75)', inputBorder: '#3f3f46', inputText: '#fafafa',
      accent: '#f59e0b', panelBg: 'rgba(9, 9, 11, 0.97)', divider: '#3f3f46',
    },
    light: {
      bg: 'rgba(255, 255, 255, 0.94)', text: '#09090b', subtle: '#09090b',
      inputBg: 'rgba(244, 244, 245, 0.75)', inputBorder: '#d4d4d8', inputText: '#09090b',
      accent: '#f59e0b', panelBg: 'rgba(255, 255, 255, 0.97)', divider: '#d4d4d8',
    },
  };
  function getActiveThemeName() {
    var themeName = settings.theme;
    if (themeName === 'system') {
      var isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      themeName = isDark ? 'dark' : 'light';
    }
    return themeName;
  }

  function T() { return THEMES[getActiveThemeName()] || THEMES.dark; }

  var POS_DATA = {
    tr: { top: '0', right: '0', bottom: '', left: '',  radius: '0 0 0 8px', isBottom: false },
    tl: { top: '0', right: '',  bottom: '', left: '0', radius: '0 0 8px 0', isBottom: false },
    br: { top: '',  right: '0', bottom: '0', left: '', radius: '8px 0 0 0', isBottom: true  },
    bl: { top: '',  right: '',  bottom: '0', left: '0', radius: '0 8px 0 0', isBottom: true  },
  };
  function P() { return POS_DATA[settings.position] || POS_DATA.tr; }

  // ── Plugins & Effects Registry ────────────────────────────────────────────────

  var effectsRegistry = {
    hud: { label: i18n.effectAnimeLaser, run: animateAnimeLaser },
    iris: { label: i18n.effectSpotlight, run: animateIris },
    sweep: { label: i18n.effectWarpDrive, run: animateWarpDrive },
    flame: { label: i18n.effectInfernoFlame, run: animateFlame },
    lightning: { label: i18n.effectLightning, run: animateLightning },
    electron: { label: i18n.effectElectronCloud, run: animateElectronCloud },
    arrows: { label: i18n.effectPointingArrows, run: animatePointingArrows }
  };

  // ── State ─────────────────────────────────────────────────────────────────────

  var searchRanges     = [];
  var activeIndex      = -1;
  var lastTerm         = '';
  var firstEnter       = false;
  var debounceTimer    = null;
  var activeBeacons    = 0;
  var wrap, wrapRoot, bar, input, countEl, prevBtn, nextBtn, replayBtn, gearBtn, closeBtn, settingsPanel;
  var activeScrollTimeout      = null;
  var activeScrollEndHandler   = null;
  var activeScrollDebounceHandler = null;
  var domObserver           = null;
  var domObserverTimer      = null;
  var noticeEl              = null;
  var noticeDismissed       = false;

  // Sites known to render page text outside the accessible DOM (canvas, custom
  // virtualized editors) where Oculist's text-node search can't find anything.
  var KNOWN_OVERRIDE_DOMAINS = [
    'docs.google.com', 'sheets.google.com', 'slides.google.com', 'notion.so', 'www.notion.so'
  ];

  // ── Destroy ───────────────────────────────────────────────────────────────────

  window.__ocDestroy = function () {
    clearViewportMarkers();
    if (viewportMarkersTimer) {
      clearTimeout(viewportMarkersTimer);
      viewportMarkersTimer = null;
    }
    try {
      window.removeEventListener('resize', scheduleViewportMarkersUpdate, { passive: true });
    } catch (e) {}
    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }
    if (domObserverTimer) {
      clearTimeout(domObserverTimer);
      domObserverTimer = null;
    }
    if (activeScrollTimeout) {
      clearTimeout(activeScrollTimeout);
      activeScrollTimeout = null;
    }
    if (activeScrollEndHandler) {
      window.removeEventListener('scrollend', activeScrollEndHandler);
      activeScrollEndHandler = null;
    }
    if (activeScrollDebounceHandler) {
      window.removeEventListener('scroll', activeScrollDebounceHandler);
      activeScrollDebounceHandler = null;
    }

    try {
      window.removeEventListener('scroll', handleScroll, { passive: true });
    } catch (e) {}

    try {
      if (typeof Highlight !== 'undefined' && CSS.highlights) {
        CSS.highlights.delete('oculist-match');
        CSS.highlights.delete('oculist-active-match');
      }
    } catch (e) {}

    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }

    cancelBeacons();
    if (wrap) wrap.remove();

    var s = document.getElementById('oc-global-highlight-styles');
    if (s) s.remove();

    wrap = wrapRoot = bar = input = countEl = prevBtn = nextBtn = replayBtn = gearBtn = closeBtn = settingsPanel = noticeEl = null;
    lastTerm = ''; activeIndex = -1; searchRanges = []; firstEnter = false; noticeDismissed = false;
  };

  // ── Beacons ───────────────────────────────────────────────────────────────────

  function cancelBeacons() {
    var beacons = document.querySelectorAll('.oc-beacon');
    for (var i = 0; i < beacons.length; i++) {
      if (beacons[i].__rafId) cancelAnimationFrame(beacons[i].__rafId);
      beacons[i].remove();
    }
    activeBeacons = 0;
  }

  // ── Effects (CSP-Compliant via Web Animations API & Document Root Mount) ───

  function animateAnimeLaser(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;

    var x = rect.left + window.scrollX;
    var y = rect.top + window.scrollY;
    var w = rect.width;
    var h = rect.height;
    var cx = rect.left + rect.width / 2 + window.scrollX;
    var cy = rect.top + rect.height / 2 + window.scrollY;
    var color = getEffectiveColors().beacon || '#fbbf24';
    var scale = getBeaconScale();

    var containerHeight = 200;
    var scrollHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    );
    var maxTop = Math.max(0, scrollHeight - containerHeight);
    var targetTop = Math.min(Math.max(0, cy - 100), maxTop);
    var offsetY = cy - targetTop;

    var laserContainer = document.createElement('div');
    laserContainer.className = 'oc-beacon';
    laserContainer.style.cssText = [
      'position:absolute',
      'left:0', 'top:' + targetTop + 'px',
      'width:100%', 'height:' + containerHeight + 'px',
      'pointer-events:none', 'z-index:2147483643',
      'overflow:visible'
    ].join(';');
    laserContainer.style.transform = 'scale(' + scale + ')';
    laserContainer.style.transformOrigin = cx + 'px ' + offsetY + 'px';

    // 1. Primary main core beam (thick outer aura sheath)
    var sheath = document.createElement('div');
    sheath.style.cssText = [
      'position:absolute',
      'left:0', 'right:0', 'top:' + (offsetY - 10) + 'px', 'height:20px',
      'background:linear-gradient(90deg, transparent, ' + color + ' 20%, ' + color + ' 80%, transparent)',
      'filter:blur(3px)',
      'opacity:0', 'pointer-events:none'
    ].join(';');
    laserContainer.appendChild(sheath);

    sheath.animate([
      { transform: 'scaleY(0)', opacity: 0 },
      { transform: 'scaleY(1.5)', opacity: 0.6, offset: 0.1 },
      { transform: 'scaleY(1)', opacity: 0.4, offset: 0.8 },
      { transform: 'scaleY(0)', opacity: 0 }
    ], {
      duration: getBeaconDuration(2000),
      easing: 'cubic-bezier(0.19, 1, 0.22, 1)',
      fill: 'forwards'
    });

    // 2. High-energy inner core beam (sharp white core)
    var core = document.createElement('div');
    core.style.cssText = [
      'position:absolute',
      'left:0', 'right:0', 'top:' + (offsetY - 4) + 'px', 'height:8px',
      'background:linear-gradient(90deg, transparent, ' + color + ' 10%, #ffffff 40%, #ffffff 60%, ' + color + ' 90%, transparent)',
      'box-shadow:0 0 15px ' + color + ', 0 0 35px ' + color + ', 0 0 60px #ffffff',
      'transform-origin:center',
      'opacity:0', 'pointer-events:none'
    ].join(';');
    laserContainer.appendChild(core);

    core.animate([
      { transform: 'scaleY(0)', opacity: 0 },
      { transform: 'scaleY(2.2)', opacity: 1, offset: 0.15 },
      { transform: 'scaleY(1.2)', opacity: 0.85, offset: 0.8 },
      { transform: 'scaleY(0)', opacity: 0 }
    ], {
      duration: getBeaconDuration(2000),
      easing: 'cubic-bezier(0.19, 1, 0.22, 1)',
      fill: 'forwards'
    });

    // 3. Central energy sphere/flash over active match
    var flash = document.createElement('div');
    flash.style.cssText = [
      'position:absolute',
      'left:' + (x - 25) + 'px', 'top:' + (offsetY - h/2 - 25) + 'px',
      'width:' + (w + 50) + 'px', 'height:' + (h + 50) + 'px',
      'background:radial-gradient(circle, #ffffff 10%, ' + color + ' 60%, transparent 100%)',
      'border-radius:50%',
      'filter:drop-shadow(0 0 15px ' + color + ')',
      'transform-origin:center',
      'opacity:0', 'pointer-events:none'
    ].join(';');
    laserContainer.appendChild(flash);

    flash.animate([
      { transform: 'scale(0.2)', opacity: 0 },
      { transform: 'scale(1.3)', opacity: 1, offset: 0.15 },
      { transform: 'scale(1)', opacity: 0.9, offset: 0.8 },
      { transform: 'scale(1.5) scaleY(0)', opacity: 0 }
    ], {
      duration: getBeaconDuration(2000),
      easing: 'cubic-bezier(0.19, 1, 0.22, 1)',
      fill: 'forwards'
    });

    // 4. Spark explosion
    var sparkCount = settings.performanceMode ? Math.round(5 * scale) : Math.round(20 * (scale > 1 ? 1.5 : scale));
    for (var i = 0; i < sparkCount; i++) {
      var spark = document.createElement('div');
      var size = (Math.random() * 5 + 3) * scale;
      spark.style.cssText = [
        'position:absolute',
        'left:' + cx + 'px', 'top:' + offsetY + 'px',
        'width:' + size + 'px', 'height:' + size + 'px',
        'border-radius:50%',
        'background:#ffffff',
        'box-shadow:0 0 10px ' + color + ', 0 0 20px ' + color,
        'pointer-events:none'
      ].join(';');
      laserContainer.appendChild(spark);

      var angle = Math.random() * Math.PI * 2;
      var distance = (Math.random() * 110 + 50) * scale;
      var dx = Math.cos(angle) * distance;
      var dy = Math.sin(angle) * distance;

      spark.animate([
        { transform: 'translate(-50%, -50%) translate(0, 0) scale(1.5)', opacity: 1 },
        { transform: 'translate(-50%, -50%) translate(' + dx + 'px, ' + dy + 'px) scale(0)', opacity: 0 }
      ], {
        duration: getBeaconDuration(1500 + Math.random() * 500),
        easing: 'cubic-bezier(0.1, 0.8, 0.2, 1)',
        fill: 'forwards'
      });
    }

    // Append to live DOM tree exactly once at the end to prevent layout reflow invalidations
    document.documentElement.appendChild(laserContainer);

    setTimeout(function() {
      laserContainer.remove();
    }, getBeaconDuration(2100));
  }

  function animateIris(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;

    var scale = getBeaconScale();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var w = Math.max(rect.width + 50, 90) * scale;
    var h = Math.max(rect.height + 30, 50) * scale;

    var overlay = document.createElement('div');
    overlay.className = 'oc-beacon';
    overlay.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'bottom:0',
      'pointer-events:none', 'z-index:2147483641',
      'background:radial-gradient(ellipse ' + (w * 2.8) + 'px ' + (h * 2.8) + 'px at ' + cx + 'px ' + cy + 'px, transparent 20%, rgba(0, 0, 0, 0.72) 80%)'
    ].join(';');
    document.documentElement.appendChild(overlay);

    overlay.animate([
      { opacity: 0 },
      { opacity: 1, offset: 0.15 },
      { opacity: 1, offset: 0.8 },
      { opacity: 0 }
    ], {
      duration: getBeaconDuration(2000),
      easing: 'ease-out',
      fill: 'forwards'
    });

    var color = getEffectiveColors().beacon || '#38bdf8';

    var ring = document.createElement('div');
    ring.className = 'oc-beacon';
    ring.style.cssText = [
      'position:fixed',
      'left:' + (cx - w/2) + 'px', 'top:' + (cy - h/2) + 'px',
      'width:' + w + 'px', 'height:' + h + 'px',
      'border:2.5px solid ' + color,
      'border-radius:50%',
      'box-shadow:0 0 20px ' + color + ', inset 0 0 20px ' + color,
      'pointer-events:none', 'z-index:2147483642',
    ].join(';');
    document.documentElement.appendChild(ring);

    ring.animate([
      { opacity: 0, transform: 'scale(4)' },
      { opacity: 1, transform: 'scale(1)', offset: 0.2 },
      { opacity: 0.85, transform: 'scale(0.95)', offset: 0.8 },
      { opacity: 0, transform: 'scale(0.75)' }
    ], {
      duration: getBeaconDuration(2000),
      easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
      fill: 'forwards'
    });

    setTimeout(function() {
      overlay.remove();
      ring.remove();
    }, getBeaconDuration(2100));
  }

  function animatePointingArrows(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;

    var x = rect.left + window.scrollX;
    var y = rect.top + window.scrollY;
    var w = rect.width;
    var h = rect.height;
    var colors = getEffectiveColors();
    var color = colors.beacon;

    var scale = getBeaconScale();
    var leftArrow = document.createElement('div');
    leftArrow.className = 'oc-beacon';
    leftArrow.textContent = '▶';
    var arrowSize = Math.max(20, 24 * scale);
    leftArrow.style.cssText = [
      'position:absolute',
      'left:' + (x - 36 * scale) + 'px',
      'top:' + (y + h/2 - arrowSize/2) + 'px',
      'width:' + (30 * scale) + 'px', 'height:' + arrowSize + 'px',
      'line-height:' + arrowSize + 'px',
      'font-size:' + arrowSize + 'px',
      'font-weight:bold',
      'color:' + color,
      'pointer-events:none',
      'z-index:2147483642',
      'text-align:right',
      'opacity:0'
    ].join(';');
    document.documentElement.appendChild(leftArrow);

    var rightArrow = document.createElement('div');
    rightArrow.className = 'oc-beacon';
    rightArrow.textContent = '◀';
    rightArrow.style.cssText = [
      'position:absolute',
      'left:' + (x + w + 6 * scale) + 'px',
      'top:' + (y + h/2 - arrowSize/2) + 'px',
      'width:' + (30 * scale) + 'px', 'height:' + arrowSize + 'px',
      'line-height:' + arrowSize + 'px',
      'font-size:' + arrowSize + 'px',
      'font-weight:bold',
      'color:' + color,
      'pointer-events:none',
      'z-index:2147483642',
      'text-align:left',
      'opacity:0'
    ].join(';');
    document.documentElement.appendChild(rightArrow);

    var duration = getBeaconDuration(2000);

    var anim = leftArrow.animate([
      { opacity: 0, transform: 'translateX(-' + (10 * scale) + 'px)' },
      { opacity: 1, transform: 'translateX(0)', offset: 0.15 },
      { opacity: 1, transform: 'translateX(0)', offset: 0.85 },
      { opacity: 0, transform: 'translateX(-' + (5 * scale) + 'px)' }
    ], { duration: duration, fill: 'forwards' });

    rightArrow.animate([
      { opacity: 0, transform: 'translateX(' + (10 * scale) + 'px)' },
      { opacity: 1, transform: 'translateX(0)', offset: 0.15 },
      { opacity: 1, transform: 'translateX(0)', offset: 0.85 },
      { opacity: 0, transform: 'translateX(' + (5 * scale) + 'px)' }
    ], { duration: duration, fill: 'forwards' });

    anim.finished.then(function () {
      leftArrow.remove();
      rightArrow.remove();
    }).catch(function () {
      leftArrow.remove();
      rightArrow.remove();
    });
  }

  function animateWarpDrive(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;

    var cx = rect.left + rect.width / 2 + window.scrollX;
    var cy = rect.top + rect.height / 2 + window.scrollY;
    var color = getEffectiveColors().beacon || '#fbbf24';
    var scale = getBeaconScale();

    var containerWidth = 300;
    var containerHeight = 300;
    var scrollHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    );
    var scrollWidth = Math.max(
      document.documentElement.scrollWidth,
      document.body ? document.body.scrollWidth : 0
    );
    var maxTop = Math.max(0, scrollHeight - containerHeight);
    var maxLeft = Math.max(0, scrollWidth - containerWidth);
    var targetTop = Math.min(Math.max(0, cy - 150), maxTop);
    var targetLeft = Math.min(Math.max(0, cx - 150), maxLeft);
    var offsetX = cx - targetLeft;
    var offsetY = cy - targetTop;

    var container = document.createElement('div');
    container.className = 'oc-beacon';
    container.style.cssText = [
      'position:absolute',
      'left:' + targetLeft + 'px', 'top:' + targetTop + 'px',
      'width:' + containerWidth + 'px', 'height:' + containerHeight + 'px',
      'pointer-events:none', 'z-index:2147483643',
      'overflow:visible'
    ].join(';');
    container.style.transform = 'scale(' + scale + ')';
    container.style.transformOrigin = offsetX + 'px ' + offsetY + 'px';

    // 1. Triple Staggered Expanding Warp Rings
    var ringCount = settings.performanceMode ? 1 : 3;
    for (var r = 0; r < ringCount; r++) {
      var ring = document.createElement('div');
      ring.style.cssText = [
        'position:absolute',
        'left:' + (offsetX - 5) + 'px', 'top:' + (offsetY - 5) + 'px',
        'width:10px', 'height:10px',
        'border:2px solid #ffffff',
        'border-radius:50%',
        'box-shadow:0 0 10px ' + color + ', inset 0 0 8px ' + color,
        'opacity:0', 'pointer-events:none'
      ].join(';');
      container.appendChild(ring);

      ring.animate([
        { transform: 'scale(0.5)', opacity: 0 },
        { transform: 'scale(1)', opacity: 1, offset: 0.1 },
        { transform: 'scale(15)', opacity: 0 }
      ], {
        duration: getBeaconDuration(1600),
        delay: r * getBeaconDuration(150),
        easing: 'cubic-bezier(0.1, 0.8, 0.15, 1)',
        fill: 'forwards'
      });
    }

    // 2. Warp Speed Radial Star Streaks
    var streakCount = settings.performanceMode ? Math.round(15 * scale) : Math.round(120 * (scale > 1 ? 1.5 : scale));
    for (var i = 0; i < streakCount; i++) {
      var streak = document.createElement('div');
      var thick = (Math.random() * 2.2 + 1) * scale;
      var len = (Math.random() * 55 + 25) * scale;
      var angle = Math.random() * Math.PI * 2;

      streak.style.cssText = [
        'position:absolute',
        'left:' + offsetX + 'px', 'top:' + offsetY + 'px',
        'width:' + len + 'px', 'height:' + thick + 'px',
        'background:linear-gradient(90deg, transparent, ' + color + ', #ffffff 40%, #ffffff 60%, ' + color + ', transparent)',
        'box-shadow:0 0 10px ' + color + ', 0 0 4px #ffffff',
        'transform-origin:left center',
        'opacity:0', 'pointer-events:none'
      ].join(';');
      container.appendChild(streak);

      var travel = (Math.random() * 240 + 130) * scale;
      var startDelay = Math.random() * 550;

      streak.animate([
        { transform: 'rotate(' + angle + 'rad) translate(10px, 0) scaleX(0.05)', opacity: 0 },
        { transform: 'rotate(' + angle + 'rad) translate(' + (travel * 0.25) + 'px, 0) scaleX(3.5)', opacity: 1, offset: 0.15 },
        { transform: 'rotate(' + angle + 'rad) translate(' + (travel * 0.7) + 'px, 0) scaleX(7.0)', opacity: 1, offset: 0.7 },
        { transform: 'rotate(' + angle + 'rad) translate(' + travel + 'px, 0) scaleX(10.0)', opacity: 0 }
      ], {
        duration: getBeaconDuration(750 + Math.random() * 550),
        delay: getBeaconDuration(startDelay),
        easing: 'cubic-bezier(0.1, 0.8, 0.25, 1)',
        fill: 'forwards'
      });
    }

    // Append to live DOM tree exactly once at the end to prevent layout reflow invalidations
    document.documentElement.appendChild(container);

    setTimeout(function() {
      container.remove();
    }, getBeaconDuration(2200));
  }

  function animateFlame(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;

    var x = rect.left + window.scrollX;
    var y = rect.top + window.scrollY;
    var w = rect.width;
    var h = rect.height;
    var color = getEffectiveColors().beacon || '#f97316';
    var _fhsl = hexToHsl(color);
    var _fh = _fhsl[0], _fs = _fhsl[1], _fl = _fhsl[2];
    // Offsets mirror the original orange-flame palette relative to the base
    var colorDeep = hslToHex(_fh - 24, _fs - 11, Math.min(100, _fl + 7));
    var colorMid  = hslToHex(_fh + 14, _fs -  3, Math.max(0,   _fl - 3));
    var colorWarm = hslToHex(_fh + 24, _fs +  2, _fl);
    var colorTip  = hslToHex(_fh + 28, _fs +  4, Math.min(100, _fl + 24));
    var scale = getBeaconScale();

    var containerWidth = w + 160;
    var containerHeight = h + 280;
    var scrollHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    );
    var scrollWidth = Math.max(
      document.documentElement.scrollWidth,
      document.body ? document.body.scrollWidth : 0
    );
    var maxTop = Math.max(0, scrollHeight - containerHeight);
    var maxLeft = Math.max(0, scrollWidth - containerWidth);
    var targetTop = Math.min(Math.max(0, y - 200), maxTop);
    var targetLeft = Math.min(Math.max(0, x - 80), maxLeft);
    var offsetX = x - targetLeft;
    var offsetY = y - targetTop;

    var container = document.createElement('div');
    container.className = 'oc-beacon';
    container.style.cssText = [
      'position:absolute',
      'left:' + targetLeft + 'px', 'top:' + targetTop + 'px',
      'width:' + containerWidth + 'px', 'height:' + containerHeight + 'px',
      'pointer-events:none', 'z-index:2147483643',
      'overflow:visible'
    ].join(';');
    container.style.transform = 'scale(' + scale + ')';
    container.style.transformOrigin = offsetX + 'px ' + offsetY + 'px';

    // 1. Fiery glowing outline
    var outline = document.createElement('div');
    outline.style.cssText = [
      'position:absolute',
      'left:' + offsetX + 'px', 'top:' + offsetY + 'px',
      'width:' + w + 'px', 'height:' + h + 'px',
      'border-radius:4px',
      'box-shadow:0 0 60px ' + colorDeep + ', inset 0 0 40px ' + color + ', 0 0 16px ' + colorWarm,
      'opacity:0', 'pointer-events:none'
    ].join(';');
    container.appendChild(outline);

    outline.animate([
      { opacity: 0, transform: 'scale(1.15)' },
      { opacity: 0.9, transform: 'scale(1)', offset: 0.15 },
      { opacity: 0.8, transform: 'scale(1)', offset: 0.85 },
      { opacity: 0, transform: 'scale(0.95)' }
    ], {
      duration: getBeaconDuration(1800),
      easing: 'ease-out',
      fill: 'forwards'
    });

    // 2. Soft heat glow behind
    var glow = document.createElement('div');
    glow.style.cssText = [
      'position:absolute',
      'left:' + (offsetX - 40) + 'px', 'top:' + (offsetY - 40) + 'px',
      'width:' + (w + 80) + 'px', 'height:' + (h + 80) + 'px',
      'background:radial-gradient(ellipse, ' + hexToRgba(colorDeep, 0.4) + ' 0%, ' + hexToRgba(color, 0.15) + ' 60%, transparent 100%)',
      'filter:blur(32px)',
      'opacity:0', 'pointer-events:none'
    ].join(';');
    container.appendChild(glow);

    glow.animate([
      { opacity: 0, transform: 'scale(0.8)' },
      { opacity: 1, transform: 'scale(1)', offset: 0.2 },
      { opacity: 0.8, transform: 'scale(1.05)', offset: 0.85 },
      { opacity: 0, transform: 'scale(1.1)' }
    ], {
      duration: getBeaconDuration(1800),
      easing: 'ease-out',
      fill: 'forwards'
    });

    // 3. Flame particles rising
    var colors = [colorDeep, color, colorMid, colorWarm, colorTip];
    var particleCount = settings.performanceMode ? Math.round(5 * scale) : Math.round(25 * (scale > 1 ? 1.4 : scale));
    for (var i = 0; i < particleCount; i++) {
      var p = document.createElement('div');
      var pSize = (Math.random() * 48 + 24) * scale;
      var px = offsetX + Math.random() * w;
      var py = offsetY + h;

      p.style.cssText = [
        'position:absolute',
        'left:' + px + 'px', 'top:' + py + 'px',
        'width:' + pSize + 'px', 'height:' + pSize + 'px',
        'background:' + colors[Math.floor(Math.random() * colors.length)],
        'border-radius:50% 50% 20% 80%',
        'filter:blur(' + ((Math.random() * 8 + 4) * scale) + 'px)',
        'transform-origin:center bottom',
        'opacity:0', 'pointer-events:none'
      ].join(';');
      container.appendChild(p);

      var riseHeight = (Math.random() * 180 + 120) * scale;
      var swayX = (Math.random() - 0.5) * 100 * scale;
      var randomRotate = Math.random() * 360;

      p.animate([
        { transform: 'translate(-50%, -50%) translate(0, 0) rotate(' + randomRotate + 'deg) scale(0.2)', opacity: 0 },
        { transform: 'translate(-50%, -50%) translate(' + (swayX * 0.3) + 'px, -' + (riseHeight * 0.3) + 'px) rotate(' + (randomRotate + 45) + 'deg) scale(1.2)', opacity: 0.9, offset: 0.2 },
        { transform: 'translate(-50%, -50%) translate(' + (swayX * 0.7) + 'px, -' + (riseHeight * 0.7) + 'px) rotate(' + (randomRotate + 90) + 'deg) scale(0.8)', opacity: 0.6, offset: 0.7 },
        { transform: 'translate(-50%, -50%) translate(' + swayX + 'px, -' + riseHeight + 'px) rotate(' + (randomRotate + 180) + 'deg) scale(0)', opacity: 0 }
      ], {
        duration: getBeaconDuration(1000 + Math.random() * 600),
        delay: getBeaconDuration(Math.random() * 400),
        easing: 'cubic-bezier(0.21, 0.61, 0.35, 1)',
        fill: 'forwards'
      });
    }

    // 4. Gray smoke particles
    var smokeCount = settings.performanceMode ? Math.round(2 * scale) : Math.round(8 * (scale > 1 ? 1.3 : scale));
    for (var j = 0; j < smokeCount; j++) {
      var s = document.createElement('div');
      var sSize = (Math.random() * 60 + 40) * scale;
      var sx = offsetX + Math.random() * w;
      var sy = offsetY + h / 2;

      s.style.cssText = [
        'position:absolute',
        'left:' + sx + 'px', 'top:' + sy + 'px',
        'width:' + sSize + 'px', 'height:' + sSize + 'px',
        'background:rgba(120, 113, 108, 0.25)',
        'border-radius:50%',
        'filter:blur(' + ((Math.random() * 12 + 8) * scale) + 'px)',
        'opacity:0', 'pointer-events:none'
      ].join(';');
      container.appendChild(s);

      var sRise = (Math.random() * 240 + 200) * scale;
      var sSway = (Math.random() - 0.5) * 160 * scale;

      s.animate([
        { transform: 'translate(-50%, -50%) translate(0, 0) scale(0.5)', opacity: 0 },
        { transform: 'translate(-50%, -50%) translate(' + (sSway * 0.4) + 'px, -' + (sRise * 0.4) + 'px) scale(1.2)', opacity: 0.3, offset: 0.3 },
        { transform: 'translate(-50%, -50%) translate(' + sSway + 'px, -' + sRise + 'px) scale(2)', opacity: 0 }
      ], {
        duration: getBeaconDuration(1400 + Math.random() * 600),
        delay: getBeaconDuration(Math.random() * 500),
        easing: 'ease-out',
        fill: 'forwards'
      });
    }

    // Append to live DOM tree exactly once at the end to prevent layout reflow invalidations
    document.documentElement.appendChild(container);

    setTimeout(function() {
      container.remove();
    }, getBeaconDuration(2200));
  }

  function animateLightning(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;

    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var color = getEffectiveColors().beacon || '#a855f7';
    var scale = getBeaconScale();

    var container = document.createElement('div');
    container.className = 'oc-beacon';
    container.style.cssText = [
      'position:fixed', 'left:0', 'top:0',
      'width:' + vw + 'px', 'height:' + vh + 'px',
      'pointer-events:none', 'z-index:2147483643',
      'overflow:hidden'
    ].join(';');
    container.style.transform = 'scale(' + scale + ')';
    container.style.transformOrigin = cx + 'px ' + cy + 'px';
    document.documentElement.appendChild(container);

    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.style.cssText = 'width:100%; height:100%; overflow:visible; display:block;';
    container.appendChild(svg);

    var defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    var filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
    filter.setAttribute('id', 'oc-lightning-glow');
    var blur = document.createElementNS('http://www.w3.org/2000/svg', 'feGaussianBlur');
    blur.setAttribute('stdDeviation', '4');
    blur.setAttribute('result', 'coloredBlur');
    var merge = document.createElementNS('http://www.w3.org/2000/svg', 'feMerge');
    var mergeNode1 = document.createElementNS('http://www.w3.org/2000/svg', 'feMergeNode');
    mergeNode1.setAttribute('in', 'coloredBlur');
    var mergeNode2 = document.createElementNS('http://www.w3.org/2000/svg', 'feMergeNode');
    mergeNode2.setAttribute('in', 'SourceGraphic');
    merge.appendChild(mergeNode1);
    merge.appendChild(mergeNode2);
    filter.appendChild(blur);
    filter.appendChild(merge);
    defs.appendChild(filter);
    svg.appendChild(defs);

    var corners = settings.performanceMode ? [
      { x: 0, y: 0 },
      { x: vw, y: 0 }
    ] : [
      { x: 0, y: 0 },
      { x: vw, y: 0 },
      { x: 0, y: vh },
      { x: vw, y: vh }
    ];

    var paths = [];

    corners.forEach(function (corner) {
      var segments = settings.performanceMode ? 6 : 12;
      var displace = settings.performanceMode ? 25 : 45;
      var points = [];
      points.push({ x: corner.x, y: corner.y });

      for (var i = 1; i < segments; i++) {
        var t = i / segments;
        var px = corner.x + (cx - corner.x) * t;
        var py = corner.y + (cy - corner.y) * t;

        var dx = cx - corner.x;
        var dy = cy - corner.y;
        var len = Math.sqrt(dx * dx + dy * dy);
        var nx = -dy / len;
        var ny = dx / len;

        var jitter = displace * Math.sin(t * Math.PI) * (Math.random() - 0.5) * 2;
        px += nx * jitter;
        py += ny * jitter;

        points.push({ x: px, y: py });
      }
      points.push({ x: cx, y: cy });

      var d = 'M ' + points[0].x + ' ' + points[0].y;
      for (var p = 1; p < points.length; p++) {
        d += ' L ' + points[p].x + ' ' + points[p].y;
      }

      var glowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      glowPath.setAttribute('d', d);
      glowPath.setAttribute('stroke', color);
      glowPath.setAttribute('stroke-width', '6');
      glowPath.setAttribute('fill', 'none');
      glowPath.setAttribute('filter', 'url(#oc-lightning-glow)');
      glowPath.setAttribute('stroke-linecap', 'round');
      glowPath.setAttribute('stroke-linejoin', 'round');
      glowPath.style.opacity = '0.8';
      svg.appendChild(glowPath);

      var corePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      corePath.setAttribute('d', d);
      corePath.setAttribute('stroke', '#ffffff');
      corePath.setAttribute('stroke-width', '2');
      corePath.setAttribute('fill', 'none');
      corePath.setAttribute('stroke-linecap', 'round');
      corePath.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(corePath);

      paths.push({ glow: glowPath, core: corePath });
    });

    var travelDuration = getBeaconDuration(350);

    paths.forEach(function (p) {
      var totalLength = 1500;
      try {
        totalLength = p.core.getTotalLength() || 1500;
      } catch (e) {}

      p.glow.setAttribute('stroke-dasharray', totalLength);
      p.glow.setAttribute('stroke-dashoffset', totalLength);
      p.core.setAttribute('stroke-dasharray', totalLength);
      p.core.setAttribute('stroke-dashoffset', totalLength);

      p.glow.animate([
        { strokeDashoffset: totalLength },
        { strokeDashoffset: '0' }
      ], {
        duration: travelDuration,
        easing: 'ease-out',
        fill: 'forwards'
      });

      p.core.animate([
        { strokeDashoffset: totalLength },
        { strokeDashoffset: '0' }
      ], {
        duration: travelDuration,
        easing: 'ease-out',
        fill: 'forwards'
      });
    });

    setTimeout(function () {
      var flashBg = document.createElement('div');
      flashBg.style.cssText = [
        'position:absolute', 'left:0', 'top:0', 'width:100%', 'height:100%',
        'background:#ffffff', 'opacity:0', 'pointer-events:none'
      ].join(';');
      container.appendChild(flashBg);
      flashBg.animate([
        { opacity: 0.3 },
        { opacity: 0, offset: 0.8 }
      ], {
        duration: getBeaconDuration(300),
        easing: 'ease-out',
        fill: 'forwards'
      });

      var flashCircle = document.createElement('div');
      var fw = rect.width + 60;
      var fh = rect.height + 60;
      flashCircle.style.cssText = [
        'position:absolute',
        'left:' + (cx - fw / 2) + 'px', 'top:' + (cy - fh / 2) + 'px',
        'width:' + fw + 'px', 'height:' + fh + 'px',
        'background:radial-gradient(circle, #ffffff 10%, ' + color + ' 60%, transparent 100%)',
        'border-radius:50%',
        'filter:drop-shadow(0 0 25px ' + color + ')',
        'transform-origin:center',
        'opacity:1', 'pointer-events:none'
      ].join(';');
      container.appendChild(flashCircle);

      flashCircle.animate([
        { transform: 'scale(0.5)', opacity: 1 },
        { transform: 'scale(1.4)', opacity: 1, offset: 0.2 },
        { transform: 'scale(1.1)', opacity: 0.9, offset: 0.7 },
        { transform: 'scale(1.8) scaleY(0)', opacity: 0 }
      ], {
        duration: getBeaconDuration(700),
        easing: 'cubic-bezier(0.19, 1, 0.22, 1)',
        fill: 'forwards'
      });

      for (var j = 0; j < 3; j++) {
        var flickerGlow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        var fd = 'M ' + cx + ' ' + cy;
        var fx = cx;
        var fy = cy;
        for (var k = 0; k < 3; k++) {
          fx += (Math.random() - 0.5) * 80;
          fy += (Math.random() - 0.5) * 80;
          fd += ' L ' + fx + ' ' + fy;
        }
        flickerGlow.setAttribute('d', fd);
        flickerGlow.setAttribute('stroke', color);
        flickerGlow.setAttribute('stroke-width', '4');
        flickerGlow.setAttribute('fill', 'none');
        svg.appendChild(flickerGlow);

        var flickerCore = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        flickerCore.setAttribute('d', fd);
        flickerCore.setAttribute('stroke', '#ffffff');
        flickerCore.setAttribute('stroke-width', '1.5');
        flickerCore.setAttribute('fill', 'none');
        svg.appendChild(flickerCore);

        var flickAnim = [
          { opacity: 1 },
          { opacity: 0, offset: 0.2 },
          { opacity: 0.8, offset: 0.4 },
          { opacity: 0, offset: 0.6 },
          { opacity: 0.9, offset: 0.8 },
          { opacity: 0 }
        ];

        flickerGlow.animate(flickAnim, { duration: getBeaconDuration(400), fill: 'forwards' });
        flickerCore.animate(flickAnim, { duration: getBeaconDuration(400), fill: 'forwards' });
      }

      paths.forEach(function (p) {
        p.glow.animate([{ opacity: 0.8 }, { opacity: 0 }], { duration: getBeaconDuration(150), fill: 'forwards' });
        p.core.animate([{ opacity: 1 }, { opacity: 0 }], { duration: getBeaconDuration(150), fill: 'forwards' });
      });

    }, travelDuration);

    setTimeout(function () {
      container.remove();
    }, travelDuration + getBeaconDuration(1000));
  }

  function animateElectronCloud(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;

    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var color = getEffectiveColors().beacon || '#38bdf8';
    var scale = getBeaconScale();

    var container = document.createElement('div');
    container.className = 'oc-beacon';
    container.style.cssText = [
      'position:fixed', 'left:0', 'top:0',
      'width:' + vw + 'px', 'height:' + vh + 'px',
      'pointer-events:none', 'z-index:2147483643',
      'overflow:hidden'
    ].join(';');
    container.style.transform = 'scale(' + scale + ')';
    container.style.transformOrigin = cx + 'px ' + cy + 'px';
    document.documentElement.appendChild(container);

    var canvas = document.createElement('canvas');
    var dpr = window.devicePixelRatio || 1;
    canvas.width = vw * dpr;
    canvas.height = vh * dpr;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    container.appendChild(canvas);

    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    var r = Math.max(rect.width, rect.height, 60) * 1.35;
    var a = r * 1.5;
    var b = r * 0.6;

    var thetas = [
      Math.PI / 2,
      Math.PI / 6,
      5 * Math.PI / 6
    ];

    var duration = getBeaconDuration(1800);
    var speed = 0.007 * (1800 / duration);
    var phaseOffsets = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3];

    var orbitalCount = settings.performanceMode ? 1 : 3;
    var histories = [[], [], []];
    var maxHistory = settings.performanceMode ? 4 : 15;

    var startTime = performance.now();
    var animFrameId;

    function render(now) {
      var elapsed = now - startTime;
      if (elapsed >= duration) {
        cancelAnimationFrame(animFrameId);
        container.remove();
        return;
      }

      ctx.clearRect(0, 0, vw, vh);

      var pulse = 1 + 0.1 * Math.sin(elapsed * 0.01);
      var nucleusRadius = 18 * pulse;
      var grad = ctx.createRadialGradient(cx, cy, 3, cx, cy, nucleusRadius);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.2, '#ffffff');
      grad.addColorStop(0.6, color);
      grad.addColorStop(1, 'transparent');
      
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, nucleusRadius, 0, 2 * Math.PI);
      ctx.fill();

      ctx.shadowBlur = 0;
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.22;
      for (var i = 0; i < orbitalCount; i++) {
        ctx.beginPath();
        if (typeof ctx.ellipse === 'function') {
          ctx.ellipse(cx, cy, a, b, thetas[i], 0, 2 * Math.PI);
        } else {
          for (var angle = 0; angle <= 2 * Math.PI + 0.1; angle += 0.1) {
            var xu = a * Math.cos(angle);
            var yu = b * Math.sin(angle);
            var rot = thetas[i];
            var px = cx + xu * Math.cos(rot) - yu * Math.sin(rot);
            var py = cy + xu * Math.sin(rot) + yu * Math.cos(rot);
            if (angle === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1.0;

      for (var i = 0; i < orbitalCount; i++) {
        var t = speed * elapsed + phaseOffsets[i];
        var x_unrot = a * Math.cos(t);
        var y_unrot = b * Math.sin(t);
        var rot = thetas[i];
        var ex = cx + x_unrot * Math.cos(rot) - y_unrot * Math.sin(rot);
        var ey = cy + x_unrot * Math.sin(rot) + y_unrot * Math.cos(rot);

        histories[i].push({ x: ex, y: ey });
        if (histories[i].length > maxHistory) {
          histories[i].shift();
        }

        var history = histories[i];
        for (var k = 0; k < history.length; k++) {
          var ratio = k / history.length;
          var radius = 2.25 + ratio * 3.75;
          ctx.beginPath();
          ctx.arc(history[k].x, history[k].y, radius, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.globalAlpha = ratio * 0.55;
          ctx.fill();
        }
        ctx.globalAlpha = 1.0;

        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = 15;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(ex, ey, 6.75, 0, 2 * Math.PI);
        ctx.fill();
        ctx.restore();
      }

      animFrameId = requestAnimationFrame(render);
      container.__rafId = animFrameId;
    }

    animFrameId = requestAnimationFrame(render);
    container.__rafId = animFrameId;
  }

  function drawStaticActiveBorder(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;

    var x = rect.left + window.scrollX;
    var y = rect.top + window.scrollY;
    var w = rect.width;
    var h = rect.height;
    var colors = getEffectiveColors();
    var color = colors.beacon;

    var borderEl = document.createElement('div');
    borderEl.className = 'oc-beacon';
    borderEl.style.cssText = [
      'position:absolute',
      'left:' + (x - 3) + 'px', 'top:' + (y - 3) + 'px',
      'width:' + (w + 6) + 'px', 'height:' + (h + 6) + 'px',
      'border:3px solid ' + color,
      'border-radius:4px',
      'pointer-events:none',
      'z-index:2147483640'
    ].join(';');
    document.documentElement.appendChild(borderEl);
  }

  function animateReducedMotion(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;

    var x = rect.left + window.scrollX;
    var y = rect.top + window.scrollY;
    var w = rect.width;
    var h = rect.height;
    var colors = getEffectiveColors();
    var color = colors.beacon;

    if (settings.visionProfile === 'eye-strain') {
      var scale = getBeaconScale();
      var cx = rect.left + rect.width / 2;
      var cy = rect.top + rect.height / 2;
      var sw = Math.max(rect.width + 40, 80) * scale;
      var sh = Math.max(rect.height + 24, 40) * scale;

      var overlay = document.createElement('div');
      overlay.className = 'oc-beacon';
      overlay.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'right:0', 'bottom:0',
        'pointer-events:none', 'z-index:2147483641',
        'background:radial-gradient(ellipse ' + (sw * 2) + 'px ' + (sh * 2) + 'px at ' + cx + 'px ' + cy + 'px, transparent 20%, rgba(28, 25, 22, 0.45) 80%)'
      ].join(';');
      document.documentElement.appendChild(overlay);

      var glow = document.createElement('div');
      glow.className = 'oc-beacon';
      glow.style.cssText = [
        'position:absolute',
        'left:' + (x - 6) + 'px', 'top:' + (y - 6) + 'px',
        'width:' + (w + 12) + 'px', 'height:' + (h + 12) + 'px',
        'background:' + hexToRgba(color, 0.15),
        'border:2.5px solid ' + color,
        'border-radius:4px',
        'box-shadow:0 0 16px ' + color,
        'pointer-events:none',
        'z-index:2147483640'
      ].join(';');
      document.documentElement.appendChild(glow);

      var leftArrow = document.createElement('div');
      leftArrow.className = 'oc-beacon';
      leftArrow.textContent = '▶';
      var arrowSize = Math.max(20, 24 * scale);
      leftArrow.style.cssText = [
        'position:absolute',
        'left:' + (x - 36 * scale) + 'px',
        'top:' + (y + h/2 - arrowSize/2) + 'px',
        'width:' + (30 * scale) + 'px', 'height:' + arrowSize + 'px',
        'line-height:' + arrowSize + 'px',
        'font-size:' + arrowSize + 'px',
        'font-weight:bold',
        'color:' + color,
        'pointer-events:none',
        'z-index:2147483642',
        'text-align:right',
        'opacity:0'
      ].join(';');
      document.documentElement.appendChild(leftArrow);

      var rightArrow = document.createElement('div');
      rightArrow.className = 'oc-beacon';
      rightArrow.textContent = '◀';
      rightArrow.style.cssText = [
        'position:absolute',
        'left:' + (x + w + 6 * scale) + 'px',
        'top:' + (y + h/2 - arrowSize/2) + 'px',
        'width:' + (30 * scale) + 'px', 'height:' + arrowSize + 'px',
        'line-height:' + arrowSize + 'px',
        'font-size:' + arrowSize + 'px',
        'font-weight:bold',
        'color:' + color,
        'pointer-events:none',
        'z-index:2147483642',
        'text-align:left',
        'opacity:0'
      ].join(';');
      document.documentElement.appendChild(rightArrow);

      var duration = getBeaconDuration(2500);

      overlay.animate([
        { opacity: 0 },
        { opacity: 1, offset: 0.15 },
        { opacity: 1, offset: 0.85 },
        { opacity: 0 }
      ], { duration: duration, fill: 'forwards' });

      var anim = glow.animate([
        { opacity: 0 },
        { opacity: 1, offset: 0.15 },
        { opacity: 1, offset: 0.85 },
        { opacity: 0 }
      ], { duration: duration, fill: 'forwards' });

      leftArrow.animate([
        { opacity: 0, transform: 'translateX(-' + (10 * scale) + 'px)' },
        { opacity: 1, transform: 'translateX(0)', offset: 0.15 },
        { opacity: 1, transform: 'translateX(0)', offset: 0.85 },
        { opacity: 0, transform: 'translateX(-' + (5 * scale) + 'px)' }
      ], { duration: duration, fill: 'forwards' });

      rightArrow.animate([
        { opacity: 0, transform: 'translateX(' + (10 * scale) + 'px)' },
        { opacity: 1, transform: 'translateX(0)', offset: 0.15 },
        { opacity: 1, transform: 'translateX(0)', offset: 0.85 },
        { opacity: 0, transform: 'translateX(' + (5 * scale) + 'px)' }
      ], { duration: duration, fill: 'forwards' });

      anim.finished.then(function () {
        overlay.remove();
        glow.remove();
        leftArrow.remove();
        rightArrow.remove();
      }).catch(function () {
        overlay.remove();
        glow.remove();
        leftArrow.remove();
        rightArrow.remove();
      });
      return;
    }

    var glow = document.createElement('div');
    glow.className = 'oc-beacon';
    glow.style.cssText = [
      'position:absolute',
      'left:' + (x - 4) + 'px', 'top:' + (y - 4) + 'px',
      'width:' + (w + 8) + 'px', 'height:' + (h + 8) + 'px',
      'background:' + hexToRgba(color, 0.25),
      'border:2px solid ' + color,
      'border-radius:4px',
      'box-shadow:0 0 12px ' + color,
      'pointer-events:none',
      'z-index:2147483640'
    ].join(';');
    document.documentElement.appendChild(glow);

    var anim = glow.animate([
      { opacity: 0 },
      { opacity: 1, offset: 0.15 },
      { opacity: 1, offset: 0.85 },
      { opacity: 0 }
    ], {
      duration: 3000,
      easing: 'ease-in-out',
      fill: 'forwards'
    });

    anim.finished.then(function () {
      glow.remove();
    }).catch(function () {
      glow.remove();
    });
  }

  function drawActiveMatchBorder(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;
    var borderStyle = (settings.visionSettings && settings.visionSettings.borderStyle) ? settings.visionSettings.borderStyle : 'none';
    if (borderStyle === 'none') return;

    var borderWidth = '2px';
    if (borderStyle === 'thin') borderWidth = '1px';
    else if (borderStyle === 'thick') borderWidth = '4px';

    var x = rect.left + window.scrollX;
    var y = rect.top + window.scrollY;
    var w = rect.width;
    var h = rect.height;
    var colors = getEffectiveColors();
    var color = colors.active;

    var borderEl = document.createElement('div');
    borderEl.className = 'oc-beacon';
    borderEl.style.cssText = [
      'position:absolute',
      'left:' + (x - 2) + 'px', 'top:' + (y - 2) + 'px',
      'width:' + (w + 4) + 'px', 'height:' + (h + 4) + 'px',
      'border:' + borderWidth + ' solid ' + color,
      'border-radius:4px',
      'pointer-events:none',
      'z-index:2147483640',
      'box-shadow:0 0 8px ' + color,
      'opacity:0'
    ].join(';');
    document.documentElement.appendChild(borderEl);

    borderEl.animate([
      { opacity: 0 },
      { opacity: 1 }
    ], {
      duration: 200,
      fill: 'forwards'
    });
  }

  function drawActiveMatchShape(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;
    
    var palette = (settings.visionSettings && settings.visionSettings.colorPalette) ? settings.visionSettings.colorPalette : 'default';
    var isColorBlind = (palette === 'deuteranopia' || palette === 'protanopia' || palette === 'tritanopia');
    if (!isColorBlind) return;

    var colors = getEffectiveColors();
    var activeColor = colors.active;

    var shape = document.createElement('div');
    shape.className = 'oc-beacon';
    
    var mx = rect.right + window.scrollX + 4;
    var my = rect.top + window.scrollY + rect.height / 2 - 4;

    shape.style.cssText = [
      'position:absolute',
      'left:' + mx + 'px', 'top:' + my + 'px',
      'width:10px', 'height:10px',
      'background:' + activeColor,
      'border-radius:50%',
      'pointer-events:none',
      'z-index:2147483640',
      'box-shadow:0 0 6px ' + activeColor
    ].join(';');
    
    document.documentElement.appendChild(shape);
  }

  function drawActiveMatchLabel(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;
    if (!settings.visionSettings || !settings.visionSettings.textLabels) return;

    var existing = document.getElementById('oc-active-match-label');
    if (existing) existing.remove();

    var label = document.createElement('div');
    label.id = 'oc-active-match-label';
    label.className = 'oc-beacon';
    
    var colors = getEffectiveColors();
    var color = colors.beacon;
    
    label.style.cssText = [
      'position:absolute',
      'background:#0f172a',
      'color:#ffffff',
      'border:2px solid ' + color,
      'border-radius:4px',
      'padding:4px 8px',
      'font-family:system-ui, -apple-system, sans-serif',
      'font-size:11px',
      'font-weight:700',
      'z-index:2147483645',
      'pointer-events:none',
      'white-space:nowrap',
      'box-shadow:0 4px 10px rgba(0,0,0,0.4)',
      'opacity:0'
    ].join(';');

    label.textContent = 'Match #' + (activeIndex + 1) + ' of ' + searchRanges.length;
    document.documentElement.appendChild(label);

    var lw = label.offsetWidth || 100;
    var lh = label.offsetHeight || 22;
    var lx = rect.left + window.scrollX + rect.width / 2 - lw / 2;
    var ly = rect.top + window.scrollY - lh - 8;
    
    var maxLeft = Math.max(0, document.documentElement.scrollWidth - lw - 10);
    var maxTop = Math.max(0, document.documentElement.scrollHeight - lh - 10);
    lx = Math.min(Math.max(10, lx), maxLeft);
    ly = Math.min(Math.max(10, ly), maxTop);

    label.style.left = lx + 'px';
    label.style.top = ly + 'px';

    label.animate([
      { opacity: 0 },
      { opacity: 1 }
    ], {
      duration: 250,
      fill: 'forwards'
    });
  }

  function animate(rect) {
    if (!wrap) return;
    cancelBeacons();

    var motion = (settings.visionSettings && settings.visionSettings.motionSensitivity) ? settings.visionSettings.motionSensitivity : 'full';

    // Draw accessibility overlays (border + label) if motion is not completely off
    if (motion !== 'off') {
      drawActiveMatchBorder(rect);
    }
    drawActiveMatchLabel(rect);
    drawActiveMatchShape(rect);

    if (motion === 'off') {
      drawStaticActiveBorder(rect);
      return;
    }

    if (motion === 'reduced') {
      animateReducedMotion(rect);
      return;
    }

    // Lite Mode uses the selected effect but scales down the particle counts
    // and complex geometries inside each effect function.
    var effectKey = settings.effect;
    var effectObj = effectsRegistry[effectKey] || effectsRegistry.hud;
    if (effectObj && typeof effectObj.run === 'function') {
      activeBeacons++;
      effectObj.run(rect);
    }
  }

  // ── Match scanning ────────────────────────────────────────────────────────────

  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };

  function foldAccentsSafe(str) {
    var result = '';
    for (var i = 0; i < str.length; i++) {
      var char = str[i];
      var folded = char.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      result += (folded.length === 1) ? folded : char;
    }
    return result;
  }

  function performSearch(term) {
    try {
      if (typeof Highlight !== 'undefined' && CSS.highlights) {
        CSS.highlights.delete('oculist-match');
        CSS.highlights.delete('oculist-active-match');
      }
    } catch (e) {}

    searchRanges = [];
    activeIndex = -1;
    firstEnter = false;
    clearViewportMarkers();

    if (!term) {
      countEl.textContent = '';
      setNavEnabled(false);
      return;
    }

    var normalizedTerm = foldAccentsSafe(term.toLowerCase()).replace(/\s+/g, ' ');
    var flatText = '';
    var textNodeMaps = [];

    var BLOCK_TAGS = {
      ADDRESS: 1, ARTICLE: 1, ASIDE: 1, BLOCKQUOTE: 1, DETAILS: 1, DIALOG: 1,
      DIV: 1, DL: 1, DT: 1, DD: 1, FIELDSET: 1, FIGCAPTION: 1, FIGURE: 1,
      FOOTER: 1, FORM: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
      HEADER: 1, HGROUP: 1, HR: 1, LI: 1, MAIN: 1, NAV: 1, OL: 1, P: 1,
      PRE: 1, SECTION: 1, TABLE: 1, UL: 1, TR: 1, TD: 1, TH: 1,
      THEAD: 1, TBODY: 1, TFOOT: 1, BR: 1
    };

    function traverse(node) {
      if (!node) return;

      var isBlock = node.nodeType === 1 && BLOCK_TAGS[node.tagName];
      if (isBlock) {
        if (flatText.length > 0 && flatText[flatText.length - 1] !== '\n') {
          flatText += '\n';
        }
      }

      var child = node.firstChild;
      while (child) {
        if (child.nodeType === 3) {
          var parent = child.parentElement || (child.parentNode && child.parentNode.host);
          if (parent && !SKIP_TAGS[parent.tagName] && !parent.classList.contains('oc-beacon')) {
            var nodeStyle = window.getComputedStyle(parent);
            if (nodeStyle && nodeStyle.display !== 'none' && nodeStyle.visibility !== 'hidden') {
              var content = child.textContent;
              var startOffset = flatText.length;
              var rawIndexMap = [];
              var normalizedContent = '';
              var lastWasSpace = false;

              for (var c = 0; c < content.length; c++) {
                var char = content[c];
                var isSpace = char === ' ' || char === '\n' || char === '\r' || char === '\t';
                if (isSpace) {
                  if (!lastWasSpace) {
                    normalizedContent += ' ';
                    rawIndexMap.push(c);
                    lastWasSpace = true;
                  }
                } else {
                  normalizedContent += char;
                  rawIndexMap.push(c);
                  lastWasSpace = false;
                }
              }

              flatText += normalizedContent;
              var endOffset = flatText.length;
              textNodeMaps.push({
                node: child,
                start: startOffset,
                end: endOffset,
                rawIndexMap: rawIndexMap
              });
            }
          }
        } else if (child.nodeType === 1) {
          if (!SKIP_TAGS[child.tagName] && !child.classList.contains('oc-beacon')) {
            if (child.shadowRoot) {
              traverse(child.shadowRoot);
            }
            traverse(child);
          }
        }
        child = child.nextSibling;
      }

      if (isBlock) {
        if (flatText.length > 0 && flatText[flatText.length - 1] !== '\n') {
          flatText += '\n';
        }
      }
    }

    traverse(document.body);

    var normalizedFlatText = foldAccentsSafe(flatText.toLowerCase());
    var index = 0;
    while ((index = normalizedFlatText.indexOf(normalizedTerm, index)) !== -1) {
      var matchStart = index;
      var matchEnd = index + normalizedTerm.length;

      var startNode = null;
      var startOffset = 0;
      var endNode = null;
      var endOffset = 0;

      for (var m = 0; m < textNodeMaps.length; m++) {
        var map = textNodeMaps[m];
        if (matchStart >= map.start && matchStart < map.end) {
          startNode = map.node;
          startOffset = map.rawIndexMap[matchStart - map.start];
        }
        if (matchEnd > map.start && matchEnd <= map.end) {
          endNode = map.node;
          endOffset = map.rawIndexMap[matchEnd - map.start - 1] + 1;
          break;
        }
      }

      if (startNode && endNode) {
        var range = document.createRange();
        range.setStart(startNode, startOffset);
        range.setEnd(endNode, endOffset);

        var rects = range.getClientRects();
        var isVisible = false;
        for (var rIndex = 0; rIndex < rects.length; rIndex++) {
          var rect = rects[rIndex];
          if (rect.width > 0 && rect.height > 0) {
            isVisible = true;
            break;
          }
        }
        if (isVisible) {
          searchRanges.push(range);
        }
      }

      index += term.length;
      if (searchRanges.length >= 999) break;
    }

    if (searchRanges.length > 0) {
      firstEnter = true;
      try {
        if (typeof Highlight !== 'undefined' && CSS.highlights) {
          var matchHighlight = new Highlight();
          searchRanges.forEach(function (r) { matchHighlight.add(r); });
          CSS.highlights.set('oculist-match', matchHighlight);
        }
      } catch (e) {
        console.warn('Oculist: CSS Custom Highlight API not supported or blocked.', e);
      }
      setNavEnabled(searchRanges.length > 1);
      countEl.textContent = '0 ' + i18n.of + ' ' + searchRanges.length;
    } else {
      countEl.textContent = i18n.noMatch;
      setNavEnabled(false);
    }

    checkSiteOverride(searchRanges.length === 0);
  }

  // ── Dynamic content re-scan (infinite scroll / DOM mutation) ───────────────────
  //
  // performSearch() rebuilds match Ranges from scratch on every call, but nothing
  // previously re-triggered it when the page's own DOM changed (e.g. reddit.com's
  // virtualized feed swaps out text nodes as you scroll). The old Ranges silently
  // detach, so highlights "vanish" without any visible error. A debounced
  // MutationObserver re-runs the last search whenever the page mutates.

  function isOculistNode(node) {
    if (!node) return false;
    if (node === wrap) return true;
    if (node.nodeType === 1) {
      if (node.id === 'oc-wrap' || node.id === 'oc-global-highlight-styles') return true;
      if (typeof node.classList !== 'undefined' && node.classList.contains('oc-beacon')) return true;
    }
    return false;
  }

  function rescanAfterMutation() {
    if (!wrap || !lastTerm) return;
    var previousActiveIndex = activeIndex;
    performSearch(lastTerm);
    if (searchRanges.length > 0) {
      activeIndex = Math.min(Math.max(previousActiveIndex, 0), searchRanges.length - 1);
      firstEnter = false;
      highlightActiveRange(false);
    }
  }

  function startDomObserver() {
    if (domObserver || !window.MutationObserver) return;
    domObserver = new window.MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (isOculistNode(m.target)) continue;
        if (domObserverTimer) clearTimeout(domObserverTimer);
        domObserverTimer = setTimeout(rescanAfterMutation, 350);
        return;
      }
    });
    domObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ── Site override detection ─────────────────────────────────────────────────
  //
  // Some sites (Google Docs/Sheets/Slides, Notion) render page text outside the
  // real DOM (canvas, custom virtualized editors) so Oculist's text-node search
  // can never find anything there — not because it's "blocked", just invisible
  // to it. We warn the user instead of leaving them wondering why 0 matches.

  function removeNotice() {
    if (noticeEl) {
      noticeEl.remove();
      noticeEl = null;
    }
  }

  function showNotice(text) {
    if (!wrapRoot || noticeDismissed || noticeEl) return;
    noticeEl = document.createElement('div');
    noticeEl.className = 'oc-notice';

    var textEl = document.createElement('span');
    textEl.className = 'oc-notice-text';
    textEl.textContent = text;

    var closeEl = document.createElement('span');
    closeEl.className = 'oc-notice-close';
    closeEl.textContent = '✕';
    closeEl.addEventListener('click', function () {
      noticeDismissed = true;
      removeNotice();
    });

    noticeEl.appendChild(textEl);
    noticeEl.appendChild(closeEl);
    wrapRoot.appendChild(noticeEl);
  }

  function checkSiteOverride(zeroMatches) {
    if (!wrap) return;
    var hostname = window.location.hostname;
    if (KNOWN_OVERRIDE_DOMAINS.indexOf(hostname) !== -1) {
      showNotice('Oculist may not find text on ' + hostname + ' — it renders content in a way standard page search can\'t scan.');
      return;
    }
    if (zeroMatches && document.body && document.body.innerText && document.body.innerText.trim().length > 500) {
      showNotice('No matches found. If you can see the text on screen, this page may render it in a way Oculist can\'t scan.');
    } else {
      removeNotice();
    }
  }

  // ── Navigation ────────────────────────────────────────────────────────────────

  function findNext(backwards) {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    var term = input.value;
    if (!term) {
      countEl.textContent = '';
      setNavEnabled(false);
      return;
    }

    if (term !== lastTerm || searchRanges.length === 0) {
      lastTerm = term;
      performSearch(term);
    }

    if (searchRanges.length === 0) {
      countEl.textContent = i18n.noMatch;
      setNavEnabled(false);
      return;
    }

    if (firstEnter) {
      firstEnter = false;
      if (backwards) {
        activeIndex = searchRanges.length - 1;
      } else {
        activeIndex = 0;
      }
    } else {
      if (backwards) {
        activeIndex = (activeIndex <= 0) ? searchRanges.length - 1 : activeIndex - 1;
      } else {
        activeIndex = (activeIndex >= searchRanges.length - 1) ? 0 : activeIndex + 1;
      }
    }

    highlightActiveRange(true);
  }

  // Display the active match with the high-visibility visual animation
  function highlightActiveRange(shouldAnimate) {
    if (searchRanges.length === 0 || activeIndex < 0) return;

    var activeRange = searchRanges[activeIndex];

    try {
      if (typeof Highlight !== 'undefined' && CSS.highlights) {
        var activeHighlight = new Highlight();
        activeHighlight.add(activeRange);
        CSS.highlights.set('oculist-active-match', activeHighlight);
      }
    } catch (e) {}

    countEl.textContent = (activeIndex + 1) + ' ' + i18n.of + ' ' + searchRanges.length;

    var rect = activeRange.getBoundingClientRect();
    var isFullyInViewport = (
      rect.top >= 0 &&
      rect.left >= 0 &&
      rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
      rect.right <= (window.innerWidth || document.documentElement.clientWidth)
    );

    if (!isFullyInViewport) {
      var element = activeRange.startContainer.parentElement;
      if (element) {
        triggerAutoScrollFlag();
        var behavior = settings.scrollBehavior === 'instant' ? 'auto' : 'smooth';
        if (shouldAnimate) {
          if (behavior === 'smooth') {
            if (activeScrollTimeout) {
              clearTimeout(activeScrollTimeout);
              activeScrollTimeout = null;
            }
            if (activeScrollEndHandler) {
              window.removeEventListener('scrollend', activeScrollEndHandler);
              activeScrollEndHandler = null;
            }
            if (activeScrollDebounceHandler) {
              window.removeEventListener('scroll', activeScrollDebounceHandler);
              activeScrollDebounceHandler = null;
            }

            var scrollTimeout = null;
            var onScrollEnd = function () {
              if (scrollTimeout) clearTimeout(scrollTimeout);
              if (activeScrollTimeout === scrollTimeout) activeScrollTimeout = null;
              window.removeEventListener('scrollend', onScrollEnd);
              window.removeEventListener('scroll', onScrollEndDebounced);
              if (activeScrollEndHandler === onScrollEnd) activeScrollEndHandler = null;
              if (activeScrollDebounceHandler === onScrollEndDebounced) activeScrollDebounceHandler = null;
              var freshRect = activeRange.getBoundingClientRect();
              animate(freshRect);
            };

            var scrollDebounceTimer = null;
            var onScrollEndDebounced = function () {
              if (scrollDebounceTimer) clearTimeout(scrollDebounceTimer);
              scrollDebounceTimer = setTimeout(onScrollEnd, 80);
            };

            scrollTimeout = setTimeout(onScrollEnd, 600);
            activeScrollTimeout = scrollTimeout;
            activeScrollEndHandler = onScrollEnd;
            activeScrollDebounceHandler = onScrollEndDebounced;

            window.addEventListener('scrollend', onScrollEnd, { once: true });
            window.addEventListener('scroll', onScrollEndDebounced);
          } else {
            setTimeout(function () {
              var freshRect = activeRange.getBoundingClientRect();
              animate(freshRect);
            }, 50);
          }
        }
        element.scrollIntoView({
          behavior: behavior,
          block: 'center',
          inline: 'nearest'
        });
      }
    } else {
      if (shouldAnimate) {
        setTimeout(function () {
          var freshRect = activeRange.getBoundingClientRect();
          animate(freshRect);
        }, 50);
      }
    }
    updateViewportMarkers();
  }

  function setNavEnabled(enabled) {
    [prevBtn, nextBtn].forEach(function(btn) {
      if (!btn) return;
      btn.disabled = !enabled;
      btn.style.opacity = enabled ? '1' : '0.35';
      btn.style.cursor = enabled ? 'pointer' : 'default';
    });
    if (replayBtn) {
      var canReplay = searchRanges.length > 0;
      replayBtn.disabled = !canReplay;
      replayBtn.style.opacity = canReplay ? '1' : '0.35';
      replayBtn.style.cursor = canReplay ? 'pointer' : 'default';
    }
  }

  var isAutoScrolling = false;
  var autoScrollTimer = null;

  function triggerAutoScrollFlag() {
    isAutoScrolling = true;
    if (autoScrollTimer) clearTimeout(autoScrollTimer);
    autoScrollTimer = setTimeout(function () {
      isAutoScrolling = false;
    }, 800);
  }

  function fadeActiveBeacons() {
    if (activeBeacons === 0) return;
    var beacons = document.querySelectorAll('.oc-beacon');
    if (beacons.length === 0) { activeBeacons = 0; return; }
    activeBeacons = 0;
    for (var i = 0; i < beacons.length; i++) {
      var b = beacons[i];
      b.style.transition = 'opacity 50ms ease-out';
      b.style.opacity = '0';
    }
    setTimeout(function () {
      for (var i = 0; i < beacons.length; i++) {
        if (beacons[i] && beacons[i].parentNode && beacons[i].style.opacity === '0') {
          beacons[i].remove();
        }
      }
    }, 50);
  }

  var viewportMarkers = [];
  var viewportMarkersTimer = null;

  function clearViewportMarkers() {
    for (var i = 0; i < viewportMarkers.length; i++) {
      if (viewportMarkers[i] && viewportMarkers[i].parentNode) {
        viewportMarkers[i].remove();
      }
    }
    viewportMarkers = [];
  }

  function updateViewportMarkers() {
    clearViewportMarkers();
    if (!wrap || searchRanges.length === 0) return;

    var palette = (settings.visionSettings && settings.visionSettings.colorPalette) ? settings.visionSettings.colorPalette : 'default';
    var isColorBlind = (palette === 'deuteranopia' || palette === 'protanopia' || palette === 'tritanopia');
    if (!isColorBlind) return;

    var colors = getEffectiveColors();
    var markerColor = colors.match;

    // Batch DOM Reads first to avoid forced layout reflows (layout thrashing)
    var visibleMatches = [];
    var viewHeight = window.innerHeight || document.documentElement.clientHeight;
    var viewWidth = window.innerWidth || document.documentElement.clientWidth;

    for (var i = 0; i < searchRanges.length; i++) {
      if (i === activeIndex) continue;

      var range = searchRanges[i];
      var rect = range.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      var isVisible = (
        rect.bottom >= 0 &&
        rect.top <= viewHeight &&
        rect.right >= 0 &&
        rect.left <= viewWidth
      );

      if (isVisible) {
        visibleMatches.push({
          left: rect.right + window.scrollX + 4,
          top: rect.top + window.scrollY + rect.height / 2 - 4
        });
      }
    }

    // Batch DOM Writes using a DocumentFragment
    if (visibleMatches.length > 0) {
      var fragment = document.createDocumentFragment();
      for (var j = 0; j < visibleMatches.length; j++) {
        var pos = visibleMatches[j];
        var marker = document.createElement('div');
        marker.className = 'oc-viewport-marker';
        marker.style.cssText = [
          'position:absolute',
          'left:' + pos.left + 'px', 'top:' + pos.top + 'px',
          'width:8px', 'height:8px',
          'border:2px solid ' + markerColor,
          'border-radius:50%',
          'background:transparent',
          'pointer-events:none',
          'z-index:2147483640'
        ].join(';');
        fragment.appendChild(marker);
        viewportMarkers.push(marker);
      }
      document.documentElement.appendChild(fragment);
    }
  }

  function scheduleViewportMarkersUpdate() {
    if (viewportMarkersTimer) clearTimeout(viewportMarkersTimer);
    viewportMarkersTimer = setTimeout(updateViewportMarkers, 100);
  }

  function handleScroll() {
    if (isAutoScrolling) return;
    fadeActiveBeacons();
    scheduleViewportMarkersUpdate();
  }

  // ── Event handlers ────────────────────────────────────────────────────────────

  function keydownHandler(e) {
    // Plain Ctrl/Cmd+F opens the finder in-page. Ctrl/Cmd+Shift+F is reserved for the
    // extension command (handled by background.js) — let it pass through to the browser.
    var isFKey = (e.key && e.key.toLowerCase() === 'f') || e.keyCode === 70 || e.code === 'KeyF';
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && isFKey) {
      var isCurrentSiteDisabled = settings.disabledSites && settings.disabledSites.indexOf(window.location.hostname) !== -1;
      var isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
      if (isCurrentSiteDisabled || isStandalone) {
        return;
      }
      try { e.preventDefault(); } catch (err) {}
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (typeof window.__ocToggle === 'function') {
        if (wrap) {
          input.focus();
          input.select();
        } else {
          window.__ocToggle();
        }
      }
      return;
    }
    if (!wrap) return;
    if (e.key === 'Escape') { window.__ocDestroy(); return; }
    
    var isGKey = (e.key && e.key.toLowerCase() === 'g') || e.keyCode === 71 || e.code === 'KeyG';
    var isF3Key = e.key === 'F3' || e.keyCode === 114;
    if (((e.ctrlKey || e.metaKey) && isGKey) || isF3Key) {
      try { e.preventDefault(); } catch (err) {}
      e.stopPropagation();
      e.stopImmediatePropagation();
      findNext(e.shiftKey);
      return;
    }
    
    if (e.key === 'Enter') {
      if (document.activeElement === wrap || wrap.contains(document.activeElement) || (wrapRoot && wrapRoot.activeElement)) {
        try { e.preventDefault(); } catch (err) {}
        findNext(e.shiftKey);
      }
    }
  }

  // ── Settings panel ────────────────────────────────────────────────────────────

  function toggleSettings() {
    var t = T();
    if (settingsPanel) {
      settingsPanel.remove();
      settingsPanel = null;
      if (gearBtn) { gearBtn.classList.remove('active'); gearBtn.style.color = t.text; }
    } else {
      buildSettingsPanel();
      if (gearBtn) { gearBtn.classList.add('active'); gearBtn.style.color = t.accent; }
    }
  }

  function makeOptionGroup(items, currentVal, onChange) {
    var group = document.createElement('div');
    group.className = 'oc-toggle-group';

    items.forEach(function (item) {
      var btn = document.createElement('button');
      btn.className = 'oc-toggle-btn' + (item.value === currentVal ? ' active' : '');
      btn.textContent = item.label;
      btn.title = item.title || item.label;
      btn.addEventListener('click', function () {
        onChange(item.value);
        group.querySelectorAll('.oc-toggle-btn').forEach(function (b) {
          b.classList.remove('active');
        });
        btn.classList.add('active');
      });
      group.appendChild(btn);
    });

    return group;
  }

  function makeRadioList(items, currentVal, onChange, disabled) {
    var list = document.createElement('div');
    list.className = 'oc-radio-list';
    if (disabled) {
      list.style.opacity = '0.5';
      list.style.pointerEvents = 'none';
    }

    items.forEach(function (item) {
      var row = document.createElement('button');
      row.className = 'oc-radio-item' + (item.value === currentVal ? ' active' : '');
      if (disabled) {
        row.disabled = true;
        row.style.cursor = 'not-allowed';
      }

      var dot = document.createElement('span');
      dot.className = 'oc-radio-dot';
      dot.textContent = item.value === currentVal ? '●' : '○';

      var lbl = document.createElement('span');
      lbl.textContent = item.label;

      row.appendChild(dot);
      row.appendChild(lbl);
      if (!disabled) {
        row.addEventListener('click', function () {
          list.querySelectorAll('.oc-radio-item').forEach(function (r) {
            r.classList.remove('active');
            var d = r.querySelector('.oc-radio-dot');
            if (d) d.textContent = '○';
          });
          row.classList.add('active');
          dot.textContent = '●';
          onChange(item.value);
        });
      }
      list.appendChild(row);
    });

    return list;
  }

  function makeSettingsField(labelText, descText, controlEl) {
    var field = document.createElement('div');
    field.className = 'oc-settings-field';

    var meta = document.createElement('div');
    meta.className = 'oc-settings-meta';

    var lbl = document.createElement('span');
    lbl.className = 'oc-settings-label';
    lbl.textContent = labelText;

    var desc = document.createElement('span');
    desc.className = 'oc-settings-desc';
    desc.textContent = descText;

    meta.appendChild(lbl);
    meta.appendChild(desc);
    
    field.appendChild(meta);
    field.appendChild(controlEl);
    return field;
  }

  function getProfileConstraints() {
    var p = settings.visionProfile;
    return {
      effectDisabled: !!(p === 'eye-strain'),
      colorsDisabled: !!(p && (p === 'eye-strain' || p.indexOf('color-blind') === 0))
    };
  }

  function buildSettingsPanel() {
    var p = P();

    settingsPanel = document.createElement('div');
    settingsPanel.id = 'oc-settings-panel';
    settingsPanel.style.fontFamily = 'system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';

    // Title / Header in Settings panel
    var header = document.createElement('div');
    header.className = 'oc-settings-header';
    
    // Left: Title + Subtitle
    var titleContainer = document.createElement('div');
    titleContainer.className = 'oc-settings-title-container';

    var title = document.createElement('span');
    title.className = 'oc-settings-title';
    title.textContent = i18n.prefTitle;
    
    var subtitle = document.createElement('span');
    subtitle.className = 'oc-settings-subtitle';
    subtitle.textContent = i18n.prefSubtitle;

    titleContainer.appendChild(title);
    titleContainer.appendChild(subtitle);
    header.appendChild(titleContainer);

    // Right: Reset Button
    var resetBtn = document.createElement('button');
    resetBtn.className = 'oc-settings-reset-btn';
    resetBtn.appendChild(document.createTextNode('↺ ' + i18n.resetBtn));
    resetBtn.addEventListener('click', function () {
      settings.effect = 'hud';
      settings.position = 'tr';
      settings.theme = 'dark';
      settings.matchColor = '#fef08a';
      settings.activeColor = '#f59e0b';
      settings.beaconColor = '#fbbf24';
      settings.scrollBehavior = 'smooth';
      saveSettings();
      applyWrapPosition();
      injectHighlightStyles();
      settingsPanel.remove();
      settingsPanel = null;
      buildSettingsPanel();
    });
    header.appendChild(resetBtn);
    settingsPanel.appendChild(header);

    if (settings.visionProfile) {
      var banner = document.createElement('div');
      banner.className = 'oc-settings-profile-banner';
      banner.style.cssText = 'background: rgba(245, 158, 11, 0.08); border: 1px solid rgba(245, 158, 11, 0.2); padding: 8px 12px; font-size: 11px; color: #fbbf24; margin: 8px 16px 0; border-radius: 6px; display: flex; align-items: center; gap: 6px; font-weight: 500;';
      
      var profileDisplay = settings.visionProfile === 'eye-strain' ? 'Eye Strain' : settings.visionProfile === 'low-vision' ? 'Low Vision' : 'Color Blind';
      banner.textContent = '⚠️ ' + profileDisplay + ' Profile overrides active settings.';
      settingsPanel.appendChild(banner);
    }

    // Grid Container
    var grid = document.createElement('div');
    grid.className = 'oc-settings-grid';

    // Col 1: Theme & Effect
    var col1 = document.createElement('div');
    col1.className = 'oc-settings-col';

    var _hostname = window.location.hostname;
    var _siteEnabled = settings.disabledSites.indexOf(_hostname) === -1;
    col1.appendChild(makeSettingsField(i18n.siteToggleLabel, i18n.siteToggleDesc, makeOptionGroup([
      { value: 'enabled',  label: i18n.enabled  },
      { value: 'disabled', label: i18n.disabled },
    ], _siteEnabled ? 'enabled' : 'disabled', function (v) {
      if (v === 'disabled') {
        if (settings.disabledSites.indexOf(_hostname) === -1) settings.disabledSites.push(_hostname);
        if (wrap) window.__ocDestroy();
      } else {
        var idx = settings.disabledSites.indexOf(_hostname);
        if (idx !== -1) settings.disabledSites.splice(idx, 1);
      }
      saveSettings();
    })));

    col1.appendChild(makeSettingsField(i18n.visualTheme, i18n.themeDesc, makeOptionGroup([
      { value: 'dark',  label: i18n.dark  },
      { value: 'light', label: i18n.light },
      { value: 'system', label: i18n.system },
    ], settings.theme, function (v) {
      settings.theme = v; saveSettings();
      injectHighlightStyles();
      applyWrapPosition();
      settingsPanel.remove(); settingsPanel = null;
      buildSettingsPanel();
    })));

    var scrollBehaviorField = makeSettingsField(i18n.scrollBehavior, i18n.scrollBehaviorDesc, makeOptionGroup([
      { value: 'smooth', label: i18n.smooth },
      { value: 'instant', label: i18n.instant }
    ], settings.scrollBehavior, function (v) {
      settings.scrollBehavior = v; saveSettings();
    }));
    scrollBehaviorField.style.marginTop = '8px';
    col1.appendChild(scrollBehaviorField);

    var effectOptions = [];
    for (var key in effectsRegistry) {
      if (effectsRegistry.hasOwnProperty(key)) {
        effectOptions.push({ value: key, label: effectsRegistry[key].label });
      }
    }
    effectOptions.sort(function (a, b) {
      return a.label.localeCompare(b.label);
    });

    var constraints = getProfileConstraints();
    var effColors = getEffectiveColors();

    var effectField = makeSettingsField(i18n.highlightEffect, i18n.effectDesc, makeRadioList(
      effectOptions,
      settings.effect,
      function (v) { settings.effect = v; saveSettings(); },
      constraints.effectDisabled
    ));
    effectField.style.marginTop = '8px';
    col1.appendChild(effectField);

    // Col 2: Position & Colors
    var col2 = document.createElement('div');
    col2.className = 'oc-settings-col';

    col2.appendChild(makeSettingsField(i18n.panelPosition, i18n.positionDesc, makeOptionGroup([
      { value: 'tl', label: '↖', title: i18n.topLeft     },
      { value: 'tr', label: '↗', title: i18n.topRight    },
      { value: 'bl', label: '↙', title: i18n.bottomLeft  },
      { value: 'br', label: '↘', title: i18n.bottomRight },
    ], settings.position, function (v) {
      settings.position = v; saveSettings();
      applyWrapPosition();
      settingsPanel.remove(); settingsPanel = null;
      buildSettingsPanel();
    })));

    var pickerGroup = document.createElement('div');
    pickerGroup.className = 'oc-settings-picker-group';

    var items = [
      { label: i18n.matchLabel, val: effColors.match, title: i18n.matchTitle, cb: function (v) { settings.matchColor = v; saveSettings(); injectHighlightStyles(); } },
      { label: i18n.activeLabel, val: effColors.active, title: i18n.activeTitle, cb: function (v) { settings.activeColor = v; saveSettings(); injectHighlightStyles(); } },
      { label: i18n.beaconColorLabel || i18n.beaconLabel, val: effColors.beacon, title: i18n.beaconTitle, cb: function (v) { settings.beaconColor = v; saveSettings(); } }
    ];

    items.forEach(function (item) {
      var picker = makeColorPicker(item.label, item.val, item.title, item.cb, constraints.colorsDisabled);
      pickerGroup.appendChild(picker);
    });

    var colorsField = makeSettingsField(i18n.customColors, i18n.colorsDesc, pickerGroup);
    colorsField.style.marginTop = '8px';
    col2.appendChild(colorsField);



    var donateBtn = document.createElement('a');
    donateBtn.className = 'oc-donate-btn';
    donateBtn.href = 'https://buymeacoffee.com/brewsforchris';
    donateBtn.target = '_blank';
    donateBtn.rel = 'noopener noreferrer';
    donateBtn.textContent = i18n.coffeeBtn;

    var donateField = makeSettingsField(i18n.supportTitle, i18n.supportDesc, donateBtn);
    donateField.style.marginTop = '8px';
    col2.appendChild(donateField);

    var feedbackBtn = document.createElement('a');
    feedbackBtn.className = 'oc-feedback-btn';
    feedbackBtn.href = 'https://tally.so/r/Xx9GdL';
    feedbackBtn.target = '_blank';
    feedbackBtn.rel = 'noopener noreferrer';
    feedbackBtn.textContent = i18n.feedbackBtn;

    var feedbackField = makeSettingsField(i18n.feedbackTitle, i18n.feedbackDesc, feedbackBtn);
    feedbackField.style.marginTop = '8px';
    col2.appendChild(feedbackField);

    grid.appendChild(col1);
    grid.appendChild(col2);
    settingsPanel.appendChild(grid);

    wrapRoot.appendChild(settingsPanel);

    settingsPanel.animate([
      { opacity: 0, transform: p.isBottom ? 'translateY(8px)' : 'translateY(-8px)' },
      { opacity: 1, transform: 'translateY(0)' }
    ], {
      duration: 180,
      easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
      fill: 'forwards'
    });
  }

  function makeColorPicker(label, val, title, onChange, disabled) {
    var badge = document.createElement('div');
    badge.className = 'oc-color-badge';
    badge.title = title;
    if (disabled) {
      badge.style.opacity = '0.5';
      badge.style.pointerEvents = 'none';
      badge.style.cursor = 'not-allowed';
    }
    
    var swatch = document.createElement('div');
    swatch.className = 'oc-color-badge-swatch';
    swatch.style.backgroundColor = val;
    
    var text = document.createElement('span');
    text.className = 'oc-color-badge-text';
    text.textContent = label;
    
    var input = document.createElement('input');
    input.type = 'color';
    input.value = val;
    input.className = 'oc-color-input';
    if (disabled) {
      input.disabled = true;
    }
    
    if (!disabled) {
      input.addEventListener('keydown', function (e) { e.stopPropagation(); });
      input.addEventListener('input', function () {
        var newColor = input.value;
        swatch.style.backgroundColor = newColor;
        onChange(newColor);
      });
    }
    
    badge.appendChild(swatch);
    badge.appendChild(text);
    badge.appendChild(input);
    return badge;
  }

  // ── Apply position / theme to live elements ───────────────────────────────────

  function applyWrapPosition() {
    var p = P();
    // Reset host-page CSS on the shadow host element so it can't override our styles
    wrap.style.cssText = '';
    wrap.style.all = 'initial';
    wrap.style.position = 'fixed';
    wrap.style.zIndex = '2147483647';
    wrap.style.display = 'flex';
    wrap.style.overflow = 'hidden';
    wrap.style.boxSizing = 'border-box';
    wrap.style.margin = '0';
    wrap.style.padding = '0';
    wrap.style.width = 'auto';
    wrap.style.height = 'auto';
    wrap.style.maxWidth = 'none';
    wrap.style.maxHeight = 'none';
    wrap.style.minWidth = '0';
    wrap.style.minHeight = '0';
    wrap.style.top = p.top;
    wrap.style.right = p.right;
    wrap.style.bottom = p.bottom;
    wrap.style.left = p.left;
    wrap.style.flexDirection = p.isBottom ? 'column-reverse' : 'column';
    wrap.style.borderRadius = p.radius;
    var t = T();
    wrap.style.background = t.bg;
    wrap.style.color = t.text;
    wrap.style.border = '1px solid ' + t.divider;
    wrap.style.boxShadow = '0 10px 30px -10px rgba(0,0,0,0.3), 0 1px 3px rgba(0,0,0,0.05)';
    wrap.style.outline = 'none';
    wrap.style.backdropFilter = 'blur(16px) saturate(180%)';
    wrap.style.webkitBackdropFilter = 'blur(16px) saturate(180%)';
    wrap.style.transition = 'border-radius 200ms, box-shadow 200ms, backdrop-filter 200ms';
    wrap.classList.toggle('is-top', !p.isBottom);
    wrap.classList.toggle('is-bottom', p.isBottom);
    wrap.classList.remove('pos-tr', 'pos-tl', 'pos-br', 'pos-bl');
    wrap.classList.add('pos-' + settings.position);
  }

  // ── UI build ──────────────────────────────────────────────────────────────────

  var ICON_CHARS = { up: '↑', down: '↓', replay: '↺', gear: '⚙', close: '✕' };

  function makeIconBtn(iconName, title) {
    var btn = document.createElement('button');
    btn.className = 'oc-' + iconName + '-btn';
    btn.textContent = ICON_CHARS[iconName] || '';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    return btn;
  }

  function buildUI() {
    wrap = document.createElement('div');
    wrap.id = 'oc-wrap';
    wrapRoot = wrap.attachShadow({ mode: 'open' });
    applyWrapPosition();

    bar = document.createElement('div');
    bar.className = 'oc-bar';

    input = document.createElement('input');
    input.type = 'text';
    input.placeholder = i18n.findPlaceholder;
    input.setAttribute('aria-label', 'Find in page');
    input.className = 'oc-input';
    input.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'f') {
        try { e.preventDefault(); } catch (err) {}
        input.focus();
        input.select();
        e.stopPropagation();
        return;
      }
      e.stopPropagation();
    });
    input.addEventListener('focus', function () {
      wrap.setAttribute('contenteditable', 'true');
    });
    input.addEventListener('blur', function () {
      wrap.removeAttribute('contenteditable');
    });
    input.addEventListener('input', function () {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        var term = input.value;
        lastTerm = term;
        performSearch(term);
        if (searchRanges.length > 0) {
          activeIndex = 0;
          highlightActiveRange(false);
        }
      }, settings.performanceMode ? 400 : 150);
    });

    countEl = document.createElement('span');
    countEl.className = 'oc-count';

    prevBtn = makeIconBtn('up', i18n.prevTitle);
    prevBtn.addEventListener('click', function () { findNext(true); });

    nextBtn = makeIconBtn('down', i18n.nextTitle);
    nextBtn.addEventListener('click', function () { findNext(false); });

    replayBtn = makeIconBtn('replay', i18n.replayTitle);
    replayBtn.addEventListener('click', function () { highlightActiveRange(true); });

    gearBtn = makeIconBtn('gear', i18n.optionsTitle);
    gearBtn.addEventListener('click', toggleSettings);

    closeBtn = makeIconBtn('close', i18n.closeTitle);
    closeBtn.addEventListener('click', window.__ocDestroy);

    setNavEnabled(false);

    bar.appendChild(input);
    bar.appendChild(countEl);
    bar.appendChild(prevBtn);
    bar.appendChild(nextBtn);
    bar.appendChild(replayBtn);
    bar.appendChild(gearBtn);
    bar.appendChild(closeBtn);

    wrapRoot.appendChild(bar);
    document.body.appendChild(wrap);
    input.focus();
  }

  function getContrastColor(hex) {
    if (!hex) return '#1a1a2e';
    var c = hex.substring(1);
    if (c.length === 3) c = c[0]+c[0]+c[1]+c[1]+c[2]+c[2];
    var rgb = parseInt(c, 16);
    var r = (rgb >> 16) & 0xff;
    var g = (rgb >> 8) & 0xff;
    var b = (rgb >> 0) & 0xff;
    var luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luma < 128 ? '#ffffff' : '#1a1a2e';
  }

  function hexToRgba(hex, alpha) {
    if (!hex) return 'rgba(245, 158, 11, ' + alpha + ')';
    var c = hex.substring(1);
    if (c.length === 3) c = c[0]+c[0]+c[1]+c[1]+c[2]+c[2];
    var rgb = parseInt(c, 16);
    var r = (rgb >> 16) & 0xff;
    var g = (rgb >> 8) & 0xff;
    var b = (rgb >> 0) & 0xff;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  function hexToHsl(hex) {
    var c = hex.replace('#', '');
    if (c.length === 3) c = c[0]+c[0]+c[1]+c[1]+c[2]+c[2];
    var r = parseInt(c.substr(0,2),16)/255, g = parseInt(c.substr(2,2),16)/255, b = parseInt(c.substr(4,2),16)/255;
    var max = Math.max(r,g,b), min = Math.min(r,g,b), h, s, l = (max+min)/2;
    if (max === min) { h = s = 0; } else {
      var d = max - min;
      s = l > 0.5 ? d/(2-max-min) : d/(max+min);
      if (max === r) h = ((g-b)/d + (g<b?6:0))/6;
      else if (max === g) h = ((b-r)/d + 2)/6;
      else h = ((r-g)/d + 4)/6;
    }
    return [h*360, s*100, l*100];
  }

  function hslToHex(h, s, l) {
    h = ((h%360)+360)%360; s = Math.max(0,Math.min(100,s))/100; l = Math.max(0,Math.min(100,l))/100;
    var c = (1-Math.abs(2*l-1))*s, x = c*(1-Math.abs((h/60)%2-1)), m = l-c/2, r=0,g=0,b=0;
    if      (h<60)  { r=c;g=x;b=0; } else if (h<120) { r=x;g=c;b=0; }
    else if (h<180) { r=0;g=c;b=x; } else if (h<240) { r=0;g=x;b=c; }
    else if (h<300) { r=x;g=0;b=c; } else            { r=c;g=0;b=x; }
    return '#'+[r,g,b].map(function(v){return Math.round((v+m)*255).toString(16).padStart(2,'0');}).join('');
  }

  function injectHighlightStyles() {
    var globalStyleId = 'oc-global-highlight-styles';
    var globalEl = document.getElementById(globalStyleId);

    var colors = getEffectiveColors();
    var matchColor = colors.match;
    var activeColor = colors.active;
    var matchTextColor = getContrastColor(matchColor);
    var activeTextColor = getContrastColor(activeColor);

    var designTokensCss = [
      ':root {',
      '  --oc-size-scale-s: 0.7;',
      '  --oc-size-scale-m: 1.0;',
      '  --oc-size-scale-l: 1.5;',
      '  --oc-size-scale-xl: 2.25;',
      '  --oc-duration-fast: 1000ms;',
      '  --oc-duration-normal: 2000ms;',
      '  --oc-duration-slow: 3500ms;',
      '  --oc-border-width-none: 0px;',
      '  --oc-border-width-thin: 1px;',
      '  --oc-border-width-medium: 2px;',
      '  --oc-border-width-thick: 4px;',
      '  --oc-palette-deuteranopia-match: #fef08a;',
      '  --oc-palette-deuteranopia-active: #0284c7;',
      '  --oc-palette-deuteranopia-beacon: #0284c7;',
      '  --oc-palette-protanopia-match: #fef08a;',
      '  --oc-palette-protanopia-active: #2563eb;',
      '  --oc-palette-protanopia-beacon: #2563eb;',
      '  --oc-palette-tritanopia-match: #ffcbd1;',
      '  --oc-palette-tritanopia-active: #06b6d4;',
      '  --oc-palette-tritanopia-beacon: #06b6d4;',
      '  --oc-palette-warm-match: #fef08a;',
      '  --oc-palette-warm-active: #d97706;',
      '  --oc-palette-warm-beacon: #eab308;',
      '}'
    ].join('\n');

    var highlightCss = [
      designTokensCss,
      '::highlight(oculist-match) { background-color: ' + matchColor + '; color: ' + matchTextColor + '; }',
      '::highlight(oculist-active-match) { background-color: ' + activeColor + '; color: ' + activeTextColor + '; }',
      '.oc-beacon { will-change: transform, opacity; transition: opacity 50ms ease-out; }'
    ].join('\n');

    if (globalEl) {
      globalEl.textContent = highlightCss;
    } else {
      try {
        var s = document.createElement('style');
        s.id = globalStyleId;
        s.textContent = highlightCss;
        document.head.appendChild(s);
      } catch (e) {
        console.warn('Oculist: Global highlight style injection failed', e);
      }
    }

    if (wrapRoot) {
      var dialogStyleId = 'oc-dialog-styles';
      var dialogEl = wrapRoot.querySelector('#' + dialogStyleId);

      var t = T();
      var activeTheme = getActiveThemeName();

      var dialogCss = [
        ':host {',
        '  position: fixed;',
        '  z-index: 2147483647;',
        '  display: flex;',
        '  overflow: hidden;',
        '  box-shadow: 0 10px 30px -10px rgba(0,0,0,0.3), 0 1px 3px rgba(0,0,0,0.05);',
        '  backdrop-filter: blur(16px) saturate(180%);',
        '  -webkit-backdrop-filter: blur(16px) saturate(180%);',
        '  transition: border-radius 200ms, box-shadow 200ms, backdrop-filter 200ms;',
        '  border: 1px solid ' + t.divider + ';',
        '  background: ' + t.bg + ';',
        '  --oc-bg: ' + t.bg + ';',
        '  --oc-text: ' + t.text + ';',
        '  --oc-subtle: ' + t.subtle + ';',
        '  --oc-input-bg: ' + t.inputBg + ';',
        '  --oc-input-border: ' + t.inputBorder + ';',
        '  --oc-input-text: ' + t.inputText + ';',
        '  --oc-accent: ' + t.accent + ';',
        '  --oc-panel-bg: ' + t.panelBg + ';',
        '  --oc-divider: ' + t.divider + ';',
        '  --oc-btn-active-bg: ' + (activeTheme === 'dark' ? '#27272a' : '#ffffff') + ';',
        '  --oc-btn-active-text: ' + (activeTheme === 'dark' ? '#fafafa' : '#09090b') + ';',
        '  --oc-btn-hover-bg: ' + (activeTheme === 'dark' ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)') + ';',
        '  --oc-accent-alpha: ' + hexToRgba(colors.beacon, 0.2) + ';',
        '  font-family: system-ui, -apple-system, sans-serif;',
        '}',
        '.oc-bar {',
        '  --oc-bg: ' + t.bg + ';',
        '  --oc-text: ' + t.text + ';',
        '  --oc-subtle: ' + t.subtle + ';',
        '  --oc-input-bg: ' + t.inputBg + ';',
        '  --oc-input-border: ' + t.inputBorder + ';',
        '  --oc-input-text: ' + t.inputText + ';',
        '  --oc-accent: ' + t.accent + ';',
        '  --oc-panel-bg: ' + t.panelBg + ';',
        '  --oc-divider: ' + t.divider + ';',
        '  display: flex;',
        '  align-items: center;',
        '  gap: 6px;',
        '  padding: 6px 10px;',
        '  font: 14px/1 system-ui, -apple-system, sans-serif;',
        '  background: ' + t.bg + ';',
        '  color: ' + t.text + ';',
        '}',
        ':host(.pos-tr) .oc-bar, :host(.pos-br) .oc-bar {',
        '  align-self: flex-end;',
        '}',
        ':host(.pos-tl) .oc-bar, :host(.pos-bl) .oc-bar {',
        '  align-self: flex-start;',
        '}',
        'input.oc-input {',
        '  border: 1px solid var(--oc-input-border);',
        '  border-radius: 6px;',
        '  background: var(--oc-input-bg);',
        '  color: var(--oc-input-text);',
        '  padding: 4px 8px;',
        '  font-size: 14px;',
        '  width: 200px;',
        '  flex-shrink: 0;',
        '  outline: none;',
        '  font-family: system-ui, -apple-system, sans-serif;',
        '  transition: border-color 150ms, box-shadow 150ms;',
        '  box-sizing: border-box;',
        '  margin: 0;',
        '  height: auto;',
        '}',
        'input.oc-input:focus {',
        '  border-color: var(--oc-accent);',
        '  box-shadow: 0 0 0 2px var(--oc-accent-alpha);',
        '}',
        '.oc-count {',
        '  color: ' + t.text + ';',
        '  opacity: 0.75;',
        '  font-size: 12px;',
        '  min-width: 58px;',
        '  flex-shrink: 0;',
        '  text-align: right;',
        '  font-family: system-ui, -apple-system, sans-serif;',
        '  margin-right: 2px;',
        '  user-select: none;',
        '  white-space: nowrap;',
        '}',
        'button, .oc-bar button {',
        '  color: ' + t.text + ';',
        '  background: none;',
        '  border: none;',
        '  padding: 0;',
        '  font-size: 14px;',
        '  font-family: system-ui, -apple-system, sans-serif;',
        '  border-radius: 4px;',
        '  display: inline-flex;',
        '  align-items: center;',
        '  justify-content: center;',
        '  transition: color 150ms, background-color 150ms, transform 150ms;',
        '  box-shadow: none;',
        '  margin: 0;',
        '  width: auto;',
        '  height: auto;',
        '  min-width: 0;',
        '  min-height: 0;',
        '  max-width: none;',
        '  max-height: none;',
        '  line-height: 1;',
        '  text-transform: none;',
        '  text-decoration: none;',
        '  cursor: pointer;',
        '}',
        '.oc-bar button.oc-gear-btn {',
        '  font-size: 21px;',
        '  transform: translateY(-1px);',
        '}',
        '.oc-bar button {',
        '  width: 26px;',
        '  height: 26px;',
        '  min-width: 26px;',
        '  min-height: 26px;',
        '  max-width: 26px;',
        '  max-height: 26px;',
        '  flex-shrink: 0;',
        '  box-sizing: border-box;',
        '}',
        'button:hover, .oc-bar button:hover {',
        '  color: ' + t.accent + ';',
        '  background-color: ' + (settings.theme === 'dark' ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)') + ';',
        '  transform: scale(1.05);',
        '}',
        'button:active, .oc-bar button:active {',
        '  transform: scale(0.95);',
        '}',
        'button.active, .oc-bar button.active {',
        '  color: ' + t.accent + ';',
        '}',
        'button:disabled, .oc-bar button:disabled {',
        '  opacity: 0.35;',
        '  cursor: default;',
        '  transform: none;',
        '  background: none;',
        '  color: ' + t.text + ';',
        '}',
        '#oc-settings-panel {',
        '  background: var(--oc-panel-bg);',
        '  padding: 14px 16px;',
        '  display: flex;',
        '  flex-direction: column;',
        '  gap: 14px;',
        '  box-sizing: border-box;',
        '  width: 100%;',
        '}',
        ':host(.is-bottom) #oc-settings-panel {',
        '  border-bottom: 1px solid var(--oc-divider);',
        '}',
        ':host(.is-top) #oc-settings-panel {',
        '  border-top: 1px solid var(--oc-divider);',
        '}',
        '.oc-settings-header {',
        '  display: flex;',
        '  align-items: center;',
        '  justify-content: space-between;',
        '  border-bottom: 1px solid var(--oc-divider);',
        '  padding-bottom: 8px;',
        '  margin-bottom: 2px;',
        '}',
        '.oc-settings-title-container {',
        '  display: flex;',
        '  flex-direction: column;',
        '  gap: 1px;',
        '}',
        '.oc-settings-title {',
        '  font-size: .875rem;',
        '  color: var(--oc-text);',
        '  font-family: inherit;',
        '  font-weight: 700;',
        '  letter-spacing: 0.05em;',
        '}',
        '.oc-settings-subtitle {',
        '  font-size: .875rem;',
        '  color: var(--oc-subtle);',
        '  font-family: inherit;',
        '  font-weight: 400;',
        '}',
        '.oc-settings-reset-btn {',
        '  background: none;',
        '  border: none;',
        '  color: var(--oc-text);',
        '  font-size: .875rem;',
        '  font-family: inherit;',
        '  font-weight: 600;',
        '  cursor: pointer;',
        '  padding: 3px 6px;',
        '  border-radius: 4px;',
        '  display: inline-flex;',
        '  align-items: center;',
        '  transition: color 150ms, background-color 150ms;',
        '  box-shadow: none;',
        '  margin: 0;',
        '  width: auto;',
        '  height: auto;',
        '}',
        '.oc-settings-reset-btn:hover {',
        '  color: var(--oc-accent);',
        '  background-color: var(--oc-btn-hover-bg);',
        '}',
        '.oc-settings-grid {',
        '  display: grid;',
        '  grid-template-columns: 1fr 1fr;',
        '  gap: 12px 18px;',
        '  width: 100%;',
        '  box-sizing: border-box;',
        '}',
        '.oc-settings-col {',
        '  display: flex;',
        '  flex-direction: column;',
        '  gap: 12px;',
        '}',
        '.oc-settings-field {',
        '  display: flex;',
        '  flex-direction: column;',
        '  gap: 5px;',
        '  width: 100%;',
        '  box-sizing: border-box;',
        '}',
        '.oc-settings-meta {',
        '  display: flex;',
        '  flex-direction: column;',
        '  gap: 1px;',
        '  margin-bottom: 2px;',
        '}',
        '.oc-settings-label {',
        '  font-size: .875rem;',
        '  color: var(--oc-text);',
        '  font-family: inherit;',
        '  font-weight: 600;',
        '  letter-spacing: 0.01em;',
        '}',
        '.oc-settings-desc {',
        '  font-size: .875rem;',
        '  color: var(--oc-subtle);',
        '  font-family: inherit;',
        '  font-weight: 400;',
        '}',
        '.oc-donate-btn {',
        '  display: inline-flex;',
        '  align-items: center;',
        '  justify-content: center;',
        '  gap: 6px;',
        '  padding: 6px 12px;',
        '  background: #FFDD00;',
        '  color: #000000 !important;',
        '  font-family: inherit;',
        '  font-size: .875rem;',
        '  font-weight: 700;',
        '  border-radius: 6px;',
        '  text-decoration: none;',
        '  cursor: pointer;',
        '  transition: transform 150ms, box-shadow 150ms;',
        '  width: 100%;',
        '  box-sizing: border-box;',
        '  border: none;',
        '}',
        '.oc-donate-btn:hover {',
        '  transform: translateY(-1px);',
        '  box-shadow: 0 4px 12px rgba(255, 221, 0, 0.2);',
        '}',
        '.oc-feedback-btn {',
        '  display: inline-flex;',
        '  align-items: center;',
        '  justify-content: center;',
        '  gap: 6px;',
        '  padding: 6px 12px;',
        '  background: #2563eb;',
        '  color: #ffffff !important;',
        '  font-family: inherit;',
        '  font-size: .875rem;',
        '  font-weight: 700;',
        '  border-radius: 6px;',
        '  text-decoration: none;',
        '  cursor: pointer;',
        '  transition: transform 150ms, box-shadow 150ms;',
        '  width: 100%;',
        '  box-sizing: border-box;',
        '  border: none;',
        '}',
        '.oc-feedback-btn:hover {',
        '  transform: translateY(-1px);',
        '  box-shadow: 0 4px 12px rgba(37, 99, 235, 0.25);',
        '}',
        '.oc-pin-tip {',
        '  font-size: .8125rem;',
        '  color: var(--oc-subtle);',
        '  font-family: inherit;',
        '  font-style: italic;',
        '  line-height: 1.4;',
        '  margin-top: 12px;',
        '  padding: 6px 10px;',
        '  border-left: 2px solid var(--oc-accent);',
        '  background: rgba(245, 158, 11, 0.05);',
        '  border-radius: 0 4px 4px 0;',
        '  box-sizing: border-box;',
        '  width: 100%;',
        '}',
        '.oc-settings-picker-group {',
        '  display: inline-flex;',
        '  gap: 6px;',
        '  align-items: center;',
        '}',
        '.oc-toggle-group {',
        '  display: inline-flex;',
        '  padding: 3px;',
        '  background: var(--oc-input-bg);',
        '  border-radius: 6px;',
        '  border: 1px solid var(--oc-input-border);',
        '  width: 100%;',
        '  box-sizing: border-box;',
        '}',
        '.oc-toggle-btn {',
        '  flex: 1;',
        '  border: none;',
        '  background: transparent;',
        '  color: var(--oc-text);',
        '  opacity: 0.8;',
        '  padding: 5px 6px;',
        '  border-radius: 4px;',
        '  font-size: .875rem;',
        '  font-weight: 600;',
        '  cursor: pointer;',
        '  font-family: inherit;',
        '  text-align: center;',
        '  white-space: nowrap;',
        '  transition: all 150ms cubic-bezier(0.16, 1, 0.3, 1);',
        '  box-shadow: none;',
        '  margin: 0;',
        '  height: auto;',
        '  line-height: 1.2;',
        '}',
        '.oc-toggle-btn:hover {',
        '  color: var(--oc-accent);',
        '  opacity: 1;',
        '  background: rgba(120, 120, 120, 0.12);',
        '}',
        '.oc-toggle-btn.active {',
        '  background: var(--oc-btn-active-bg);',
        '  color: var(--oc-btn-active-text);',
        '  opacity: 1;',
        '  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1), 0 1px 1px rgba(0, 0, 0, 0.06);',
        '}',
        '.oc-color-badge {',
        '  position: relative;',
        '  display: inline-flex;',
        '  align-items: center;',
        '  justify-content: center;',
        '  flex: 1;',
        '  gap: 5px;',
        '  padding: 4px 6px;',
        '  background: var(--oc-input-bg);',
        '  border: 1px solid var(--oc-input-border);',
        '  border-radius: 6px;',
        '  cursor: pointer;',
        '  box-sizing: border-box;',
        '  transition: border-color 150ms, transform 150ms, box-shadow 150ms;',
        '}',
        '.oc-color-badge:hover {',
        '  border-color: var(--oc-subtle);',
        '  transform: translateY(-1px);',
        '  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);',
        '}',
        '.oc-color-badge-swatch {',
        '  width: 10px;',
        '  height: 10px;',
        '  border-radius: 50%;',
        '  border: 1px solid rgba(0, 0, 0, 0.15);',
        '  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.05);',
        '  flex-shrink: 0;',
        '}',
        '.oc-color-badge-text {',
        '  font-family: system-ui, -apple-system, sans-serif;',
        '  font-size: 10.5px;',
        '  font-weight: 600;',
        '  color: var(--oc-text);',
        '  letter-spacing: 0.02em;',
        '}',
        '.oc-radio-list {',
        '  display: flex;',
        '  flex-direction: column;',
        '  gap: 2px;',
        '}',
        '.oc-radio-item {',
        '  display: flex;',
        '  align-items: center;',
        '  justify-content: flex-start;',
        '  gap: 8px;',
        '  padding: 5px 8px;',
        '  border: none;',
        '  background: transparent;',
        '  color: var(--oc-text);',
        '  font-size: .875rem;',
        '  font-family: inherit;',
        '  font-weight: 500;',
        '  cursor: pointer;',
        '  border-radius: 4px;',
        '  text-align: left;',
        '  width: 100%;',
        '  opacity: 0.7;',
        '  box-sizing: border-box;',
        '  box-shadow: none;',
        '  margin: 0;',
        '  transition: background-color 120ms, opacity 120ms, color 120ms;',
        '}',
        '.oc-radio-item:hover {',
        '  background: var(--oc-btn-hover-bg);',
        '  opacity: 1;',
        '}',
        '.oc-radio-item.active {',
        '  color: var(--oc-accent);',
        '  opacity: 1;',
        '}',
        '.oc-radio-dot {',
        '  font-size: .75rem;',
        '  flex-shrink: 0;',
        '  width: 1em;',
        '  text-align: center;',
        '}',
        '.oc-color-badge input.oc-color-input {',
        '  position: absolute;',
        '  top: 0;',
        '  left: 0;',
        '  width: 100%;',
        '  height: 100%;',
        '  opacity: 0;',
        '  cursor: pointer;',
        '  padding: 0;',
        '  border: none;',
        '}',
        '.oc-notice {',
        '  display: flex;',
        '  align-items: center;',
        '  gap: 8px;',
        '  padding: 6px 10px;',
        '  font: 12px/1.4 system-ui, -apple-system, sans-serif;',
        '  background: ' + t.bg + ';',
        '  color: ' + t.text + ';',
        '  border-top: 1px solid ' + t.divider + ';',
        '  border-left: 3px solid var(--oc-accent);',
        '}',
        '.oc-notice-text {',
        '  flex: 1;',
        '  opacity: 0.85;',
        '}',
        '.oc-notice-close {',
        '  flex-shrink: 0;',
        '  opacity: 0.6;',
        '  cursor: pointer;',
        '  font-size: 13px;',
        '}',
        '.oc-notice-close:hover {',
        '  opacity: 1;',
        '}'
      ].join('\n');

      if (dialogEl) {
        dialogEl.textContent = dialogCss;
      } else {
        try {
          var s = document.createElement('style');
          s.id = dialogStyleId;
          s.textContent = dialogCss;
          wrapRoot.appendChild(s);
        } catch (e) {
          console.warn('Oculist: Dialog style injection failed', e);
        }
      }
    }
  }

  // ── Boot ──────────────────────────────────────────────────────────────────────

  function boot() {
    window.addEventListener('keydown', keydownHandler, { capture: true, passive: false });

    window.__ocToggle = function () {
      if (wrap) {
        window.__ocDestroy();
      } else {
        buildUI();
        injectHighlightStyles();
        startDomObserver();
        checkSiteOverride(false);
        window.addEventListener('scroll', handleScroll, { passive: true });
        window.addEventListener('resize', scheduleViewportMarkersUpdate, { passive: true });
        if (input) {
          input.focus();
          input.select();
        }
      }
    };

    chrome.runtime.onMessage.addListener(function(msg) {
      if (msg.action === 'toggle') window.__ocToggle();
      else if (msg.action === 'destroy') window.__ocDestroy();
    });

    chrome.storage.onChanged.addListener(function(changes) {
      if (!changes['oc-settings']) return;
      var nv = changes['oc-settings'].newValue;
      if (!nv) return;
      SETTINGS_KEYS.forEach(function(k) {
        if (k in nv) settings[k] = nv[k];
      });
      if (!Array.isArray(settings.disabledSites)) settings.disabledSites = [];
      if (settings.disabledSites.indexOf(window.location.hostname) !== -1 && wrap) {
        window.__ocDestroy();
      } else {
        injectHighlightStyles();
        applyWrapPosition();
        updateViewportMarkers();
        if (settingsPanel) {
          settingsPanel.remove();
          settingsPanel = null;
          buildSettingsPanel();
        }
      }
    });
  }

  chrome.storage.sync.get('oc-settings', function (data) {
    if (data && data['oc-settings']) {
      var saved = data['oc-settings'];
      SETTINGS_KEYS.forEach(function (k) {
        if (k in saved) settings[k] = saved[k];
      });
      if (!Array.isArray(settings.disabledSites)) settings.disabledSites = [];
    }
    if (!effectsRegistry[settings.effect]) settings.effect = 'hud';
    boot();
  });

})();
