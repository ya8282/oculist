(function () {
  'use strict';

  if (window.__ocDestroy) { window.__ocDestroy(); return; }

  // ── Settings (persisted) ──────────────────────────────────────────────────────

  var settings = { effect: 'hud', position: 'tr', theme: 'dark' };

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
      bg: '#1a1a2e', text: '#e5e7eb', subtle: '#9ca3af',
      inputBg: '#111827', inputBorder: '#374151', inputText: '#f9fafb',
      accent: '#f59e0b', panelBg: '#0f172a', divider: '#2d3748',
    },
    light: {
      bg: '#ffffff', text: '#1f2937', subtle: '#6b7280',
      inputBg: '#f3f4f6', inputBorder: '#d1d5db', inputText: '#111827',
      accent: '#f59e0b', panelBg: '#f9fafb', divider: '#e5e7eb',
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
  var wrap, bar, input, countEl, prevBtn, nextBtn, gearBtn, closeBtn, settingsPanel;

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
    
    wrap = bar = input = countEl = prevBtn = nextBtn = gearBtn = closeBtn = settingsPanel = null;
    lastTerm = ''; activeIndex = -1; searchRanges = []; originalFavicons = [];
  };

  // ── Beacons ───────────────────────────────────────────────────────────────────

  function cancelBeacons() {
    var beacons = document.querySelectorAll('.oc-beacon');
    for (var i = 0; i < beacons.length; i++) {
      beacons[i].remove();
    }
  }

  // ── Effects (CSP-Compliant via Web Animations API & Document Root Mount) ───

  function animateHUD(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;

    var x = rect.left + window.scrollX;
    var y = rect.top + window.scrollY;
    var w = rect.width;
    var h = rect.height;

    var hud = document.createElement('div');
    hud.className = 'oc-beacon';
    hud.style.cssText = [
      'position:absolute',
      'left:' + x + 'px', 'top:' + y + 'px',
      'width:' + w + 'px', 'height:' + h + 'px',
      'pointer-events:none', 'z-index:2147483643',
    ].join(';');
    document.documentElement.appendChild(hud);

    var corners = ['tl', 'tr', 'bl', 'br'];
    var cornerSize = Math.max(14, Math.min(w, h, 20));
    var strokeWidth = 3.5;
    var color = '#fbbf24';

    var bgFlash = document.createElement('div');
    bgFlash.style.cssText = [
      'position:absolute', 'top:0', 'left:0', 'right:0', 'bottom:0',
      'background:' + color, 'opacity:0.35', 'border-radius:2px', 'pointer-events:none'
    ].join(';');
    hud.appendChild(bgFlash);

    bgFlash.animate([
      { opacity: 0.6, transform: 'scale(1.15)' },
      { opacity: 0.15, transform: 'scale(1)', offset: 0.25 },
      { opacity: 0 }
    ], {
      duration: 1200,
      easing: 'ease-out',
      fill: 'forwards'
    });

    corners.forEach(function (pos) {
      var c = document.createElement('div');
      c.style.cssText = [
        'position:absolute',
        'width:' + cornerSize + 'px', 'height:' + cornerSize + 'px',
        'border-color:' + color,
        'border-style:solid',
        'border-width:0',
        'filter:drop-shadow(0 0 6px ' + color + ') drop-shadow(0 0 12px ' + color + ')',
        'pointer-events:none',
      ].join(';');

      var startX = 0, startY = 0;
      var offset = 22;
      if (pos === 'tl') {
        c.style.top = '0'; c.style.left = '0';
        c.style.borderTopWidth = strokeWidth + 'px';
        c.style.borderLeftWidth = strokeWidth + 'px';
        startX = -offset; startY = -offset;
      } else if (pos === 'tr') {
        c.style.top = '0'; c.style.right = '0';
        c.style.borderTopWidth = strokeWidth + 'px';
        c.style.borderRightWidth = strokeWidth + 'px';
        startX = offset; startY = -offset;
      } else if (pos === 'bl') {
        c.style.bottom = '0'; c.style.left = '0';
        c.style.borderBottomWidth = strokeWidth + 'px';
        c.style.borderLeftWidth = strokeWidth + 'px';
        startX = -offset; startY = offset;
      } else if (pos === 'br') {
        c.style.bottom = '0'; c.style.right = '0';
        c.style.borderBottomWidth = strokeWidth + 'px';
        c.style.borderRightWidth = strokeWidth + 'px';
        startX = offset; startY = offset;
      }
      hud.appendChild(c);

      c.animate([
        { opacity: 0, transform: 'translate(' + startX + 'px, ' + startY + 'px) scale(2)' },
        { opacity: 1, transform: 'translate(0, 0) scale(1)', offset: 0.15 },
        { opacity: 1, transform: 'translate(0, 0) scale(1)', offset: 0.8 },
        { opacity: 0, transform: 'scale(0.7)' }
      ], {
        duration: 1600,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
        fill: 'forwards'
      });
    });

    var scan = document.createElement('div');
    scan.style.cssText = [
      'position:absolute', 'left:-6px', 'right:-6px',
      'height:4px', 'background:linear-gradient(90deg, transparent, #fff, ' + color + ', transparent)',
      'box-shadow:0 0 15px ' + color + ', 0 0 30px ' + color,
      'opacity:0.95', 'pointer-events:none'
    ].join(';');
    hud.appendChild(scan);

    scan.animate([
      { top: '-8px', opacity: 0 },
      { top: '-8px', opacity: 1, offset: 0.05 },
      { top: (h + 8) + 'px', opacity: 1, offset: 0.55 },
      { top: (h + 8) + 'px', opacity: 0 }
    ], {
      duration: 1600,
      easing: 'ease-in-out',
      fill: 'forwards'
    });

    setTimeout(function() {
      hud.remove();
    }, 1700);
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

    var ring = document.createElement('div');
    ring.className = 'oc-beacon';
    ring.style.cssText = [
      'position:fixed',
      'left:' + (cx - w/2) + 'px', 'top:' + (cy - h/2) + 'px',
      'width:' + w + 'px', 'height:' + h + 'px',
      'border:2.5px solid #38bdf8',
      'border-radius:50%',
      'box-shadow:0 0 20px #38bdf8, inset 0 0 20px #38bdf8',
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

  function animateSweep(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;

    var x = rect.left + window.scrollX;
    var y = rect.top + window.scrollY;
    var w = rect.width;
    var h = rect.height;

    var container = document.createElement('div');
    container.className = 'oc-beacon';
    container.style.cssText = [
      'position:absolute',
      'left:' + (x - 8) + 'px', 'top:' + (y - 5) + 'px',
      'width:' + (w + 16) + 'px', 'height:' + (h + 10) + 'px',
      'overflow:hidden',
      'pointer-events:none', 'z-index:2147483643',
    ].join(';');
    document.documentElement.appendChild(container);

    var trail = document.createElement('div');
    trail.style.cssText = [
      'position:absolute', 'top:0', 'bottom:0', 'left:8px',
      'width:' + w + 'px',
      'background:linear-gradient(90deg, rgba(245, 158, 11, 0.75) 0%, rgba(251, 191, 36, 0.15) 85%, transparent 100%)',
      'transform-origin:left',
      'pointer-events:none'
    ].join(';');
    container.appendChild(trail);

    trail.animate([
      { transform: 'scaleX(0)', opacity: 0 },
      { transform: 'scaleX(1)', opacity: 1, offset: 0.25 },
      { transform: 'scaleX(1)', opacity: 0.9, offset: 0.75 },
      { transform: 'scaleX(1)', opacity: 0 }
    ], {
      duration: 1400,
      easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
      fill: 'forwards'
    });

    var line = document.createElement('div');
    line.style.cssText = [
      'position:absolute', 'top:0', 'bottom:0', 'left:8px',
      'width:5px', 'background:#ffffff',
      'border-left:1.5px solid #f59e0b',
      'box-shadow:0 0 15px #f59e0b, 0 0 30px #f59e0b, 0 0 50px #f59e0b',
      'pointer-events:none'
    ].join(';');
    container.appendChild(line);

    line.animate([
      { transform: 'translateX(0px)', opacity: 0 },
      { transform: 'translateX(0px)', opacity: 1, offset: 0.05 },
      { transform: 'translateX(' + w + 'px)', opacity: 1, offset: 0.8 },
      { transform: 'translateX(' + w + 'px)', opacity: 0 }
    ], {
      duration: 1400,
      easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
      fill: 'forwards'
    });

    var pop = document.createElement('div');
    pop.style.cssText = [
      'position:absolute',
      'left:' + (w/2) + 'px', 'top:' + (h/2) + 'px',
      'width:12px', 'height:10px',
      'border-radius:50%', 'background:#fbbf24',
      'box-shadow:0 0 25px #fbbf24, 0 0 50px #fbbf24',
      'opacity:0', 'pointer-events:none'
    ].join(';');
    container.appendChild(pop);

    pop.animate([
      { transform: 'scale(1)', opacity: 0.90 },
      { transform: 'scale(12)', opacity: 0 }
    ], {
      duration: 600,
      easing: 'ease-out',
      fill: 'forwards'
    });

    setTimeout(function() {
      container.remove();
    }, 1500);
  }

  function animate(rect) {
    ({ hud: animateHUD, iris: animateIris, sweep: animateSweep }
      [settings.effect] || animateHUD)(rect);
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
          if (!parent || SKIP_TAGS[parent.tagName]) {
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
    var term = input.value.trim();
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
        btn.style.opacity = enabled ? '1' : '0.3';
        btn.style.cursor  = enabled ? 'pointer' : 'default';
      }
    });
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
    var group = document.createElement('span');
    group.style.cssText = 'display:inline-flex;gap:3px;flex-wrap:wrap';

    items.forEach(function (item) {
      var btn = document.createElement('button');
      btn.textContent = item.label;
      btn.title = item.title || item.label;
      btn.dataset.val = item.value;
      stylePill(btn, item.value === currentVal);
      btn.addEventListener('click', function () {
        onChange(item.value);
        group.querySelectorAll('button').forEach(function (b) {
          stylePill(b, b.dataset.val === item.value);
        });
      });
      group.appendChild(btn);
    });

    return group;
  }

  function stylePill(btn, active) {
    var t = T();
    btn.style.cssText = [
      'border:1px solid ' + (active ? t.accent : t.divider),
      'background:' + (active ? t.accent : 'transparent'),
      'color:' + (active ? '#1a1a2e' : t.text),
      'cursor:pointer', 'border-radius:3px',
      'padding:2px 8px', 'font-size:11px', 'line-height:1.7',
      'font-family:system-ui,sans-serif',
    ].join(';');
  }

  function makeSettingsRow(labelText, groupEl) {
    var t = T();
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px';

    var lbl = document.createElement('span');
    lbl.textContent = labelText;
    lbl.style.cssText = 'font-size:11px;min-width:52px;color:' + t.subtle + ';font-family:system-ui,sans-serif';

    row.appendChild(lbl);
    row.appendChild(groupEl);
    return row;
  }

  function buildSettingsPanel() {
    var t = T();
    var p = P();

    settingsPanel = document.createElement('div');
    settingsPanel.style.cssText = [
      'background:' + t.panelBg,
      p.isBottom ? 'border-bottom:1px solid ' + t.divider : 'border-top:1px solid ' + t.divider,
      'padding:10px 12px',
      'display:flex', 'flex-direction:column', 'gap:8px',
    ].join(';');

    settingsPanel.appendChild(makeSettingsRow('Effect', makeOptionGroup([
      { value: 'hud',   label: 'Tactical HUD' },
      { value: 'iris',  label: 'Cinematic'   },
      { value: 'sweep', label: 'Laser Sweep' },
    ], settings.effect, function (v) {
      settings.effect = v; saveSettings();
    })));

    settingsPanel.appendChild(makeSettingsRow('Position', makeOptionGroup([
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

    settingsPanel.appendChild(makeSettingsRow('Theme', makeOptionGroup([
      { value: 'dark',  label: 'Dark'  },
      { value: 'light', label: 'Light' },
    ], settings.theme, function (v) {
      settings.theme = v; saveSettings();
      applyBarTheme();
      settingsPanel.remove(); settingsPanel = null;
      buildSettingsPanel();
      gearBtn.style.color = T().accent;
    })));

    wrap.appendChild(settingsPanel);
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
    [prevBtn, nextBtn, closeBtn].forEach(function (btn) {
      if (btn) btn.style.color = t.subtle;
    });
    if (gearBtn) gearBtn.style.color = settingsPanel ? t.accent : t.subtle;
  }

  // ── UI build ──────────────────────────────────────────────────────────────────

  function makeIconBtn(symbol, title) {
    var t = T();
    var btn = document.createElement('button');
    btn.textContent = symbol;
    btn.title = title;
    btn.style.cssText = [
      'background:none', 'border:none', 'color:' + t.subtle,
      'cursor:pointer', 'padding:2px 5px', 'font-size:13px',
      'border-radius:3px', 'line-height:1', 'font-family:system-ui,sans-serif',
    ].join(';');
    btn.addEventListener('mouseenter', function () { btn.style.color = T().text; });
    btn.addEventListener('mouseleave', function () {
      btn.style.color = (btn === gearBtn && settingsPanel) ? T().accent : T().subtle;
    });
    return btn;
  }

  function buildUI() {
    var t = T();

    wrap = document.createElement('div');
    wrap.id = 'oc-wrap';
    wrap.style.cssText = 'position:fixed;z-index:2147483647;display:flex;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.5)';
    applyWrapPosition();

    bar = document.createElement('div');
    bar.style.cssText = [
      'display:flex', 'align-items:center', 'gap:4px',
      'padding:6px 10px',
      'font:14px/1 system-ui,sans-serif',
      'background:' + t.bg, 'color:' + t.text,
    ].join(';');

    input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Find…';
    input.style.cssText = [
      'border:1px solid ' + t.inputBorder, 'border-radius:4px',
      'background:' + t.inputBg, 'color:' + t.inputText,
      'padding:4px 8px', 'font-size:14px', 'width:200px',
      'outline:none', 'font-family:system-ui,sans-serif',
    ].join(';');
    input.addEventListener('keydown', function (e) { e.stopPropagation(); });

    var debounceTimer;
    input.addEventListener('input', function () {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        var term = input.value.trim();
        lastTerm = term;
        performSearch(term);
        if (searchRanges.length > 0) {
          activeIndex = 0;
          highlightActiveRange(false);
        }
      }, 150);
    });

    countEl = document.createElement('span');
    countEl.style.cssText = 'color:' + t.subtle + ';font-size:12px;min-width:58px;text-align:right';

    prevBtn = makeIconBtn('▲', 'Previous  Shift+Enter');
    prevBtn.addEventListener('click', function () { findNext(true); });

    nextBtn = makeIconBtn('▼', 'Next  Enter');
    nextBtn.addEventListener('click', function () { findNext(false); });

    gearBtn = makeIconBtn('⚙', 'Options');
    gearBtn.style.fontSize = '15px';
    gearBtn.addEventListener('click', toggleSettings);

    closeBtn = makeIconBtn('✕', 'Close  Esc');
    closeBtn.addEventListener('click', window.__ocDestroy);

    setNavEnabled(false);

    bar.appendChild(input);
    bar.appendChild(countEl);
    bar.appendChild(prevBtn);
    bar.appendChild(nextBtn);
    bar.appendChild(gearBtn);
    bar.appendChild(closeBtn);
    wrap.appendChild(bar);
    document.body.appendChild(wrap);
    input.focus();
  }

  function injectHighlightStyles() {
    var styleId = 'oc-highlight-styles';
    if (document.getElementById(styleId)) return;

    var css = [
      '::highlight(oculist-match) { background-color: #fef08a !important; color: #1a1a2e !important; }',
      '::highlight(oculist-active-match) { background-color: #f59e0b !important; color: #1a1a2e !important; }'
    ].join('\n');

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

  // ── Boot ──────────────────────────────────────────────────────────────────────

  function boot() {
    document.addEventListener('keydown', keydownHandler, true);
    setSunglassesFavicon();
    injectHighlightStyles();
    buildUI();
  }

  // Load settings via chrome.storage.sync with fallback to localStorage
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.get('oc-settings', function (data) {
      if (data && data['oc-settings']) {
        var saved = data['oc-settings'];
        ['effect', 'position', 'theme'].forEach(function (k) {
          if (k in saved) settings[k] = saved[k];
        });
      }
      boot();
    });
  } else {
    try {
      var saved = JSON.parse(localStorage.getItem('oc-settings') || '{}');
      ['effect', 'position', 'theme'].forEach(function (k) {
        if (k in saved) settings[k] = saved[k];
      });
    } catch (e) {}
    boot();
  }

})();
