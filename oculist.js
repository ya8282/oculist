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
  try {
    var saved = JSON.parse(localStorage.getItem('oc-settings') || '{}');
    ['effect', 'position', 'theme', 'matchColor', 'activeColor', 'beaconColor'].forEach(function (k) {
      if (k in saved) settings[k] = saved[k];
    });
  } catch (e) {}

  function saveSettings() {
    try { localStorage.setItem('oc-settings', JSON.stringify(settings)); } catch (e) {}
  }

  // ── Theme + position tables ───────────────────────────────────────────────────

  var THEMES = {
    dark: {
      bg: 'rgba(9, 9, 11, 0.94)', text: '#fafafa', subtle: '#a1a1aa',
      inputBg: 'rgba(24, 24, 27, 0.75)', inputBorder: '#27272a', inputText: '#fafafa',
      accent: '#f59e0b', panelBg: 'rgba(9, 9, 11, 0.97)', divider: '#27272a',
    },
    light: {
      bg: 'rgba(255, 255, 255, 0.94)', text: '#09090b', subtle: '#71717a',
      inputBg: 'rgba(244, 244, 245, 0.75)', inputBorder: '#e4e4e7', inputText: '#09090b',
      accent: '#f59e0b', panelBg: 'rgba(255, 255, 255, 0.97)', divider: '#e4e4e7',
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

  // ── State ─────────────────────────────────────────────────────────────────────

  var searchRanges     = [];
  var activeIndex      = -1;
  var lastTerm         = '';
  var originalFavicons = [];
  var wrap, bar, input, countEl, prevBtn, nextBtn, replayBtn, gearBtn, closeBtn, settingsPanel;

  // ── Destroy ───────────────────────────────────────────────────────────────────

  window.__ocDestroy = function () {
    try {
      if (typeof Highlight !== 'undefined' && CSS.highlights) {
        CSS.highlights.delete('oculist-match');
        CSS.highlights.delete('oculist-active-match');
      }
    } catch (e) {}

    restoreFavicons();
    cancelBeacons();
    if (wrap) wrap.remove();
    
    var s = document.getElementById('oc-highlight-styles');
    if (s) s.remove();
    
    document.removeEventListener('keydown', keydownHandler, true);
    delete window.__ocDestroy;
    
    wrap = bar = input = countEl = prevBtn = nextBtn = replayBtn = gearBtn = closeBtn = settingsPanel = null;
    lastTerm = ''; activeIndex = -1; searchRanges = []; originalFavicons = [];
  };

  // ── Beacons ───────────────────────────────────────────────────────────────────

  function cancelBeacons() {
    var beacons = document.querySelectorAll('.oc-beacon');
    for (var i = 0; i < beacons.length; i++) {
      beacons[i].remove();
    }
  }

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
      { transform: 'scaleY(1)', opacity: 0.4, offset: 0.6 },
      { transform: 'scaleY(0)', opacity: 0 }
    ], {
      duration: 650,
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
      { transform: 'scaleY(1.2)', opacity: 0.85, offset: 0.65 },
      { transform: 'scaleY(0)', opacity: 0 }
    ], {
      duration: 650,
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
      { transform: 'scale(1)', opacity: 0.9, offset: 0.5 },
      { transform: 'scale(1.5) scaleY(0)', opacity: 0 }
    ], {
      duration: 650,
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
        duration: 500 + Math.random() * 300,
        easing: 'cubic-bezier(0.1, 0.8, 0.2, 1)',
        fill: 'forwards'
      });
    }

    setTimeout(function() {
      laserContainer.remove();
    }, 900);
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
        { transform: 'scale(12)', opacity: 0 }
      ], {
        duration: 750,
        delay: r * 100,
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
        duration: 600 + Math.random() * 250,
        easing: 'cubic-bezier(0.25, 1, 0.5, 1)',
        fill: 'forwards'
      });
    }

    setTimeout(function() {
      container.remove();
    }, 1100);
  }

  function animate(rect) {
    ({ hud: animateAnimeLaser, iris: animateIris, sweep: animateWarpDrive }
      [settings.effect] || animateAnimeLaser)(rect);
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

    if (backwards) {
      activeIndex = (activeIndex <= 0) ? searchRanges.length - 1 : activeIndex - 1;
    } else {
      activeIndex = (activeIndex >= searchRanges.length - 1) ? 0 : activeIndex + 1;
    }

    highlightActiveRange(true);
  }

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
        btn.style.opacity = enabled ? '1' : '0.3';
        btn.style.cursor  = enabled ? 'pointer' : 'default';
      }
    });

    var hasMatches = searchRanges.length > 0;
    if (replayBtn) {
      replayBtn.disabled      = !hasMatches;
      replayBtn.style.opacity = hasMatches ? '1' : '0.3';
      replayBtn.style.cursor  = hasMatches ? 'pointer' : 'default';
    }
  }

  // ── Event handlers ────────────────────────────────────────────────────────────

  function keydownHandler(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      e.stopPropagation();
      if (!wrap) buildUI();
      input.focus();
      input.select();
      return;
    }
    if (!wrap) return;
    if (e.key === 'Escape') { window.__ocDestroy(); return; }
    
    if (e.key === 'Enter') {
      if (wrap.contains(document.activeElement)) {
        e.preventDefault();
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
    field.style.cssText = 'display:flex;flex-direction:column;gap:5px;width:100%;box-sizing:border-box';

    var meta = document.createElement('div');
    meta.style.cssText = 'display:flex;flex-direction:column;gap:1px;margin-bottom:2px;';

    var lbl = document.createElement('span');
    lbl.textContent = labelText;
    lbl.style.cssText = 'font-size:11px;color:var(--text);font-family:system-ui,sans-serif;font-weight:600;letter-spacing:0.01em;';

    var desc = document.createElement('span');
    desc.textContent = descText;
    desc.style.cssText = 'font-size:9px;color:var(--subtle);font-family:system-ui,sans-serif;font-weight:400;';

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
      'background:' + t.panelBg,
      p.isBottom ? 'border-bottom:1px solid var(--divider)' : 'border-top:1px solid var(--divider)',
      'padding:14px 16px',
      'display:flex', 'flex-direction:column', 'gap:14px',
      'box-sizing:border-box', 'width:100%',
    ].join(';');

    // Title / Header in Settings panel
    var header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--divider);padding-bottom:8px;margin-bottom:2px;';
    
    // Left: Title + Subtitle
    var titleContainer = document.createElement('div');
    titleContainer.style.cssText = 'display:flex;flex-direction:column;gap:1px;';

    var title = document.createElement('span');
    title.textContent = 'OCULIST PREFERENCES';
    title.style.cssText = 'font-size:10px;color:var(--text);font-family:system-ui,-apple-system,sans-serif;font-weight:700;letter-spacing:0.05em;';
    
    var subtitle = document.createElement('span');
    subtitle.textContent = 'Configure search behavior & effects';
    subtitle.style.cssText = 'font-size:9px;color:var(--subtle);font-family:system-ui,-apple-system,sans-serif;font-weight:400;';

    titleContainer.appendChild(title);
    titleContainer.appendChild(subtitle);
    header.appendChild(titleContainer);

    // Right: Reset Button
    var resetBtn = document.createElement('button');
    resetBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:4px;display:inline-block;vertical-align:-1px;"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><polyline points="16 3 21 3 21 8"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><polyline points="8 21 3 21 3 16"/></svg>Reset';
    resetBtn.style.cssText = [
      'background:none', 'border:none', 'color:var(--subtle)',
      'font-size:9.5px', 'font-family:system-ui,sans-serif', 'font-weight:600',
      'cursor:pointer', 'padding:3px 6px', 'border-radius:4px',
      'display:inline-flex', 'align-items:center',
      'transition:color 150ms, background-color 150ms'
    ].join(';');
    resetBtn.addEventListener('mouseenter', function () {
      resetBtn.style.color = 'var(--accent)';
      resetBtn.style.backgroundColor = settings.theme === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';
    });
    resetBtn.addEventListener('mouseleave', function () {
      resetBtn.style.color = 'var(--subtle)';
      resetBtn.style.backgroundColor = 'transparent';
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
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:12px 18px;width:100%;box-sizing:border-box;';

    // Col 1: Effect & Theme
    var col1 = document.createElement('div');
    col1.className = 'oc-settings-col';
    col1.style.cssText = 'display:flex;flex-direction:column;gap:12px;';

    col1.appendChild(makeSettingsField('Highlight Effect', 'Choose match visual transition', makeOptionGroup([
      { value: 'hud',   label: 'Anime Laser' },
      { value: 'iris',  label: 'Cinematic'   },
      { value: 'sweep', label: 'Warp Drive'  },
    ], settings.effect, function (v) {
      settings.effect = v; saveSettings();
    })));

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
    col2.style.cssText = 'display:flex;flex-direction:column;gap:12px;';

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
    pickerGroup.style.cssText = 'display:inline-flex;gap:6px;align-items:center';

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
    input.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;opacity:0;cursor:pointer;padding:0;border:none;';
    
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
    wrap.style.top           = p.top;
    wrap.style.right         = p.right;
    wrap.style.bottom        = p.bottom;
    wrap.style.left          = p.left;
    wrap.style.flexDirection = p.isBottom ? 'column-reverse' : 'column';
    wrap.style.borderRadius  = p.radius;
    wrap.style.border        = '1px solid var(--divider)';
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
    bar.style.background     = t.bg;
    bar.style.color          = t.text;
    input.style.background   = t.inputBg;
    input.style.borderColor  = t.inputBorder;
    input.style.color        = t.inputText;
    countEl.style.color      = t.subtle;
    [prevBtn, nextBtn, replayBtn, closeBtn].forEach(function (btn) {
      if (btn) btn.style.color = t.subtle;
    });
    if (gearBtn) gearBtn.style.color = settingsPanel ? t.accent : t.subtle;
  }

  // ── UI build ──────────────────────────────────────────────────────────────────

  function getSvgIcon(name, size) {
    size = size || 13;
    var svgs = {
      up: '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>',
      down: '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
      replay: '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.72 2.73L21 8"/><polyline points="21 3 21 8 16 8"/></svg>',
      gear: '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
      close: '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>'
    };
    return svgs[name] || '';
  }

  function makeIconBtn(iconName, title, size) {
    var t = T();
    var btn = document.createElement('button');
    btn.innerHTML = getSvgIcon(iconName, size);
    btn.title = title;
    btn.style.cssText = [
      'background:none', 'border:none', 'color:' + t.subtle,
      'cursor:pointer', 'padding:6px', 'font-size:0',
      'border-radius:4px', 'display:inline-flex', 'align-items:center', 'justify-content:center',
      'transition:color 150ms, background-color 150ms, transform 150ms'
    ].join(';');
    btn.addEventListener('mouseenter', function () {
      btn.style.color = T().text;
      btn.style.backgroundColor = settings.theme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)';
      btn.style.transform = 'scale(1.05)';
    });
    btn.addEventListener('mouseleave', function () {
      btn.style.color = (btn === gearBtn && settingsPanel) ? T().accent : T().subtle;
      btn.style.backgroundColor = 'transparent';
      btn.style.transform = 'none';
    });
    btn.addEventListener('mousedown', function () {
      btn.style.transform = 'scale(0.95)';
    });
    btn.addEventListener('mouseup', function () {
      btn.style.transform = 'scale(1.05)';
    });
    return btn;
  }

  function buildUI() {
    var t = T();

    wrap = document.createElement('div');
    wrap.id = 'oc-wrap';
    wrap.style.cssText = [
      'position:fixed', 'z-index:2147483647', 'display:flex', 'overflow:hidden',
      'box-shadow:0 10px 30px -10px rgba(0,0,0,0.3), 0 1px 3px rgba(0,0,0,0.05)',
      'backdrop-filter:blur(16px)', '-webkit-backdrop-filter:blur(16px)',
      'transition:border-radius 200ms, box-shadow 200ms, backdrop-filter 200ms'
    ].join(';');
    applyWrapPosition();

    bar = document.createElement('div');
    bar.style.cssText = [
      'display:flex', 'align-items:center', 'gap:6px',
      'padding:6px 10px',
      'font:14px/1 system-ui,-apple-system,sans-serif',
      'background:' + t.bg, 'color:' + t.text,
    ].join(';');

    input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Find…';
    input.style.cssText = [
      'border:1px solid ' + t.inputBorder, 'border-radius:6px',
      'background:' + t.inputBg, 'color:' + t.inputText,
      'padding:4px 8px', 'font-size:14px', 'width:200px',
      'outline:none', 'font-family:system-ui,-apple-system,sans-serif',
      'transition:border-color 150ms, box-shadow 150ms'
    ].join(';');
    input.addEventListener('keydown', function (e) { e.stopPropagation(); });
    input.addEventListener('focus', function () {
      input.style.borderColor = 'var(--accent)';
      input.style.boxShadow = '0 0 0 2px ' + hexToRgba(settings.beaconColor || '#fbbf24', 0.2);
    });
    input.addEventListener('blur', function () {
      input.style.borderColor = T().inputBorder;
      input.style.boxShadow = 'none';
    });

    var debounceTimer;
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
      '.oc-toggle-group {',
      '  display: inline-flex;',
      '  padding: 3px;',
      '  background: var(--input-bg);',
      '  border-radius: 6px;',
      '  border: 1px solid var(--input-border);',
      '  width: 100%;',
      '  box-sizing: border-box;',
      '}',
      '.oc-toggle-btn {',
      '  flex: 1;',
      '  border: none;',
      '  background: transparent;',
      '  color: var(--subtle);',
      '  padding: 4px 6px;',
      '  border-radius: 4px;',
      '  font-size: 10px;',
      '  font-weight: 600;',
      '  cursor: pointer;',
      '  font-family: inherit;',
      '  text-align: center;',
      '  white-space: nowrap;',
      '  transition: all 150ms cubic-bezier(0.16, 1, 0.3, 1);',
      '}',
      '.oc-toggle-btn:hover {',
      '  color: var(--text);',
      '  background: rgba(120, 120, 120, 0.08);',
      '}',
      '.oc-toggle-btn.active {',
      '  background: var(--btn-active-bg);',
      '  color: var(--btn-active-text);',
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
      '  background: var(--input-bg);',
      '  border: 1px solid var(--input-border);',
      '  border-radius: 6px;',
      '  cursor: pointer;',
      '  box-sizing: border-box;',
      '  transition: border-color 150ms, transform 150ms, box-shadow 150ms;',
      '}',
      '.oc-color-badge:hover {',
      '  border-color: var(--subtle);',
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
      '  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;',
      '  font-size: 8.5px;',
      '  font-weight: 600;',
      '  color: var(--text);',
      '  letter-spacing: 0.02em;',
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

  document.addEventListener('keydown', keydownHandler, true);
  setSunglassesFavicon();
  injectHighlightStyles();
  buildUI();

})();
