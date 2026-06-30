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
    disabledSites: []
  };

  function saveSettings() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.set({ 'oc-settings': settings });
    } else {
      try { localStorage.setItem('oc-settings', JSON.stringify(settings)); } catch (e) {}
    }
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
    prefSubtitle: 'Configure search behavior & effects',
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
    effectElectronCloud: 'Electron Cloud'
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
    electron: { label: i18n.effectElectronCloud, run: animateElectronCloud }
  };

  // ── State ─────────────────────────────────────────────────────────────────────

  var searchRanges     = [];
  var activeIndex      = -1;
  var lastTerm         = '';
  var firstEnter       = false;
  var debounceTimer    = null;
  var wrap, wrapRoot, bar, input, countEl, prevBtn, nextBtn, replayBtn, gearBtn, closeBtn, settingsPanel;
  var activeScrollTimeout      = null;
  var activeScrollEndHandler   = null;
  var activeScrollDebounceHandler = null;

  // ── Destroy ───────────────────────────────────────────────────────────────────

  window.__ocDestroy = function () {
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
      document.removeEventListener('keydown', keydownHandler, { capture: true, passive: false });
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
    
    wrap = wrapRoot = bar = input = countEl = prevBtn = nextBtn = replayBtn = gearBtn = closeBtn = settingsPanel = null;
    lastTerm = ''; activeIndex = -1; searchRanges = []; firstEnter = false;
  };

  // ── Beacons ───────────────────────────────────────────────────────────────────

  function cancelBeacons() {
    var beacons = document.querySelectorAll('.oc-beacon');
    for (var i = 0; i < beacons.length; i++) {
      if (beacons[i].__rafId) cancelAnimationFrame(beacons[i].__rafId);
      beacons[i].remove();
    }
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
    var color = settings.beaconColor || '#fbbf24';

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
    document.documentElement.appendChild(laserContainer);

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
      duration: 2000,
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
      duration: 2000,
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
      duration: 2000,
      easing: 'cubic-bezier(0.19, 1, 0.22, 1)',
      fill: 'forwards'
    });

    // 4. Spark explosion
    var sparkCount = 20;
    for (var i = 0; i < sparkCount; i++) {
      var spark = document.createElement('div');
      var size = Math.random() * 5 + 3;
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
      var distance = Math.random() * 110 + 50;
      var dx = Math.cos(angle) * distance;
      var dy = Math.sin(angle) * distance;

      spark.animate([
        { transform: 'translate(-50%, -50%) translate(0, 0) scale(1.5)', opacity: 1 },
        { transform: 'translate(-50%, -50%) translate(' + dx + 'px, ' + dy + 'px) scale(0)', opacity: 0 }
      ], {
        duration: 1500 + Math.random() * 500,
        easing: 'cubic-bezier(0.1, 0.8, 0.2, 1)',
        fill: 'forwards'
      });
    }

    setTimeout(function() {
      laserContainer.remove();
    }, 2100);
  }

  function animateIris(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;

    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var w = Math.max(rect.width + 50, 90);
    var h = Math.max(rect.height + 30, 50);

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
      duration: 2000,
      easing: 'ease-out',
      fill: 'forwards'
    });

    var color = settings.beaconColor || '#38bdf8';

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
      duration: 2000,
      easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
      fill: 'forwards'
    });

    setTimeout(function() {
      overlay.remove();
      ring.remove();
    }, 2100);
  }

  function animateWarpDrive(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;

    var cx = rect.left + rect.width / 2 + window.scrollX;
    var cy = rect.top + rect.height / 2 + window.scrollY;
    var color = settings.beaconColor || '#fbbf24';

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
    document.documentElement.appendChild(container);

    // 1. Triple Staggered Expanding Warp Rings
    var ringCount = 3;
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
        duration: 1600,
        delay: r * 150,
        easing: 'cubic-bezier(0.1, 0.8, 0.15, 1)',
        fill: 'forwards'
      });
    }

    // 2. Warp Speed Radial Star Streaks
    var streakCount = 120;
    for (var i = 0; i < streakCount; i++) {
      var streak = document.createElement('div');
      var thick = Math.random() * 2.2 + 1;
      var len = Math.random() * 55 + 25;
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

      var travel = Math.random() * 240 + 130;
      var startDelay = Math.random() * 550;

      streak.animate([
        { transform: 'rotate(' + angle + 'rad) translate(10px, 0) scaleX(0.05)', opacity: 0 },
        { transform: 'rotate(' + angle + 'rad) translate(' + (travel * 0.25) + 'px, 0) scaleX(3.5)', opacity: 1, offset: 0.15 },
        { transform: 'rotate(' + angle + 'rad) translate(' + (travel * 0.7) + 'px, 0) scaleX(7.0)', opacity: 1, offset: 0.7 },
        { transform: 'rotate(' + angle + 'rad) translate(' + travel + 'px, 0) scaleX(10.0)', opacity: 0 }
      ], {
        duration: 750 + Math.random() * 550,
        delay: startDelay,
        easing: 'cubic-bezier(0.1, 0.8, 0.25, 1)',
        fill: 'forwards'
      });
    }

    setTimeout(function() {
      container.remove();
    }, 2200);
  }

  function animateFlame(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;

    var x = rect.left + window.scrollX;
    var y = rect.top + window.scrollY;
    var w = rect.width;
    var h = rect.height;
    var color = settings.beaconColor || '#f97316';

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
    document.documentElement.appendChild(container);

    // 1. Fiery glowing outline
    var outline = document.createElement('div');
    outline.style.cssText = [
      'position:absolute',
      'left:' + offsetX + 'px', 'top:' + offsetY + 'px',
      'width:' + w + 'px', 'height:' + h + 'px',
      'border-radius:4px',
      'box-shadow:0 0 60px #ef4444, inset 0 0 40px #f97316, 0 0 16px #eab308',
      'opacity:0', 'pointer-events:none'
    ].join(';');
    container.appendChild(outline);

    outline.animate([
      { opacity: 0, transform: 'scale(1.15)' },
      { opacity: 0.9, transform: 'scale(1)', offset: 0.15 },
      { opacity: 0.8, transform: 'scale(1)', offset: 0.85 },
      { opacity: 0, transform: 'scale(0.95)' }
    ], {
      duration: 1800,
      easing: 'ease-out',
      fill: 'forwards'
    });

    // 2. Soft heat glow behind
    var glow = document.createElement('div');
    glow.style.cssText = [
      'position:absolute',
      'left:' + (offsetX - 40) + 'px', 'top:' + (offsetY - 40) + 'px',
      'width:' + (w + 80) + 'px', 'height:' + (h + 80) + 'px',
      'background:radial-gradient(ellipse, rgba(239, 68, 68, 0.4) 0%, rgba(249, 115, 22, 0.15) 60%, transparent 100%)',
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
      duration: 1800,
      easing: 'ease-out',
      fill: 'forwards'
    });

    // 3. Flame particles rising
    var colors = ['#ef4444', '#f97316', '#f59e0b', '#facc15', '#fef08a'];
    var particleCount = 25;
    for (var i = 0; i < particleCount; i++) {
      var p = document.createElement('div');
      var pSize = Math.random() * 48 + 24;
      var px = offsetX + Math.random() * w;
      var py = offsetY + h;

      p.style.cssText = [
        'position:absolute',
        'left:' + px + 'px', 'top:' + py + 'px',
        'width:' + pSize + 'px', 'height:' + pSize + 'px',
        'background:' + colors[Math.floor(Math.random() * colors.length)],
        'border-radius:50% 50% 20% 80%',
        'filter:blur(' + (Math.random() * 8 + 4) + 'px)',
        'transform-origin:center bottom',
        'opacity:0', 'pointer-events:none'
      ].join(';');
      container.appendChild(p);

      var riseHeight = Math.random() * 180 + 120;
      var swayX = (Math.random() - 0.5) * 100;
      var randomRotate = Math.random() * 360;

      p.animate([
        { transform: 'translate(-50%, -50%) translate(0, 0) rotate(' + randomRotate + 'deg) scale(0.2)', opacity: 0 },
        { transform: 'translate(-50%, -50%) translate(' + (swayX * 0.3) + 'px, -' + (riseHeight * 0.3) + 'px) rotate(' + (randomRotate + 45) + 'deg) scale(1.2)', opacity: 0.9, offset: 0.2 },
        { transform: 'translate(-50%, -50%) translate(' + (swayX * 0.7) + 'px, -' + (riseHeight * 0.7) + 'px) rotate(' + (randomRotate + 90) + 'deg) scale(0.8)', opacity: 0.6, offset: 0.7 },
        { transform: 'translate(-50%, -50%) translate(' + swayX + 'px, -' + riseHeight + 'px) rotate(' + (randomRotate + 180) + 'deg) scale(0)', opacity: 0 }
      ], {
        duration: 1000 + Math.random() * 600,
        delay: Math.random() * 400,
        easing: 'cubic-bezier(0.21, 0.61, 0.35, 1)',
        fill: 'forwards'
      });
    }

    // 4. Gray smoke particles
    var smokeCount = 8;
    for (var j = 0; j < smokeCount; j++) {
      var s = document.createElement('div');
      var sSize = Math.random() * 60 + 40;
      var sx = offsetX + Math.random() * w;
      var sy = offsetY + h / 2;

      s.style.cssText = [
        'position:absolute',
        'left:' + sx + 'px', 'top:' + sy + 'px',
        'width:' + sSize + 'px', 'height:' + sSize + 'px',
        'background:rgba(120, 113, 108, 0.25)',
        'border-radius:50%',
        'filter:blur(' + (Math.random() * 12 + 8) + 'px)',
        'opacity:0', 'pointer-events:none'
      ].join(';');
      container.appendChild(s);

      var sRise = Math.random() * 240 + 200;
      var sSway = (Math.random() - 0.5) * 160;

      s.animate([
        { transform: 'translate(-50%, -50%) translate(0, 0) scale(0.5)', opacity: 0 },
        { transform: 'translate(-50%, -50%) translate(' + (sSway * 0.4) + 'px, -' + (sRise * 0.4) + 'px) scale(1.2)', opacity: 0.3, offset: 0.3 },
        { transform: 'translate(-50%, -50%) translate(' + sSway + 'px, -' + sRise + 'px) scale(2)', opacity: 0 }
      ], {
        duration: 1400 + Math.random() * 600,
        delay: Math.random() * 500,
        easing: 'ease-out',
        fill: 'forwards'
      });
    }

    setTimeout(function() {
      container.remove();
    }, 2200);
  }

  function animateLightning(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;

    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var color = settings.beaconColor || '#a855f7';

    var container = document.createElement('div');
    container.className = 'oc-beacon';
    container.style.cssText = [
      'position:fixed', 'left:0', 'top:0',
      'width:' + vw + 'px', 'height:' + vh + 'px',
      'pointer-events:none', 'z-index:2147483643',
      'overflow:hidden'
    ].join(';');
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

    var corners = [
      { x: 0, y: 0 },
      { x: vw, y: 0 },
      { x: 0, y: vh },
      { x: vw, y: vh }
    ];

    var paths = [];

    corners.forEach(function (corner) {
      var segments = 12;
      var displace = 45;
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

    var travelDuration = 350;

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
        duration: 300,
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
        duration: 700,
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

        flickerGlow.animate(flickAnim, { duration: 400, fill: 'forwards' });
        flickerCore.animate(flickAnim, { duration: 400, fill: 'forwards' });
      }

      paths.forEach(function (p) {
        p.glow.animate([{ opacity: 0.8 }, { opacity: 0 }], { duration: 150, fill: 'forwards' });
        p.core.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, fill: 'forwards' });
      });

    }, travelDuration);

    setTimeout(function () {
      container.remove();
    }, travelDuration + 1000);
  }

  function animateElectronCloud(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;

    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var color = settings.beaconColor || '#38bdf8';

    var container = document.createElement('div');
    container.className = 'oc-beacon';
    container.style.cssText = [
      'position:fixed', 'left:0', 'top:0',
      'width:' + vw + 'px', 'height:' + vh + 'px',
      'pointer-events:none', 'z-index:2147483643',
      'overflow:hidden'
    ].join(';');
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

    var r = Math.max(rect.width, rect.height, 40) * 0.9;
    var a = r * 1.5;
    var b = r * 0.6;

    var thetas = [
      Math.PI / 2,
      Math.PI / 6,
      5 * Math.PI / 6
    ];

    var speed = 0.007;
    var phaseOffsets = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3];

    var histories = [[], [], []];
    var maxHistory = 15;

    var startTime = performance.now();
    var duration = 1800;
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
      var nucleusRadius = 12 * pulse;
      var grad = ctx.createRadialGradient(cx, cy, 2, cx, cy, nucleusRadius);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.2, '#ffffff');
      grad.addColorStop(0.6, color);
      grad.addColorStop(1, 'transparent');
      
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, nucleusRadius, 0, 2 * Math.PI);
      ctx.fill();

      ctx.shadowBlur = 0;
      ctx.lineWidth = 1;
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.22;
      for (var i = 0; i < 3; i++) {
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

      for (var i = 0; i < 3; i++) {
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
          var radius = 1.5 + ratio * 2.5;
          ctx.beginPath();
          ctx.arc(history[k].x, history[k].y, radius, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.globalAlpha = ratio * 0.55;
          ctx.fill();
        }
        ctx.globalAlpha = 1.0;

        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = 10;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(ex, ey, 4.5, 0, 2 * Math.PI);
        ctx.fill();
        ctx.restore();
      }

      animFrameId = requestAnimationFrame(render);
      container.__rafId = animFrameId;
    }

    animFrameId = requestAnimationFrame(render);
    container.__rafId = animFrameId;
  }

  function animate(rect) {
    if (!wrap) return;
    var effectObj = effectsRegistry[settings.effect] || effectsRegistry.hud;
    if (effectObj && typeof effectObj.run === 'function') {
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
  }

  function setNavEnabled(enabled) {
    if (prevBtn) prevBtn.disabled = !enabled;
    if (nextBtn) nextBtn.disabled = !enabled;
    if (replayBtn) replayBtn.disabled = !(searchRanges.length > 0);
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
    var beacons = document.querySelectorAll('.oc-beacon');
    if (beacons.length === 0) return;
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

  function handleScroll() {
    if (isAutoScrolling) return;
    fadeActiveBeacons();
  }

  // ── Event handlers ────────────────────────────────────────────────────────────

  function keydownHandler(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      var isCurrentSiteDisabled = settings.disabledSites && settings.disabledSites.indexOf(window.location.hostname) !== -1;
      var isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
      if (isCurrentSiteDisabled || isStandalone) {
        return;
      }
      try { e.preventDefault(); } catch (err) {}
      e.stopPropagation();
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
    
    if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') || e.key === 'F3') {
      try { e.preventDefault(); } catch (err) {}
      e.stopPropagation();
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
    if (settingsPanel) {
      settingsPanel.remove();
      settingsPanel = null;
      if (gearBtn) gearBtn.classList.remove('active');
    } else {
      buildSettingsPanel();
      if (gearBtn) gearBtn.classList.add('active');
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

  function makeRadioList(items, currentVal, onChange) {
    var list = document.createElement('div');
    list.className = 'oc-radio-list';

    items.forEach(function (item) {
      var row = document.createElement('button');
      row.className = 'oc-radio-item' + (item.value === currentVal ? ' active' : '');

      var dot = document.createElement('span');
      dot.className = 'oc-radio-dot';
      dot.textContent = item.value === currentVal ? '●' : '○';

      var lbl = document.createElement('span');
      lbl.textContent = item.label;

      row.appendChild(dot);
      row.appendChild(lbl);
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

  function buildSettingsPanel() {
    var p = P();

    settingsPanel = document.createElement('div');
    settingsPanel.id = 'oc-settings-panel';

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
    var resetSvg = createSvgIcon('reset');
    if (resetSvg) {
      resetBtn.appendChild(resetSvg);
    }
    resetBtn.appendChild(document.createTextNode(i18n.resetBtn));
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

    // Grid Container
    var grid = document.createElement('div');
    grid.className = 'oc-settings-grid';

    // Col 1: Effect & Theme
    var col1 = document.createElement('div');
    col1.className = 'oc-settings-col';

    var effectOptions = [];
    for (var key in effectsRegistry) {
      if (effectsRegistry.hasOwnProperty(key)) {
        effectOptions.push({ value: key, label: effectsRegistry[key].label });
      }
    }
    effectOptions.sort(function (a, b) {
      return a.label.localeCompare(b.label);
    });

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

    var effectField = makeSettingsField(i18n.highlightEffect, i18n.effectDesc, makeRadioList(
      effectOptions,
      settings.effect,
      function (v) {
        settings.effect = v; saveSettings();
      }
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
      { label: i18n.matchLabel, val: settings.matchColor, title: i18n.matchTitle, cb: function (v) { settings.matchColor = v; saveSettings(); injectHighlightStyles(); } },
      { label: i18n.activeLabel, val: settings.activeColor, title: i18n.activeTitle, cb: function (v) { settings.activeColor = v; saveSettings(); injectHighlightStyles(); } },
      { label: i18n.beaconLabel, val: settings.beaconColor, title: i18n.beaconTitle, cb: function (v) { settings.beaconColor = v; saveSettings(); } }
    ];

    items.forEach(function (item) {
      var picker = makeColorPicker(item.label, item.val, item.title, item.cb);
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

  function makeColorPicker(label, val, title, onChange) {
    var badge = document.createElement('div');
    badge.className = 'oc-color-badge';
    badge.title = title;
    
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
    
    input.addEventListener('keydown', function (e) { e.stopPropagation(); });
    input.addEventListener('input', function () {
      var newColor = input.value;
      swatch.style.backgroundColor = newColor;
      onChange(newColor);
    });
    
    badge.appendChild(swatch);
    badge.appendChild(text);
    badge.appendChild(input);
    return badge;
  }

  // ── Apply position / theme to live elements ───────────────────────────────────

  function applyWrapPosition() {
    var p = P();
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
    wrap.style.border = '1px solid ' + t.divider;
    wrap.style.boxShadow = '0 10px 30px -10px rgba(0,0,0,0.3), 0 1px 3px rgba(0,0,0,0.05)';
    wrap.style.backdropFilter = 'blur(16px) saturate(180%)';
    wrap.style.webkitBackdropFilter = 'blur(16px) saturate(180%)';
    wrap.style.transition = 'border-radius 200ms, box-shadow 200ms, backdrop-filter 200ms';
    wrap.classList.toggle('is-top', !p.isBottom);
    wrap.classList.toggle('is-bottom', p.isBottom);
    wrap.classList.remove('pos-tr', 'pos-tl', 'pos-br', 'pos-bl');
    wrap.classList.add('pos-' + settings.position);
  }

  // ── UI build ──────────────────────────────────────────────────────────────────

  function createSvgIcon(name, size) {
    size = size || 13;
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('data-icon', name);
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');

    if (name === 'up') {
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'm18 15-6-6-6 6');
      svg.appendChild(path);
    } else if (name === 'down') {
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'm6 9 6 6 6-6');
      svg.appendChild(path);
    } else if (name === 'replay') {
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.72 2.73L21 8');
      svg.appendChild(path);
      var poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      poly.setAttribute('points', '21 3 21 8 16 8');
      svg.appendChild(poly);
    } else if (name === 'gear') {
      var circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', '12');
      circle.setAttribute('cy', '12');
      circle.setAttribute('r', '3');
      svg.appendChild(circle);
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z');
      svg.appendChild(path);
    } else if (name === 'close') {
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M18 6 6 18M6 6l12 12');
      svg.appendChild(path);
    } else if (name === 'reset') {
      svg.setAttribute('width', '10');
      svg.setAttribute('height', '10');
      svg.style.marginRight = '4px';
      svg.style.display = 'inline-block';
      svg.style.verticalAlign = '-1px';

      var path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path1.setAttribute('d', 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8');
      svg.appendChild(path1);

      var poly1 = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      poly1.setAttribute('points', '16 3 21 3 21 8');
      svg.appendChild(poly1);

      var path2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path2.setAttribute('d', 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16');
      svg.appendChild(path2);

      var poly2 = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      poly2.setAttribute('points', '8 21 3 21 3 16');
      svg.appendChild(poly2);
    }

    return svg;
  }

  function makeIconBtn(iconName, title, size) {
    var btn = document.createElement('button');
    btn.classList.add('oc-' + iconName + '-btn');
    var svg = createSvgIcon(iconName, size);
    if (svg) {
      btn.appendChild(svg);
    }
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
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        try { e.preventDefault(); } catch (err) {}
        input.focus();
        input.select();
        e.stopPropagation();
        return;
      }
      e.stopPropagation();
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
      }, 150);
    });

    countEl = document.createElement('span');
    countEl.className = 'oc-count';

    prevBtn = makeIconBtn('up', i18n.prevTitle);
    prevBtn.addEventListener('click', function () { findNext(true); });

    nextBtn = makeIconBtn('down', i18n.nextTitle);
    nextBtn.addEventListener('click', function () { findNext(false); });

    replayBtn = makeIconBtn('replay', i18n.replayTitle);
    replayBtn.addEventListener('click', function () { highlightActiveRange(true); });

    gearBtn = makeIconBtn('gear', i18n.optionsTitle, 18);
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

  function injectHighlightStyles() {
    var globalStyleId = 'oc-global-highlight-styles';
    var globalEl = document.getElementById(globalStyleId);

    var matchColor = settings.matchColor || '#fef08a';
    var activeColor = settings.activeColor || '#f59e0b';
    var matchTextColor = getContrastColor(matchColor);
    var activeTextColor = getContrastColor(activeColor);

    var highlightCss = [
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
        '  border: 1px solid var(--oc-divider);',
        '  background: var(--oc-bg);',
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
        '  --oc-accent-alpha: ' + hexToRgba(settings.beaconColor || '#fbbf24', 0.2) + ';',
        '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;',
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
        '  background: var(--oc-bg);',
        '  color: var(--oc-text);',
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
        '  color: var(--oc-text);',
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
        'svg, svg * {',
        '  stroke: var(--oc-text);',
        '  fill: none;',
        '  stroke-dasharray: none;',
        '  stroke-width: 2.5;',
        '  stroke-linecap: round;',
        '  stroke-linejoin: round;',
        '}',
        '.oc-bar button svg {',
        '  display: inline-block;',
        '  visibility: visible;',
        '  width: 13px;',
        '  height: 13px;',
        '  min-width: 13px;',
        '  min-height: 13px;',
        '  flex-shrink: 0;',
        '  stroke: var(--oc-text);',
        '  fill: none;',
        '}',
        '.oc-bar button.oc-gear-btn svg {',
        '  width: 18px;',
        '  height: 18px;',
        '  min-width: 18px;',
        '  min-height: 18px;',
        '}',
        '.oc-bar button svg path, .oc-bar button svg polyline, .oc-bar button svg circle {',
        '  stroke: var(--oc-text);',
        '  fill: none;',
        '}',
        'button:hover:not(:disabled) svg, button:hover:not(:disabled) svg * {',
        '  stroke: var(--oc-accent);',
        '}',
        'button.active svg, button.active svg * {',
        '  stroke: var(--oc-accent);',
        '}',
        'button, .oc-bar button {',
        '  color: var(--oc-text);',
        '  background: none;',
        '  border: none;',
        '  padding: 6px;',
        '  font-size: 0;',
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
        '.oc-bar button {',
        '  width: 25px;',
        '  height: 25px;',
        '  min-width: 25px;',
        '  min-height: 25px;',
        '  max-width: 25px;',
        '  max-height: 25px;',
        '  flex-shrink: 0;',
        '  box-sizing: border-box;',
        '}',
        'button:hover, .oc-bar button:hover {',
        '  color: var(--oc-accent);',
        '  background-color: var(--oc-btn-hover-bg);',
        '  transform: scale(1.05);',
        '}',
        'button:active, .oc-bar button:active {',
        '  transform: scale(0.95);',
        '}',
        'button.active, .oc-bar button.active {',
        '  color: var(--oc-accent);',
        '}',
        'button:disabled, .oc-bar button:disabled {',
        '  opacity: 0.35;',
        '  cursor: default;',
        '  transform: none;',
        '  background: none;',
        '  color: var(--oc-text);',
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
        '  font-size: 10px;',
        '  color: var(--oc-text);',
        '  font-family: system-ui, -apple-system, sans-serif;',
        '  font-weight: 700;',
        '  letter-spacing: 0.05em;',
        '}',
        '.oc-settings-subtitle {',
        '  font-size: 9px;',
        '  color: var(--oc-subtle);',
        '  font-family: system-ui, -apple-system, sans-serif;',
        '  font-weight: 400;',
        '}',
        '.oc-settings-reset-btn {',
        '  background: none;',
        '  border: none;',
        '  color: var(--oc-text);',
        '  font-size: 9.5px;',
        '  font-family: system-ui, sans-serif;',
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
        '  font-size: 11px;',
        '  color: var(--oc-text);',
        '  font-family: system-ui, sans-serif;',
        '  font-weight: 600;',
        '  letter-spacing: 0.01em;',
        '}',
        '.oc-settings-desc {',
        '  font-size: 9px;',
        '  color: var(--oc-subtle);',
        '  font-family: system-ui, sans-serif;',
        '  font-weight: 400;',
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
        '  font-size: 11px;',
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
        '  font-size: 10px;',
        '  flex-shrink: 0;',
        '  width: 1em;',
        '  text-align: center;',
        '}',
        '.oc-donate-btn {',
        '  display: inline-flex;',
        '  align-items: center;',
        '  justify-content: center;',
        '  gap: 6px;',
        '  padding: 6px 12px;',
        '  background: #FFDD00;',
        '  color: #000000 !important;',
        '  font-family: system-ui, sans-serif;',
        '  font-size: 11px;',
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
        '  font-family: system-ui, sans-serif;',
        '  font-size: 11px;',
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
        '  padding: 4px 6px;',
        '  border-radius: 4px;',
        '  font-size: 10px;',
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
    document.addEventListener('keydown', keydownHandler, { capture: true, passive: false });
    window.addEventListener('scroll', handleScroll, { passive: true });
    
    window.__ocToggle = function () {
      if (wrap) {
        window.__ocDestroy();
      } else {
        buildUI();
        injectHighlightStyles();
        if (input) {
          input.focus();
          input.select();
        }
      }
    };
  }

  // Load settings via chrome.storage.sync with fallback to localStorage
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.get('oc-settings', function (data) {
      if (data && data['oc-settings']) {
        var saved = data['oc-settings'];
        ['effect', 'position', 'theme', 'matchColor', 'activeColor', 'beaconColor', 'scrollBehavior', 'disabledSites'].forEach(function (k) {
          if (k in saved) settings[k] = saved[k];
        });
        if (!Array.isArray(settings.disabledSites)) {
          settings.disabledSites = [];
        }
      }
      if (!effectsRegistry[settings.effect]) settings.effect = 'hud';
      boot();
    });
  } else {
    try {
      var saved = JSON.parse(localStorage.getItem('oc-settings') || '{}');
      ['effect', 'position', 'theme', 'matchColor', 'activeColor', 'beaconColor', 'scrollBehavior', 'disabledSites'].forEach(function (k) {
        if (k in saved) settings[k] = saved[k];
      });
      if (!Array.isArray(settings.disabledSites)) {
        settings.disabledSites = [];
      }
    } catch (e) {}
    if (!effectsRegistry[settings.effect]) settings.effect = 'hud';
    boot();
  }

})();
