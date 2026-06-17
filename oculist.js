(function () {
  'use strict';

  if (window.__ocDestroy) { window.__ocDestroy(); return; }

  // ── Settings (persisted) ──────────────────────────────────────────────────────

  var settings = { effect: 'pulse', position: 'tr', theme: 'dark' };
  try {
    var saved = JSON.parse(localStorage.getItem('oc-settings') || '{}');
    ['effect', 'position', 'theme'].forEach(function (k) { if (k in saved) settings[k] = saved[k]; });
  } catch (e) {}

  function saveSettings() {
    try { localStorage.setItem('oc-settings', JSON.stringify(settings)); } catch (e) {}
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

  var searchRanges = [];
  var activeIndex  = -1;
  var lastTerm     = '';
  var wrap, bar, input, countEl, prevBtn, nextBtn, gearBtn, closeBtn, settingsPanel;

  // ── Destroy ───────────────────────────────────────────────────────────────────

  window.__ocDestroy = function () {
    try {
      if (typeof Highlight !== 'undefined' && CSS.highlights) {
        CSS.highlights.delete('oculist-match');
        CSS.highlights.delete('oculist-active-match');
      }
    } catch (e) {}

    cancelBeacons();
    if (wrap) wrap.remove();
    
    var s = document.getElementById('oc-highlight-styles');
    if (s) s.remove();
    
    document.removeEventListener('keydown', keydownHandler, true);
    delete window.__ocDestroy;
    
    wrap = bar = input = countEl = prevBtn = nextBtn = gearBtn = closeBtn = settingsPanel = null;
    lastTerm = ''; activeIndex = -1; searchRanges = [];
  };

  // ── Beacons ───────────────────────────────────────────────────────────────────

  function cancelBeacons() {
    var beacons = document.querySelectorAll('.oc-beacon');
    for (var i = 0; i < beacons.length; i++) {
      beacons[i].remove();
    }
  }

  // ── Effects (CSP-Compliant via Web Animations API) ────────────────────────────

  function animatePulse(rect) {
    var cx = rect.left + window.scrollX + rect.width / 2;
    var cy = rect.top + window.scrollY + rect.height / 2;
    var pad = Math.max(rect.width / 2, 14);

    var fill = document.createElement('div');
    fill.className = 'oc-beacon';
    fill.style.cssText = [
      'position:absolute',
      'left:' + (cx - pad) + 'px', 'top:' + (cy - pad) + 'px',
      'width:' + (pad * 2) + 'px', 'height:' + (pad * 2) + 'px',
      'background:#fef08a', 'border-radius:4px',
      'pointer-events:none', 'z-index:2147483643',
    ].join(';');
    document.body.appendChild(fill);

    var fillAnim = fill.animate([
      { opacity: 0.7 },
      { opacity: 0.5, offset: 0.4 },
      { opacity: 0 }
    ], {
      duration: 2200,
      easing: 'ease-out',
      fill: 'forwards'
    });

    var ring = document.createElement('div');
    ring.className = 'oc-beacon';
    ring.style.cssText = [
      'position:absolute',
      'left:' + (cx - pad) + 'px', 'top:' + (cy - pad) + 'px',
      'width:' + (pad * 2) + 'px', 'height:' + (pad * 2) + 'px',
      'border:3px solid #fff', 'border-radius:4px',
      'pointer-events:none', 'z-index:2147483644',
    ].join(';');
    document.body.appendChild(ring);

    var ringAnim = ring.animate([
      { opacity: 1, boxShadow: '0 0 0 0px rgba(245,158,11,1), 0 0 0 0px rgba(255,255,255,0)' },
      { opacity: 1, boxShadow: '0 0 0 14px rgba(245,158,11,0.85), 0 0 0 4px rgba(255,255,255,1)', offset: 0.18 },
      { opacity: 0.85, boxShadow: '0 0 0 14px rgba(245,158,11,0.4), 0 0 0 4px rgba(255,255,255,0.5)', offset: 0.60 },
      { opacity: 0, boxShadow: '0 0 0 44px rgba(245,158,11,0), 0 0 0 44px rgba(255,255,255,0)' }
    ], {
      duration: 2200,
      easing: 'ease-out',
      fill: 'forwards'
    });

    Promise.all([fillAnim.finished, ringAnim.finished]).then(function () {
      fill.remove();
      ring.remove();
    }).catch(function () {
      fill.remove();
      ring.remove();
    });
  }

  function animateSpotlight(rect) {
    var cx = rect.left + rect.width  / 2;
    var cy = rect.top  + rect.height / 2;
    var rx = Math.max(rect.width  + 100, 140);
    var ry = Math.max(rect.height + 80,   80);

    var el = document.createElement('div');
    el.className = 'oc-beacon';
    el.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'bottom:0',
      'pointer-events:none', 'z-index:2147483642',
      'background:radial-gradient(ellipse ' + rx + 'px ' + ry + 'px at ' + cx + 'px ' + cy + 'px,' +
        'transparent 0%,transparent 50%,rgba(0,0,0,0.85) 90%)'
    ].join(';');
    document.body.appendChild(el);

    var anim = el.animate([
      { opacity: 0 },
      { opacity: 1, offset: 0.10 },
      { opacity: 0.9, offset: 0.75 },
      { opacity: 0 }
    ], {
      duration: 2500,
      easing: 'ease-out',
      fill: 'forwards'
    });

    anim.finished.then(function () {
      el.remove();
    }).catch(function () {
      el.remove();
    });
  }

  function animateRing(rect) {
    var cx = rect.left + window.scrollX + rect.width  / 2;
    var cy = rect.top + window.scrollY + rect.height / 2;
    var maxR = Math.round(Math.min(Math.min(window.innerWidth, window.innerHeight) * 0.7, 700));

    var configs = [
      { r: maxR, duration: 2800 },
      { r: maxR * 0.55, duration: 3500 }
    ];

    configs.forEach(function (cfg) {
      var r = cfg.r;
      var el = document.createElement('div');
      el.className = 'oc-beacon';
      el.style.cssText = [
        'position:absolute',
        'left:' + cx + 'px', 'top:' + cy + 'px',
        'width:0', 'height:0', 'border-radius:50%',
        'pointer-events:none', 'z-index:2147483642',
      ].join(';');
      document.body.appendChild(el);

      var anim = el.animate([
        { opacity: 1, boxShadow: '0 0 0 0px rgba(56,189,248,.9)' },
        { opacity: 0.85, boxShadow: '0 0 0 ' + (r * 0.25) + 'px rgba(56,189,248,.65)', offset: 0.20 },
        { opacity: 0.5,  boxShadow: '0 0 0 ' + (r * 0.72) + 'px rgba(56,189,248,.2)', offset: 0.65 },
        { opacity: 0,    boxShadow: '0 0 0 ' + r + 'px rgba(56,189,248,0)' }
      ], {
        duration: cfg.duration,
        easing: 'ease-out',
        fill: 'forwards'
      });

      anim.finished.then(function () {
        el.remove();
      }).catch(function () {
        el.remove();
      });
    });
  }

  function animate(rect) {
    ({ pulse: animatePulse, spotlight: animateSpotlight, ring: animateRing }
      [settings.effect] || animatePulse)(rect);
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
        var parent = node.parentElement;
        if (!parent || SKIP_TAGS[parent.tagName]) {
          return NodeFilter.FILTER_REJECT;
        }
        var style = window.getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden') {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
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
      { value: 'pulse',     label: 'Pulse'     },
      { value: 'spotlight', label: 'Spotlight' },
      { value: 'ring',      label: 'Ring'      },
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

  document.addEventListener('keydown', keydownHandler, true);
  injectHighlightStyles();
  buildUI();

})();
