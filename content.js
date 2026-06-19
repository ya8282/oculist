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
    beaconColor: '#fbbf24'
  };

  function saveSettings() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.set({ 'oc-settings': settings });
    } else {
      try { localStorage.setItem('oc-settings', JSON.stringify(settings)); } catch (e) {}
    }
  }

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
  function T() { return THEMES[settings.theme] || THEMES.dark; }

  var POS_DATA = {
    tr: { top: '0', right: '0', bottom: '', left: '',  radius: '0 0 0 8px', isBottom: false },
    tl: { top: '0', right: '',  bottom: '', left: '0', radius: '0 0 8px 0', isBottom: false },
    br: { top: '',  right: '0', bottom: '0', left: '', radius: '8px 0 0 0', isBottom: true  },
    bl: { top: '',  right: '',  bottom: '0', left: '0', radius: '0 8px 0 0', isBottom: true  },
  };
  function P() { return POS_DATA[settings.position] || POS_DATA.tr; }

  // ── Plugins & Effects Registry ────────────────────────────────────────────────

  var effectsRegistry = {
    hud: { label: 'Anime Laser', run: animateAnimeLaser },
    iris: { label: 'Cinematic', run: animateIris },
    sweep: { label: 'Warp Drive', run: animateWarpDrive }
  };

  window.Oculist = window.Oculist || {};
  window.Oculist.registerEffect = function (id, label, drawFunction) {
    if (typeof id !== 'string' || typeof drawFunction !== 'function') return;
    effectsRegistry[id] = { label: label, run: drawFunction };
    if (settingsPanel) {
      settingsPanel.remove();
      settingsPanel = null;
      buildSettingsPanel();
    }
  };

  // ── State ─────────────────────────────────────────────────────────────────────

  var searchRanges     = [];
  var activeIndex      = -1;
  var lastTerm         = '';
  var originalFavicons = [];
  var firstEnter       = false;
  var debounceTimer    = null;
  var wrap, bar, input, countEl, prevBtn, nextBtn, replayBtn, gearBtn, closeBtn, settingsPanel;

  // ── Destroy ───────────────────────────────────────────────────────────────────

  window.__ocDestroy = function () {
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

    restoreFavicons();
    cancelBeacons();
    if (wrap) wrap.remove();
    
    var s = document.getElementById('oc-highlight-styles');
    if (s) s.remove();
    
    wrap = bar = input = countEl = prevBtn = nextBtn = replayBtn = gearBtn = closeBtn = settingsPanel = null;
    lastTerm = ''; activeIndex = -1; searchRanges = []; originalFavicons = []; firstEnter = false;
  };

  // ── Beacons ───────────────────────────────────────────────────────────────────

  function cancelBeacons() {
    var beacons = document.querySelectorAll('.oc-beacon');
    for (var i = 0; i < beacons.length; i++) {
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

    var laserContainer = document.createElement('div');
    laserContainer.className = 'oc-beacon';
    laserContainer.style.cssText = [
      'position:absolute',
      'left:0', 'top:' + (cy - 100) + 'px',
      'width:100%', 'height:200px',
      'pointer-events:none', 'z-index:2147483643',
      'overflow:visible'
    ].join(';');
    document.documentElement.appendChild(laserContainer);

    // 1. Primary main core beam (thick outer aura sheath)
    var sheath = document.createElement('div');
    sheath.style.cssText = [
      'position:absolute',
      'left:0', 'right:0', 'top:90px', 'height:20px',
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
      'left:0', 'right:0', 'top:96px', 'height:8px',
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
      'left:' + (x - 25) + 'px', 'top:' + (100 - h/2 - 25) + 'px',
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
        'left:' + cx + 'px', 'top:100px',
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

    var container = document.createElement('div');
    container.className = 'oc-beacon';
    container.style.cssText = [
      'position:absolute',
      'left:' + (cx - 150) + 'px', 'top:' + (cy - 150) + 'px',
      'width:300px', 'height:300px',
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
        'left:145px', 'top:145px',
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
    var streakCount = 24;
    for (var i = 0; i < streakCount; i++) {
      var streak = document.createElement('div');
      var thick = Math.random() * 2.5 + 1;
      var len = Math.random() * 40 + 20;
      var angle = Math.random() * Math.PI * 2;

      streak.style.cssText = [
        'position:absolute',
        'left:150px', 'top:150px',
        'width:' + len + 'px', 'height:' + thick + 'px',
        'background:linear-gradient(90deg, transparent, ' + color + ', #ffffff, ' + color + ', transparent)',
        'box-shadow:0 0 8px ' + color,
        'transform-origin:left center',
        'opacity:0', 'pointer-events:none'
      ].join(';');
      container.appendChild(streak);

      var travel = Math.random() * 120 + 80;

      streak.animate([
        { transform: 'rotate(' + angle + 'rad) translate(10px, 0) scaleX(0.1)', opacity: 0 },
        { transform: 'rotate(' + angle + 'rad) translate(' + (travel * 0.3) + 'px, 0) scaleX(2.0)', opacity: 1, offset: 0.2 },
        { transform: 'rotate(' + angle + 'rad) translate(' + travel + 'px, 0) scaleX(5.0)', opacity: 0 }
      ], {
        duration: 1500 + Math.random() * 450,
        easing: 'cubic-bezier(0.25, 1, 0.5, 1)',
        fill: 'forwards'
      });
    }

    setTimeout(function() {
      container.remove();
    }, 2100);
  }

  function animate(rect) {
    var effectObj = effectsRegistry[settings.effect] || effectsRegistry.hud;
    if (effectObj && typeof effectObj.run === 'function') {
      effectObj.run(rect);
    }
  }

  // ── Match scanning ────────────────────────────────────────────────────────────

  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };

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

    var normalizedTerm = term.toLowerCase();
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        try {
          var parent = node.parentElement;
          if (!parent || SKIP_TAGS[parent.tagName] || parent.closest('#oc-wrap') || parent.closest('.oc-beacon')) {
            return NodeFilter.FILTER_REJECT;
          }
          var style = window.getComputedStyle(parent);
          if (style && (style.display === 'none' || style.visibility === 'hidden')) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        } catch (e) {
          return NodeFilter.FILTER_REJECT;
        }
      }
    });

    var node;
    while ((node = walker.nextNode())) {
      var text = node.textContent.toLowerCase();
      var index = 0;
      while ((index = text.indexOf(normalizedTerm, index)) !== -1) {
        var range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + term.length);
        searchRanges.push(range);
        index += term.length;
        if (searchRanges.length >= 999) break;
      }
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
      countEl.textContent = '0 of ' + searchRanges.length;
    } else {
      countEl.textContent = 'no match';
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
      countEl.textContent = 'no match';
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

    countEl.textContent = (activeIndex + 1) + ' of ' + searchRanges.length;

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
        element.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
          inline: 'nearest'
        });
      }
    }

    if (shouldAnimate) {
      setTimeout(function () {
        var freshRect = activeRange.getBoundingClientRect();
        animate(freshRect);
      }, 180);
    }
  }

  function setNavEnabled(enabled) {
    [prevBtn, nextBtn].forEach(function (btn) {
      if (btn) {
        btn.disabled      = !enabled;
        btn.style.setProperty('opacity', enabled ? '1' : '0.5', 'important');
        btn.style.setProperty('cursor', enabled ? 'pointer' : 'default', 'important');
      }
    });

    var hasMatches = searchRanges.length > 0;
    if (replayBtn) {
      replayBtn.disabled      = !hasMatches;
      replayBtn.style.setProperty('opacity', hasMatches ? '1' : '0.5', 'important');
      replayBtn.style.setProperty('cursor', hasMatches ? 'pointer' : 'default', 'important');
    }
  }

  // ── Event handlers ────────────────────────────────────────────────────────────

  function keydownHandler(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
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
    
    if (e.key === 'Enter') {
      if (wrap.contains(document.activeElement)) {
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
      gearBtn.style.color = T().subtle;
    } else {
      buildSettingsPanel();
      gearBtn.style.color = T().accent;
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

  function makeSettingsField(labelText, descText, controlEl) {
    var field = document.createElement('div');
    field.style.cssText = 'display:flex !important;flex-direction:column !important;gap:5px !important;width:100% !important;box-sizing:border-box !important;';

    var meta = document.createElement('div');
    meta.style.cssText = 'display:flex !important;flex-direction:column !important;gap:1px !important;margin-bottom:2px !important;';

    var lbl = document.createElement('span');
    lbl.textContent = labelText;
    lbl.style.cssText = 'font-size:11px !important;color:var(--text) !important;font-family:system-ui,sans-serif !important;font-weight:600 !important;letter-spacing:0.01em !important;';

    var desc = document.createElement('span');
    desc.textContent = descText;
    desc.style.cssText = 'font-size:9px !important;color:var(--subtle) !important;font-family:system-ui,sans-serif !important;font-weight:400 !important;';

    meta.appendChild(lbl);
    meta.appendChild(desc);
    
    field.appendChild(meta);
    field.appendChild(controlEl);
    return field;
  }

  function buildSettingsPanel() {
    var t = T();
    var p = P();

    settingsPanel = document.createElement('div');
    settingsPanel.id = 'oc-settings-panel';
    settingsPanel.style.cssText = [
      'background:' + t.panelBg + ' !important',
      (p.isBottom ? 'border-bottom:1px solid var(--divider)' : 'border-top:1px solid var(--divider)') + ' !important',
      'padding:14px 16px !important',
      'display:flex !important', 'flex-direction:column !important', 'gap:14px !important',
      'box-sizing:border-box !important', 'width:100% !important',
    ].join(';');

    // Title / Header in Settings panel
    var header = document.createElement('div');
    header.style.cssText = 'display:flex !important;align-items:center !important;justify-content:space-between !important;border-bottom:1px solid var(--divider) !important;padding-bottom:8px !important;margin-bottom:2px !important;';
    
    // Left: Title + Subtitle
    var titleContainer = document.createElement('div');
    titleContainer.style.cssText = 'display:flex !important;flex-direction:column !important;gap:1px !important;';

    var title = document.createElement('span');
    title.textContent = 'OCULIST PREFERENCES';
    title.style.cssText = 'font-size:10px !important;color:var(--text) !important;font-family:system-ui,-apple-system,sans-serif !important;font-weight:700 !important;letter-spacing:0.05em !important;';
    
    var subtitle = document.createElement('span');
    subtitle.textContent = 'Configure search behavior & effects';
    subtitle.style.cssText = 'font-size:9px !important;color:var(--subtle) !important;font-family:system-ui,-apple-system,sans-serif !important;font-weight:400 !important;';

    titleContainer.appendChild(title);
    titleContainer.appendChild(subtitle);
    header.appendChild(titleContainer);

    // Right: Reset Button
    var resetBtn = document.createElement('button');
    var resetSvgMarkup = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:4px;display:inline-block;vertical-align:-1px;"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><polyline points="16 3 21 3 21 8"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><polyline points="8 21 3 21 3 16"/></svg>';
    try {
      var parser = new DOMParser();
      var doc = parser.parseFromString(resetSvgMarkup, 'image/svg+xml');
      var svgEl = doc.documentElement;
      svgEl.style.setProperty('color', 'inherit', 'important');
      svgEl.style.setProperty('stroke', 'currentColor', 'important');
      svgEl.style.setProperty('fill', 'none', 'important');
      var strokeWidth = svgEl.getAttribute('stroke-width') || '2.5';
      svgEl.style.setProperty('stroke-width', strokeWidth, 'important');
      svgEl.style.setProperty('stroke-linecap', 'round', 'important');
      svgEl.style.setProperty('stroke-linejoin', 'round', 'important');
      
      var children = svgEl.querySelectorAll('*');
      for (var i = 0; i < children.length; i++) {
        children[i].style.setProperty('color', 'inherit', 'important');
        children[i].style.setProperty('stroke', 'currentColor', 'important');
        children[i].style.setProperty('fill', 'none', 'important');
        var childStrokeWidth = children[i].getAttribute('stroke-width') || strokeWidth;
        children[i].style.setProperty('stroke-width', childStrokeWidth, 'important');
        children[i].style.setProperty('stroke-linecap', 'round', 'important');
        children[i].style.setProperty('stroke-linejoin', 'round', 'important');
      }
      resetBtn.appendChild(svgEl);
    } catch (err) {}
    resetBtn.appendChild(document.createTextNode('Reset'));
    resetBtn.style.cssText = [
      'background:none !important', 'border:none !important', 'color:var(--text) !important',
      'font-size:9.5px !important', 'font-family:system-ui,sans-serif !important', 'font-weight:600 !important',
      'cursor:pointer !important', 'padding:3px 6px !important', 'border-radius:4px !important',
      'display:inline-flex !important', 'align-items:center !important',
      'transition:color 150ms, background-color 150ms !important',
      'box-shadow:none !important', 'margin:0 !important', 'width:auto !important', 'height:auto !important'
    ].join(';');
    resetBtn.addEventListener('mouseenter', function () {
      resetBtn.style.setProperty('color', 'var(--accent)', 'important');
      resetBtn.style.setProperty('background-color', settings.theme === 'dark' ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)', 'important');
    });
    resetBtn.addEventListener('mouseleave', function () {
      resetBtn.style.setProperty('color', 'var(--text)', 'important');
      resetBtn.style.setProperty('background-color', 'transparent', 'important');
    });
    resetBtn.addEventListener('click', function () {
      settings.effect = 'hud';
      settings.position = 'tr';
      settings.theme = 'dark';
      settings.matchColor = '#fef08a';
      settings.activeColor = '#f59e0b';
      settings.beaconColor = '#fbbf24';
      saveSettings();
      applyBarTheme();
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
    grid.style.cssText = 'display:grid !important;grid-template-columns:1fr 1fr !important;gap:12px 18px !important;width:100% !important;box-sizing:border-box !important;';

    // Col 1: Effect & Theme
    var col1 = document.createElement('div');
    col1.className = 'oc-settings-col';
    col1.style.cssText = 'display:flex !important;flex-direction:column !important;gap:12px !important;';

    var effectOptions = [];
    for (var key in effectsRegistry) {
      if (effectsRegistry.hasOwnProperty(key)) {
        effectOptions.push({ value: key, label: effectsRegistry[key].label });
      }
    }

    col1.appendChild(makeSettingsField('Highlight Effect', 'Choose match visual transition', makeOptionGroup(
      effectOptions,
      settings.effect,
      function (v) {
        settings.effect = v; saveSettings();
      }
    )));

    col1.appendChild(makeSettingsField('Visual Theme', 'Sleek interface color palette', makeOptionGroup([
      { value: 'dark',  label: 'Dark'  },
      { value: 'light', label: 'Light' },
    ], settings.theme, function (v) {
      settings.theme = v; saveSettings();
      applyBarTheme();
      injectHighlightStyles();
      settingsPanel.remove(); settingsPanel = null;
      buildSettingsPanel();
      gearBtn.style.color = T().accent;
    })));

    // Col 2: Position & Colors
    var col2 = document.createElement('div');
    col2.className = 'oc-settings-col';
    col2.style.cssText = 'display:flex !important;flex-direction:column !important;gap:12px !important;';

    col2.appendChild(makeSettingsField('Panel Position', 'Screen quadrant placement', makeOptionGroup([
      { value: 'tl', label: '↖', title: 'Top left'     },
      { value: 'tr', label: '↗', title: 'Top right'    },
      { value: 'bl', label: '↙', title: 'Bottom left'  },
      { value: 'br', label: '↘', title: 'Bottom right' },
    ], settings.position, function (v) {
      settings.position = v; saveSettings();
      applyWrapPosition();
      settingsPanel.remove(); settingsPanel = null;
      buildSettingsPanel();
    })));

    var pickerGroup = document.createElement('div');
    pickerGroup.style.cssText = 'display:inline-flex !important;gap:6px !important;align-items:center !important;';

    var items = [
      { label: 'Match', val: settings.matchColor, title: 'Normal Match Color', cb: function (v) { settings.matchColor = v; saveSettings(); injectHighlightStyles(); } },
      { label: 'Active', val: settings.activeColor, title: 'Active Match Color', cb: function (v) { settings.activeColor = v; saveSettings(); injectHighlightStyles(); } },
      { label: 'Beacon', val: settings.beaconColor, title: 'Beacon Animation Color', cb: function (v) { settings.beaconColor = v; saveSettings(); } }
    ];

    items.forEach(function (item) {
      var picker = makeColorPicker(item.val, item.title, item.cb);
      pickerGroup.appendChild(picker);
    });

    col2.appendChild(makeSettingsField('Custom Colors', 'Interactive hex swatches', pickerGroup));

    grid.appendChild(col1);
    grid.appendChild(col2);
    settingsPanel.appendChild(grid);

    wrap.appendChild(settingsPanel);

    settingsPanel.animate([
      { opacity: 0, transform: p.isBottom ? 'translateY(8px)' : 'translateY(-8px)' },
      { opacity: 1, transform: 'translateY(0)' }
    ], {
      duration: 180,
      easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
      fill: 'forwards'
    });
  }

  function makeColorPicker(val, title, onChange) {
    var badge = document.createElement('div');
    badge.className = 'oc-color-badge';
    badge.title = title;
    
    var swatch = document.createElement('div');
    swatch.className = 'oc-color-badge-swatch';
    swatch.style.backgroundColor = val;
    
    var text = document.createElement('span');
    text.className = 'oc-color-badge-text';
    text.textContent = val.toUpperCase();
    
    var input = document.createElement('input');
    input.type = 'color';
    input.value = val;
    input.style.cssText = 'position:absolute !important;top:0 !important;left:0 !important;width:100% !important;height:100% !important;opacity:0 !important;cursor:pointer !important;padding:0 !important;border:none !important;';
    
    input.addEventListener('keydown', function (e) { e.stopPropagation(); });
    input.addEventListener('input', function () {
      var newColor = input.value;
      swatch.style.backgroundColor = newColor;
      text.textContent = newColor.toUpperCase();
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
    wrap.style.setProperty('top', p.top, 'important');
    wrap.style.setProperty('right', p.right, 'important');
    wrap.style.setProperty('bottom', p.bottom, 'important');
    wrap.style.setProperty('left', p.left, 'important');
    wrap.style.setProperty('flex-direction', p.isBottom ? 'column-reverse' : 'column', 'important');
    wrap.style.setProperty('border-radius', p.radius, 'important');
    wrap.style.setProperty('border', '1px solid var(--divider)', 'important');
  }

  // ── Favicon Management ────────────────────────────────────────────────────────

  function setSunglassesFavicon() {
    try {
      originalFavicons = [];
      var links = document.querySelectorAll("link[rel*='icon']");
      for (var i = 0; i < links.length; i++) {
        if (links[i] && links[i].parentNode) {
          originalFavicons.push({ el: links[i], parent: links[i].parentNode, nextSibling: links[i].nextSibling });
          links[i].remove();
        }
      }

      var link = document.createElement('link');
      link.id = 'oc-favicon';
      link.rel = 'icon';
      link.type = 'image/svg+xml';
      link.href = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y="80" font-size="80">🕶️</text></svg>');
      if (document.head) {
        document.head.appendChild(link);
      }
    } catch (e) {
      console.warn('Oculist: Failed to set custom favicon.', e);
    }
  }

  function restoreFavicons() {
    try {
      var fav = document.getElementById('oc-favicon');
      if (fav) fav.remove();

      originalFavicons.forEach(function (item) {
        if (item.el && item.parent) {
          try {
            item.parent.insertBefore(item.el, item.nextSibling);
          } catch (err) {}
        }
      });
    } catch (e) {
      console.warn('Oculist: Failed to restore original favicons.', e);
    }
    originalFavicons = [];
  }

  function applyBarTheme() {
    var t = T();
    bar.style.setProperty('background', t.bg, 'important');
    bar.style.setProperty('color', t.text, 'important');
    input.style.setProperty('background', t.inputBg, 'important');
    input.style.setProperty('border-color', t.inputBorder, 'important');
    input.style.setProperty('color', t.inputText, 'important');
    countEl.style.setProperty('color', t.text, 'important');
    [prevBtn, nextBtn, replayBtn, closeBtn].forEach(function (btn) {
      if (btn) btn.style.setProperty('color', t.text, 'important');
    });
    if (gearBtn) gearBtn.style.setProperty('color', settingsPanel ? t.accent : t.text, 'important');
  }

  // ── UI build ──────────────────────────────────────────────────────────────────

  function getSvgIcon(name, size) {
    size = size || 13;
    var svgs = {
      up: '<svg data-icon="up" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>',
      down: '<svg data-icon="down" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
      replay: '<svg data-icon="replay" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.72 2.73L21 8"/><polyline points="21 3 21 8 16 8"/></svg>',
      gear: '<svg data-icon="gear" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
      close: '<svg data-icon="close" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>'
    };
    return svgs[name] || '';
  }

  function makeIconBtn(iconName, title, size) {
    var t = T();
    var btn = document.createElement('button');
    var svgMarkup = getSvgIcon(iconName, size);
    if (svgMarkup) {
      try {
        var parser = new DOMParser();
        var doc = parser.parseFromString(svgMarkup, 'image/svg+xml');
        var svgEl = doc.documentElement;
        
        // Force inline high-contrast stroke, fill, and color on the SVG itself
        svgEl.style.setProperty('color', 'inherit', 'important');
        svgEl.style.setProperty('stroke', 'currentColor', 'important');
        svgEl.style.setProperty('fill', 'none', 'important');
        var strokeWidth = svgEl.getAttribute('stroke-width') || '2.5';
        svgEl.style.setProperty('stroke-width', strokeWidth, 'important');
        svgEl.style.setProperty('stroke-linecap', 'round', 'important');
        svgEl.style.setProperty('stroke-linejoin', 'round', 'important');
        
        // Recursively apply to all descendant nodes of the SVG
        var children = svgEl.querySelectorAll('*');
        for (var i = 0; i < children.length; i++) {
          children[i].style.setProperty('color', 'inherit', 'important');
          children[i].style.setProperty('stroke', 'currentColor', 'important');
          children[i].style.setProperty('fill', 'none', 'important');
          var childStrokeWidth = children[i].getAttribute('stroke-width') || strokeWidth;
          children[i].style.setProperty('stroke-width', childStrokeWidth, 'important');
          children[i].style.setProperty('stroke-linecap', 'round', 'important');
          children[i].style.setProperty('stroke-linejoin', 'round', 'important');
        }
        
        btn.appendChild(svgEl);
      } catch (err) {}
    }
    btn.title = title;
    btn.style.cssText = [
      'background:none !important', 'border:none !important', 'color:' + t.text + ' !important',
      'cursor:pointer !important', 'padding:6px !important', 'font-size:0 !important',
      'border-radius:4px !important', 'display:inline-flex !important', 'align-items:center !important', 'justify-content:center !important',
      'transition:color 150ms, background-color 150ms, transform 150ms !important'
    ].join(';');
    btn.addEventListener('mouseenter', function () {
      btn.style.setProperty('color', T().accent, 'important');
      btn.style.setProperty('background-color', settings.theme === 'dark' ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)', 'important');
      btn.style.setProperty('transform', 'scale(1.05)', 'important');
    });
    btn.addEventListener('mouseleave', function () {
      btn.style.setProperty('color', (btn === gearBtn && settingsPanel) ? T().accent : T().text, 'important');
      btn.style.setProperty('background-color', 'transparent', 'important');
      btn.style.setProperty('transform', 'none', 'important');
    });
    btn.addEventListener('mousedown', function () {
      btn.style.setProperty('transform', 'scale(0.95)', 'important');
    });
    btn.addEventListener('mouseup', function () {
      btn.style.setProperty('transform', 'scale(1.05)', 'important');
    });
    return btn;
  }

  function buildUI() {
    var t = T();

    wrap = document.createElement('div');
    wrap.id = 'oc-wrap';
    wrap.style.cssText = [
      'position:fixed !important', 'z-index:2147483647 !important', 'display:flex !important', 'overflow:hidden !important',
      'box-shadow:0 10px 30px -10px rgba(0,0,0,0.3), 0 1px 3px rgba(0,0,0,0.05) !important',
      'backdrop-filter:blur(16px) !important', '-webkit-backdrop-filter:blur(16px) !important',
      'transition:border-radius 200ms, box-shadow 200ms, backdrop-filter 200ms !important'
    ].join(';');
    applyWrapPosition();

    bar = document.createElement('div');
    bar.style.cssText = [
      'display:flex !important', 'align-items:center !important', 'gap:6px !important',
      'padding:6px 10px !important',
      'font:14px/1 system-ui,-apple-system,sans-serif !important',
      'background:' + t.bg + ' !important', 'color:' + t.text + ' !important',
    ].join(';');

    input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Find…';
    input.style.cssText = [
      'border:1px solid ' + t.inputBorder + ' !important', 'border-radius:6px !important',
      'background:' + t.inputBg + ' !important', 'color:' + t.inputText + ' !important',
      'padding:4px 8px !important', 'font-size:14px !important', 'width:200px !important',
      'outline:none !important', 'font-family:system-ui,-apple-system,sans-serif !important',
      'transition:border-color 150ms, box-shadow 150ms !important'
    ].join(';');
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
    input.addEventListener('focus', function () {
      input.style.setProperty('border-color', 'var(--accent)', 'important');
      input.style.setProperty('box-shadow', '0 0 0 2px ' + hexToRgba(settings.beaconColor || '#fbbf24', 0.2), 'important');
    });
    input.addEventListener('blur', function () {
      input.style.setProperty('border-color', T().inputBorder, 'important');
      input.style.setProperty('box-shadow', 'none', 'important');
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
    countEl.style.cssText = 'color:' + t.subtle + ';font-size:12px;min-width:58px;text-align:right;font-family:system-ui,-apple-system,sans-serif;margin-right:2px;';

    prevBtn = makeIconBtn('up', 'Previous  Shift+Enter');
    prevBtn.addEventListener('click', function () { findNext(true); });

    nextBtn = makeIconBtn('down', 'Next  Enter');
    nextBtn.addEventListener('click', function () { findNext(false); });

    replayBtn = makeIconBtn('replay', 'Replay Effect');
    replayBtn.addEventListener('click', function () { highlightActiveRange(true); });

    gearBtn = makeIconBtn('gear', 'Options');
    gearBtn.addEventListener('click', toggleSettings);

    closeBtn = makeIconBtn('close', 'Close  Esc');
    closeBtn.addEventListener('click', window.__ocDestroy);

    setNavEnabled(false);

    bar.appendChild(input);
    bar.appendChild(countEl);
    bar.appendChild(prevBtn);
    bar.appendChild(nextBtn);
    bar.appendChild(replayBtn);
    bar.appendChild(gearBtn);
    bar.appendChild(closeBtn);
    wrap.appendChild(bar);
    document.body.appendChild(wrap);
    applyBarTheme();
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
    var styleId = 'oc-highlight-styles';
    var el = document.getElementById(styleId);

    var matchColor = settings.matchColor || '#fef08a';
    var activeColor = settings.activeColor || '#f59e0b';
    var matchTextColor = getContrastColor(matchColor);
    var activeTextColor = getContrastColor(activeColor);

    var t = T();

    var css = [
      '::highlight(oculist-match) { background-color: ' + matchColor + ' !important; color: ' + matchTextColor + ' !important; }',
      '::highlight(oculist-active-match) { background-color: ' + activeColor + ' !important; color: ' + activeTextColor + ' !important; }',
      '#oc-wrap {',
      '  --bg: ' + t.bg + ';',
      '  --text: ' + t.text + ';',
      '  --subtle: ' + t.subtle + ';',
      '  --input-bg: ' + t.inputBg + ';',
      '  --input-border: ' + t.inputBorder + ';',
      '  --input-text: ' + t.inputText + ';',
      '  --accent: ' + t.accent + ';',
      '  --panel-bg: ' + t.panelBg + ';',
      '  --divider: ' + t.divider + ';',
      '  --btn-active-bg: ' + (settings.theme === 'dark' ? '#27272a' : '#ffffff') + ';',
      '  --btn-active-text: ' + (settings.theme === 'dark' ? '#fafafa' : '#09090b') + ';',
      '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;',
      '  backdrop-filter: blur(16px) saturate(180%);',
      '  -webkit-backdrop-filter: blur(16px) saturate(180%);',
      '}',
      '#oc-wrap svg, #oc-wrap svg * {',
      '  color: inherit !important;',
      '  fill: none !important;',
      '  stroke: currentColor !important;',
      '  stroke-width: inherit !important;',
      '  stroke-linecap: round !important;',
      '  stroke-linejoin: round !important;',
      '}',
      '#oc-wrap svg {',
      '  stroke-width: 2.5 !important;',
      '}',
      '#oc-wrap button {',
      '  color: var(--text) !important;',
      '  background: none !important;',
      '  border: none !important;',
      '  padding: 6px !important;',
      '  font-size: 0 !important;',
      '  border-radius: 4px !important;',
      '  display: inline-flex !important;',
      '  align-items: center !important;',
      '  justify-content: center !important;',
      '  transition: color 150ms, background-color 150ms, transform 150ms !important;',
      '  box-shadow: none !important;',
      '  margin: 0 !important;',
      '  width: auto !important;',
      '  height: auto !important;',
      '  min-width: 0 !important;',
      '  min-height: 0 !important;',
      '  max-width: none !important;',
      '  max-height: none !important;',
      '  line-height: 1 !important;',
      '  text-transform: none !important;',
      '  text-decoration: none !important;',
      '}',
      '#oc-wrap button:hover {',
      '  color: var(--accent) !important;',
      '  background-color: ' + (settings.theme === 'dark' ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)') + ' !important;',
      '  transform: scale(1.05) !important;',
      '}',
      '#oc-wrap button:active {',
      '  transform: scale(0.95) !important;',
      '}',
      '#oc-wrap button:disabled {',
      '  opacity: 0.5 !important;',
      '  cursor: default !important;',
      '  transform: none !important;',
      '  background: none !important;',
      '}',
      '#oc-wrap .oc-toggle-group {',
      '  display: inline-flex !important;',
      '  padding: 3px !important;',
      '  background: var(--input-bg) !important;',
      '  border-radius: 6px !important;',
      '  border: 1px solid var(--input-border) !important;',
      '  width: 100% !important;',
      '  box-sizing: border-box !important;',
      '}',
      '#oc-wrap .oc-toggle-btn {',
      '  flex: 1 !important;',
      '  border: none !important;',
      '  background: transparent !important;',
      '  color: var(--text) !important;',
      '  opacity: 0.8 !important;',
      '  padding: 4px 6px !important;',
      '  border-radius: 4px !important;',
      '  font-size: 10px !important;',
      '  font-weight: 600 !important;',
      '  cursor: pointer !important;',
      '  font-family: inherit !important;',
      '  text-align: center !important;',
      '  white-space: nowrap !important;',
      '  transition: all 150ms cubic-bezier(0.16, 1, 0.3, 1) !important;',
      '  box-shadow: none !important;',
      '  margin: 0 !important;',
      '  height: auto !important;',
      '  line-height: 1.2 !important;',
      '}',
      '#oc-wrap .oc-toggle-btn:hover {',
      '  color: var(--accent) !important;',
      '  opacity: 1 !important;',
      '  background: rgba(120, 120, 120, 0.12) !important;',
      '}',
      '#oc-wrap .oc-toggle-btn.active {',
      '  background: var(--btn-active-bg) !important;',
      '  color: var(--btn-active-text) !important;',
      '  opacity: 1 !important;',
      '  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1), 0 1px 1px rgba(0, 0, 0, 0.06) !important;',
      '}',
      '#oc-wrap .oc-color-badge {',
      '  position: relative !important;',
      '  display: inline-flex !important;',
      '  align-items: center !important;',
      '  justify-content: center !important;',
      '  flex: 1 !important;',
      '  gap: 5px !important;',
      '  padding: 4px 6px !important;',
      '  background: var(--input-bg) !important;',
      '  border: 1px solid var(--input-border) !important;',
      '  border-radius: 6px !important;',
      '  cursor: pointer !important;',
      '  box-sizing: border-box !important;',
      '  transition: border-color 150ms, transform 150ms, box-shadow 150ms !important;',
      '}',
      '#oc-wrap .oc-color-badge:hover {',
      '  border-color: var(--subtle) !important;',
      '  transform: translateY(-1px) !important;',
      '  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1) !important;',
      '}',
      '#oc-wrap .oc-color-badge-swatch {',
      '  width: 10px !important;',
      '  height: 10px !important;',
      '  border-radius: 50% !important;',
      '  border: 1px solid rgba(0, 0, 0, 0.15) !important;',
      '  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.05) !important;',
      '  flex-shrink: 0 !important;',
      '}',
      '#oc-wrap .oc-color-badge-text {',
      '  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace !important;',
      '  font-size: 8.5px !important;',
      '  font-weight: 600 !important;',
      '  color: var(--text) !important;',
      '  letter-spacing: 0.02em !important;',
      '}'
    ].join('\n');

    if (el) {
      el.textContent = css;
    } else {
      try {
        var s = document.createElement('style');
        s.id = styleId;
        s.textContent = css;
        document.head.appendChild(s);
      } catch (e) {
        console.warn('Oculist: Normal style injection failed, trying adoptedStyleSheets...', e);
        try {
          if (document.adoptedStyleSheets) {
            var sheet = new CSSStyleSheet();
            sheet.replaceSync(css);
            document.adoptedStyleSheets = [].concat(document.adoptedStyleSheets, [sheet]);
          }
        } catch (err) {
          console.error('Oculist: Failed to inject highlight styles due to strict CSP.', err);
        }
      }
    }
  }

  // ── Boot ──────────────────────────────────────────────────────────────────────

  function boot() {
    document.addEventListener('keydown', keydownHandler, { capture: true, passive: false });
    
    window.__ocToggle = function () {
      if (wrap) {
        window.__ocDestroy();
      } else {
        setSunglassesFavicon();
        injectHighlightStyles();
        buildUI();
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
        ['effect', 'position', 'theme', 'matchColor', 'activeColor', 'beaconColor'].forEach(function (k) {
          if (k in saved) settings[k] = saved[k];
        });
      }
      boot();
    });
  } else {
    try {
      var saved = JSON.parse(localStorage.getItem('oc-settings') || '{}');
      ['effect', 'position', 'theme', 'matchColor', 'activeColor', 'beaconColor'].forEach(function (k) {
        if (k in saved) settings[k] = saved[k];
      });
    } catch (e) {}
    boot();
  }

})();
