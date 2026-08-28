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
      magnifier: false,
      motionSensitivity: 'full',
      colorPalette: 'default',
      borderStyle: 'none',
      customColors: {
        matchColor: '#fef08a',
        activeColor: '#f59e0b',
        beaconColor: '#fbbf24'
      }
    },
    setupWizardCompleted: false,
    // Written by background.js, never read here. It has to round-trip through this list
    // anyway: saveSettings() writes the whole settings object, so a key missing from
    // SETTINGS_KEYS would be dropped from storage on the next write and the default
    // blocklist would re-seed itself on every extension update.
    seededDefaultBlocklist: false
  };

  var SETTINGS_KEYS = [
    'effect', 'position', 'theme', 'matchColor', 'activeColor', 'beaconColor',
    'scrollBehavior', 'disabledSites', 'performanceMode',
    'visionProfile', 'visionSettings', 'setupWizardCompleted',
    'seededDefaultBlocklist'
  ];

  // Every write we make echoes back through chrome.storage.onChanged in this same tab.
  // Recording each payload lets the listener recognise its own echo and ignore it. Value
  // comparison alone is not enough: two colour picks in one tick queue two writes, and by
  // the time the first echo lands memory already holds the second value, so the echo
  // looks like a foreign change and tears the panel down mid-interaction.
  var pendingSelfWrites = [];

  function saveSettings() {
    pendingSelfWrites.push(stableStringify(settings));
    // Purely a leak guard. An echo that never arrives would otherwise pin an entry here
    // forever; nobody queues twenty writes ahead of the first echo in practice.
    if (pendingSelfWrites.length > 20) pendingSelfWrites.shift();
    chrome.storage.sync.set({ 'oc-settings': settings });
  }

  // chrome.storage hands objects back with their keys sorted alphabetically, while the
  // in-memory copy keeps insertion order, so a plain JSON.stringify compare reports a
  // difference between two identical values. Sort keys at every level before comparing.
  // Arrays keep their order — for disabledSites a reorder is not a meaningful change,
  // and treating one as a change is harmless anyway.
  function stableStringify(value) {
    return JSON.stringify(value, function (k, v) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        return Object.keys(v).sort().reduce(function (acc, key) {
          acc[key] = v[key];
          return acc;
        }, {});
      }
      return v;
    });
  }

  // ── Working list (session-scoped, separate from settings) ──────────────────────
  //
  // A tab-local list of search terms, kept in chrome.storage.session under its own key.
  // Deliberately not folded into 'oc-settings' / SETTINGS_KEYS / pendingSelfWrites — that
  // machinery exists to survive its own storage.onChanged echoes for a synced, persisted
  // object, which this session-only, per-tab list has no need of.
  //
  // chrome.storage.session is only readable here if background.js's service-worker
  // startup call to setAccessLevel('TRUSTED_AND_UNTRUSTED_CONTEXTS') succeeded. On an
  // older Chrome without that API, or if the call failed or hasn't run yet,
  // chrome.storage.session may be undefined in this content script — every access below
  // is guarded for that, and a failed or unavailable read silently degrades to the
  // default rather than surfacing an error, since a missing working list just means
  // today's single-term behaviour.
  var WORK_LIST_KEY = 'oc-worklist';

  function defaultWorkList() {
    return { terms: [], activeIndex: -1 };
  }

  // terms is trusted to be an array of strings and activeIndex is range-checked against
  // it — a stored index that is NaN, negative (other than the -1 sentinel), or >= the
  // term count would otherwise round-trip unchecked into UI state that indexes terms[].
  function normalizeWorkList(stored) {
    var terms = Array.isArray(stored && stored.terms) ? stored.terms : [];
    var idx = (stored && typeof stored.activeIndex === 'number' && !isNaN(stored.activeIndex))
      ? stored.activeIndex
      : -1;
    if (idx !== -1 && (idx < 0 || idx >= terms.length)) idx = -1;
    return { terms: terms, activeIndex: idx };
  }

  function loadWorkList(callback) {
    var storageAvailable;
    try {
      storageAvailable = !!(chrome.storage && chrome.storage.session);
    } catch (err) {
      storageAvailable = false;
    }
    // Deliberately outside the try/catch below: this is the synchronous path, and if the
    // caller's own callback throws here, a surrounding catch would treat that as "our"
    // failure and invoke callback() a second time with the default. Let it throw once.
    if (!storageAvailable) {
      callback(defaultWorkList());
      return;
    }
    try {
      chrome.storage.session.get(WORK_LIST_KEY, function (data) {
        if (chrome.runtime.lastError || !data || !data[WORK_LIST_KEY]) {
          callback(defaultWorkList());
          return;
        }
        callback(normalizeWorkList(data[WORK_LIST_KEY]));
      });
    } catch (err) {
      callback(defaultWorkList());
    }
  }

  function saveWorkList(list) {
    try {
      if (!chrome.storage || !chrome.storage.session) return;
      var payload = {
        terms: Array.isArray(list && list.terms) ? list.terms : [],
        activeIndex: typeof (list && list.activeIndex) === 'number' ? list.activeIndex : -1
      };
      var setObj = {};
      setObj[WORK_LIST_KEY] = payload;
      var setResult = chrome.storage.session.set(setObj, function () {
        // Read lastError so a rejected/unavailable write doesn't surface as an unchecked
        // runtime error; this is invisible plumbing and must fail silently.
        void chrome.runtime.lastError;
      });
      if (setResult && typeof setResult.catch === 'function') {
        setResult.catch(function () {});
      }
    } catch (err) {
      // fail silently — a browser without session storage access must not throw here.
    }
  }

  // window.__ocTest is this content script's single sanctioned test-only surface,
  // exposed the same way window.__ocToggle / window.__ocDestroy already are for real
  // production reasons: content scripts run in an isolated JS world, so nothing outside
  // this IIFE (including a test harness) can reach closures like loadWorkList/saveWorkList
  // directly. Attaching them to window makes them reachable from a CDP Runtime.evaluate
  // call scoped to this extension's isolated execution context — invisible to the host
  // page's own main world, so this is not a security surface, just plumbing that only a
  // real browser + CDP test harness can use. Testing through chrome.storage directly
  // instead would exercise Chrome's storage API, not this code's own logic on top of it.
  // No UI calls these yet; that lands in later beads, from inside this closure directly
  // rather than through window. Every member is assigned here or further down next to the
  // closure it exposes — extend this one namespace for new test hooks rather than adding
  // another top-level window.__oc* global.
  window.__ocTest = {};
  window.__ocTest.loadWorkList = loadWorkList;
  window.__ocTest.saveWorkList = saveWorkList;

  // Same test-reachability reasoning as the two above, for a plain closure variable
  // rather than a function: debounceTimer (declared further down, in the "State"
  // section) drives the input debounce. oculist-bxm's regression test reads it to assert
  // that, on the empty-input path, the pending debounce is actually cancelled
  // (debounceTimer === null) rather than merely inferred from timing — the only
  // hook-free alternative is a negative "the debounce never fired" assertion, which
  // would need a fixed sleep this suite forbids. The chip-removal-syncs-the-draft case
  // is asserted on the DOM instead (count text and the oculist-match highlight
  // registry), so it needs no matching lastTerm hook.
  window.__ocTest.getDebounceTimer = function () { return debounceTimer; };

  // ── Saved lists (named, persisted across devices) ──────────────────────────────
  //
  // Distinct from the working list above: a saved list is a named, user-curated term set
  // that persists across devices via chrome.storage.sync, independent of any one tab's
  // working list. Deleting a saved list never touches the working list, and vice versa —
  // loading a saved list into the working list (a later bead) copies its terms in, it
  // does not link the two by id.
  //
  // Storage shape: one chrome.storage.sync key per list ('oc-list-<id>'), holding
  // { id, name, terms }, rather than a single array under one key. Two independent
  // reasons: chrome.storage.sync caps a single item at 8192 bytes (QUOTA_BYTES_PER_ITEM),
  // which an array of many realistic-sized lists could exceed long before the 50-list cap
  // below is even hit; and per-key writes mean saving from two devices at once each writes
  // its own key, instead of racing to read-modify-write one shared array and silently
  // losing whichever write lands second.
  var LIST_KEY_PREFIX = 'oc-list-';
  var MAX_SAVED_LISTS = 50;
  var MAX_LIST_TERMS = 10;
  var MAX_LIST_TERM_LENGTH = 100;

  function listStorageKey(id) {
    return LIST_KEY_PREFIX + id;
  }

  // Defensive sanitizer for terms handed to saveList()/renameList(): drops non-strings and
  // whitespace-only entries, clips any term over MAX_LIST_TERM_LENGTH characters, and stops
  // once MAX_LIST_TERMS is reached. The working list's own addChipTerm() already enforces
  // both caps before a term ever reaches a chip, so in practice this is a backstop, not the
  // primary enforcement point — saveList() takes a plain terms array as its argument, with
  // no guarantee its caller went through addChipTerm.
  function sanitizeListTerms(terms) {
    var arr = Array.isArray(terms) ? terms : [];
    var out = [];
    for (var i = 0; i < arr.length && out.length < MAX_LIST_TERMS; i++) {
      var t = typeof arr[i] === 'string' ? arr[i].trim() : '';
      if (t === '') continue;
      if (t.length > MAX_LIST_TERM_LENGTH) t = t.slice(0, MAX_LIST_TERM_LENGTH);
      out.push(t);
    }
    return out;
  }

  // Generates an id guaranteed not to collide with any id already present under the
  // oc-list- prefix. existingIds is supplied by the caller (saveList already has to read
  // every oc-list-* key to enforce the 50-list cap, so this avoids a second async round
  // trip just to check for collisions).
  function generateListId(existingIds) {
    var ids = Array.isArray(existingIds) ? existingIds : [];
    var id;
    var attempts = 0;
    do {
      id = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      attempts++;
    } while (ids.indexOf(id) !== -1 && attempts < 1000);
    return id;
  }

  // Reads every oc-list-* key and returns every IDENTIFIABLE entry — one with a usable
  // id (a non-empty string) and a usable name (a string) — as { id, name, terms }, even
  // if its terms are malformed. An entry that isn't even identifiable (not an object, no
  // usable id, no usable name — e.g. a bare string value or a numeric id) can't be
  // rendered meaningfully and is skipped entirely, same as before.
  //
  // terms is run through sanitizeListTerms() (oculist-l6m.35's read-time transform, kept
  // unchanged for well-formed array terms) — and, per oculist-dzi, that call is now made
  // unconditionally rather than gated behind an Array.isArray(entry.terms) check.
  // sanitizeListTerms() already treats anything that isn't an array as zero terms, so an
  // identifiable entry with malformed terms (terms: 'nope', terms: null, terms missing,
  // terms: {}) comes back as { id, name, terms: [] } instead of being dropped — the same
  // shape buildListItem() already renders as a disabled, badged-0-terms row for a
  // legitimately empty list (oculist-l6m.35's empty-list gate), so a malformed-but-
  // identifiable list becomes visible and deletable/renameable for free, without a new UI
  // branch. This is a read-time transform only; the stored value itself is never
  // rewritten here.
  function listSavedLists(callback) {
    try {
      chrome.storage.sync.get(null, function (data) {
        if (chrome.runtime.lastError || !data) {
          callback([]);
          return;
        }
        var out = [];
        Object.keys(data).forEach(function (key) {
          if (key.indexOf(LIST_KEY_PREFIX) !== 0) return;
          var entry = data[key];
          if (!entry || typeof entry !== 'object') return;
          if (typeof entry.id !== 'string' || entry.id === '') return;
          if (typeof entry.name !== 'string') return;
          out.push({
            id: entry.id,
            name: entry.name,
            terms: sanitizeListTerms(entry.terms)
          });
        });
        callback(out);
      });
    } catch (err) {
      callback([]);
    }
  }

  // Reads every oc-list-* key once and hands the caller both the current count (for the
  // 50-list cap) and the id list (for generateListId's collision check) — shared by
  // saveList so it never has to make two separate chrome.storage.sync.get(null) calls.
  //
  // oculist-dzi: only IDENTIFIABLE entries (same object/id/name shape guard as
  // listSavedLists() above — terms shape is irrelevant here) count toward the cap. An
  // entry listSavedLists() will never be able to render (not an object, no usable id, no
  // usable name) stops silently occupying one of the 50 slots. An identifiable entry
  // with malformed terms still counts — it's now visible and deletable in the panel, so
  // the count is honest and the user has a way to reclaim the slot themselves.
  //
  // ids collection is gated separately from count/name: any entry with a usable
  // (non-empty string) id contributes to generateListId()'s collision check, even one
  // whose name is malformed and so doesn't count toward the cap or render anywhere —
  // an unrenderable entry's id can still collide with a freshly generated one, and
  // there's no reason to give up that check just because the entry can't be displayed.
  function readListIndex(callback) {
    try {
      chrome.storage.sync.get(null, function (data) {
        if (chrome.runtime.lastError || !data) {
          callback({ count: 0, ids: [] });
          return;
        }
        var count = 0;
        var ids = [];
        Object.keys(data).forEach(function (key) {
          if (key.indexOf(LIST_KEY_PREFIX) !== 0) return;
          var entry = data[key];
          if (!entry || typeof entry !== 'object') return;
          if (typeof entry.id !== 'string' || entry.id === '') return;
          ids.push(entry.id);
          if (typeof entry.name !== 'string') return;
          count++;
        });
        callback({ count: count, ids: ids });
      });
    } catch (err) {
      callback({ count: 0, ids: [] });
    }
  }

  // name is trimmed; an empty or whitespace-only name is rejected silently (no
  // showNotice), matching addChipTerm()'s existing whitespace-only rejection further
  // below in this file. terms is sanitized via sanitizeListTerms() rather than rejected
  // outright — a saved list is normally built from whatever is in the working list at
  // save time, which has already been through addChipTerm()'s own caps, so this only
  // trims a caller that skipped that path. If sanitizing leaves zero terms, though, the
  // save is rejected outright (oculist-l6m.26): a 0-term saved list is useless to create
  // and dangerous to load (loadSavedList() has no confirmation, so loading one wipes the
  // working list with no way back). The UI's own backstop is the primary guard — the
  // "Save current as…" button is disabled whenever the working list is empty, exactly
  // the same disabled-control treatment 'empty-name' already gets below — so this check
  // is a silent, storage-layer belt-and-suspenders for a caller that skips the UI, not a
  // path a user can hit through it.
  //
  // callback (optional) receives { ok: true, list } on success, or
  // { ok: false, reason } on failure ('empty-name', 'empty-terms', 'cap', 'write-failed',
  // 'exception'). The two user-facing failure reasons ('cap', 'write-failed') also
  // surface through showNotice(); 'empty-name' and 'empty-terms' do not, by design —
  // both are already unreachable through the popover's own disabled-button guards.
  function saveList(name, terms, callback) {
    var trimmedName = (name || '').trim();
    if (trimmedName === '') {
      if (typeof callback === 'function') callback({ ok: false, reason: 'empty-name' });
      return;
    }
    var cleanTerms = sanitizeListTerms(terms);
    if (cleanTerms.length === 0) {
      if (typeof callback === 'function') callback({ ok: false, reason: 'empty-terms' });
      return;
    }
    try {
      readListIndex(function (index) {
        if (index.count >= MAX_SAVED_LISTS) {
          showNotice("You've saved 50 lists, the maximum. Delete one to save a new list.", 'list-cap');
          if (typeof callback === 'function') callback({ ok: false, reason: 'cap' });
          return;
        }
        // The cap check above and the chrome.storage.sync.set() write below are two
        // separate round trips, so there is a time-of-check/time-of-use gap between them:
        // two devices can each call readListIndex(), each see index.count at 49, each pass
        // this check, and each go on to write a 50th (and, between them, 51st) list. There
        // is no fix for this within the chrome.storage API — it has no compare-and-swap or
        // transaction primitive, so nothing short of an external lock (which chrome.storage
        // doesn't offer) could make this check-then-write atomic across devices. In
        // practice this means MAX_SAVED_LISTS is a soft cap that concurrent multi-device
        // saves can push slightly past, not a hard invariant that's enforced everywhere;
        // the UI should not assume the count can never exceed 50.
        var id = generateListId(index.ids);
        var list = { id: id, name: trimmedName, terms: cleanTerms };
        var setObj = {};
        setObj[listStorageKey(id)] = list;
        chrome.storage.sync.set(setObj, function () {
          if (chrome.runtime.lastError) {
            showNotice("Couldn't save this list. Chrome's sync storage is full; delete a saved list and try again.", 'list-write-failed');
            if (typeof callback === 'function') callback({ ok: false, reason: 'write-failed' });
            return;
          }
          if (typeof callback === 'function') callback({ ok: true, list: list });
        });
      });
    } catch (err) {
      if (typeof callback === 'function') callback({ ok: false, reason: 'exception' });
    }
  }

  // Renaming preserves id unconditionally, and preserves terms verbatim — well-formed or
  // not — untouched (oculist-qc8). A rename changes only the name; it must not be the
  // operation that silently discards a malformed terms value, especially now that
  // oculist-dzi made such entries visible and renameable. Every consumer of a stored list
  // entry already normalises on read (normalizeWorkList()/loadWorkList() above,
  // listSavedLists()'s unconditional sanitizeListTerms() call below), so a non-array terms
  // value sitting in storage can never reach code that assumes an array. Otherwise only
  // name changes. Rejects an empty or
  // whitespace-only name the same way saveList() does — silently, no showNotice. A rename
  // targeting an id with no matching key (already deleted, e.g. from another device)
  // reports { ok: false, reason: 'not-found' } without writing anything or showing a
  // notice; that's a stale-UI condition for the list-menu UI to handle, not a storage
  // failure.
  function renameList(id, name, callback) {
    var trimmedName = (name || '').trim();
    if (trimmedName === '') {
      if (typeof callback === 'function') callback({ ok: false, reason: 'empty-name' });
      return;
    }
    var key = listStorageKey(id);
    try {
      chrome.storage.sync.get(key, function (data) {
        if (chrome.runtime.lastError || !data || !data[key]) {
          if (typeof callback === 'function') callback({ ok: false, reason: 'not-found' });
          return;
        }
        var existing = data[key];
        var updated = {
          id: id,
          name: trimmedName,
          terms: existing.terms
        };
        var setObj = {};
        setObj[key] = updated;
        chrome.storage.sync.set(setObj, function () {
          if (chrome.runtime.lastError) {
            showNotice("Couldn't rename this list. Try again in a moment.", 'list-rename-failed');
            if (typeof callback === 'function') callback({ ok: false, reason: 'write-failed' });
            return;
          }
          if (typeof callback === 'function') callback({ ok: true, list: updated });
        });
      });
    } catch (err) {
      if (typeof callback === 'function') callback({ ok: false, reason: 'exception' });
    }
  }

  // Deleting a saved list only ever removes its own oc-list-<id> key. It never reads or
  // writes the working list ('oc-worklist') — a list currently loaded into the working
  // list is an independent copy of terms by the time it's in the working list (loading
  // copies terms in, it does not keep a live reference back to the saved list's id), so
  // there is nothing here that could leave the working list in a bad state.
  function deleteList(id, callback) {
    try {
      chrome.storage.sync.remove(listStorageKey(id), function () {
        if (chrome.runtime.lastError) {
          showNotice("Couldn't delete this list. Try again in a moment.", 'list-delete-failed');
          if (typeof callback === 'function') callback({ ok: false, reason: 'write-failed' });
          return;
        }
        if (typeof callback === 'function') callback({ ok: true });
      });
    } catch (err) {
      if (typeof callback === 'function') callback({ ok: false, reason: 'exception' });
    }
  }

  // Exposed on window.__ocTest for the same reason loadWorkList/saveWorkList are (see
  // above): content scripts run in an isolated JS world invisible to page.evaluate(), so
  // a CDP Runtime.evaluate call scoped to this extension's isolated execution context is
  // the only way a test harness can reach these as plain closures. No UI calls these yet
  // — the list-menu UI bead calls them directly from inside this closure, not through
  // window.
  window.__ocTest.listSavedLists = listSavedLists;
  window.__ocTest.saveList = saveList;
  window.__ocTest.renameList = renameList;
  window.__ocTest.deleteList = deleteList;

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

  // Chip text/sizing deliberately rides the beacon scale knob above (it is
  // the only scale hook in this file), but the beacon's 0.7-2.25 range is
  // far too wide for UI text, so clamp it to a legible band for chips.
  function getChipScale() {
    return Math.min(Math.max(getBeaconScale(), 1), 1.5);
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
    matchSingular: 'match',
    matchPlural: 'matches',
    matchCapReached: 'skipped, match limit reached',
    
    // Preference Panel Strings
    prefTitle: 'Oculist Preferences',
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
    effectPointingArrows: 'Pointing Arrows',
    effectBloom: 'Bloom',
    effectTrail: 'Trail',
    effectSpeedLines: 'Speed Lines',
    effectChronoTunnel: 'Chrono Tunnel',
    effectLightCycle: 'Light Cycle',
    effectCyberVision: 'Cyber-Vision',

    // Saved-list popover (oculist-l6m.9)
    listsBtnTitle: 'Saved Lists',
    saveListPlaceholder: 'Save current as…',
    saveListBtn: 'Save',
    noSavedLists: 'No saved lists yet.',
    loadListLabel: 'Load list',
    renameListLabel: 'Rename list',
    deleteListLabel: 'Delete list',
    confirmRenameLabel: 'Confirm rename',
    cancelRenameLabel: 'Cancel rename',
    termSingular: 'term',
    termPlural: 'terms',
    emptyListHint: 'This saved list has no terms — nothing to load.'
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
  // Singleton (not a fresh matchMedia() call per read) so a 'change' listener can be
  // attached exactly once, below — .matches is still read fresh on every
  // getActiveThemeName() call, so the OS signal stays live either way. See
  // reducedMotionQuery/prefersMoreContrastQuery further down for the same pattern.
  var colorSchemeQuery = window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

  // oculist-cvg: getActiveThemeName()'s result gets baked into a <style> textContent
  // snapshot inside injectHighlightStyles() (the dialogCss theme custom properties) —
  // unlike a live .matches read, that snapshot only updates when injectHighlightStyles()
  // runs again. Without this, an OS colour-scheme flip mid-session left the injected CSS
  // showing the old theme until some unrelated event happened to re-inject. Registered
  // once here, at module scope, so it can never stack duplicate listeners across calls to
  // any function — see __ocDestroy() for why this one is intentionally not removed there.
  if (colorSchemeQuery) {
    colorSchemeQuery.addEventListener('change', function () {
      injectHighlightStyles();
    });
  }

  // manifest.json declares no minimum_chrome_version, so the MV3 baseline (Chrome 88) is
  // below plus-lighter's Chrome 111 floor. Feature-detected once at module scope and
  // reused by animateDispersion() rather than re-checked per beacon fire.
  var OC_DISPERSION_BLEND = (window.CSS && CSS.supports && CSS.supports('mix-blend-mode', 'plus-lighter'))
    ? 'plus-lighter'
    : 'screen';

  // Last known cursor position (document.documentElement is not covered by page mousemove
  // in every case, so this listens document-wide), used by animateTrail() to know where the
  // user's hand actually is. Registered once here, at module scope, and — like
  // colorSchemeQuery above — deliberately NOT removed in __ocDestroy(): this IIFE's setup
  // runs once per page load, while __ocToggle() calls __ocDestroy() on every close and only
  // re-runs buildUI() on reopen. Removing the listener would therefore kill cursor tracking
  // permanently after the first close, leaving animateTrail() stuck on its find-bar
  // fallback for the rest of the page's life. Passive, two assignments, no work in the
  // handler; the position never leaves the page.
  var lastMouseX = null, lastMouseY = null;
  function handleMouseMove(e) {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
  }
  document.addEventListener('mousemove', handleMouseMove, { passive: true });

  function getActiveThemeName() {
    var themeName = settings.theme;
    if (themeName === 'system') {
      var isDark = colorSchemeQuery && colorSchemeQuery.matches;
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
    arrows: { label: i18n.effectPointingArrows, run: animatePointingArrows },
    dispersion: { label: i18n.effectBloom, run: animateDispersion },
    trail: { label: i18n.effectTrail, run: animateTrail },
    speedlines: { label: i18n.effectSpeedLines, run: animateSpeedLines },
    chrono: { label: i18n.effectChronoTunnel, run: animateChronoTunnel },
    lightcycle: { label: i18n.effectLightCycle, run: animateLightCycle },
    cybervision: { label: i18n.effectCyberVision, run: animateCyberVision }
  };

  // ── State ─────────────────────────────────────────────────────────────────────

  var searchRanges     = [];
  var activeIndex      = -1;
  var lastTerm         = '';
  var firstEnter       = false;
  var debounceTimer    = null;
  var activeBeacons    = 0;
  var wrap, wrapRoot, bar, input, countEl, prevBtn, nextBtn, replayBtn, gearBtn, closeBtn, settingsPanel;
  var listsBtn, listsPanel;

  // The chip row's working list. workListTerms holds the search terms in add order;
  // activeTermIndex points at the "active" chip, or -1 when none is active (including
  // whenever workListTerms is empty). termRanges is parallel to workListTerms — each
  // entry is the array of visible Ranges performListSearch() found for that term, and
  // its .length is what renderChipRow() shows in each chip's .oc-chip-count slot. It can
  // be out of sync with workListTerms between a chip add/remove and the next scan; a
  // missing entry (undefined) renders as a blank count rather than "0". termStarved is
  // also parallel to workListTerms (oculist-l6m.21): a term left undefined in termRanges
  // because performListSearch() never got to scan it yet (no cap involved) and a term
  // left undefined because the TOTAL_MATCH_CAP was hit before its turn are otherwise
  // indistinguishable — termStarved[i] === true marks the latter so renderChipRow() can
  // render it distinctly instead of as a plain blank.
  var workListTerms    = [];
  var activeTermIndex  = -1;
  var termRanges       = [];
  var termStarved      = [];
  var chipRow          = null;
  var activeScrollTimeout      = null;
  var activeScrollEndHandler   = null;
  var activeScrollDebounceHandler = null;
  var domObserver           = null;
  var domObserverTimer      = null;
  var noticeEl              = null;
  // Per-notice-class dismissal (oculist-l6m.12): keyed by the notice-key each
  // showNotice() call passes, so dismissing one notice class (e.g. 'site-override')
  // never silences an unrelated one (e.g. 'term-cap'). An unrecognized/missing key
  // falls back to a single shared 'default' bucket — never unsuppressable, never
  // permanently suppressed on its own — rather than either extreme silently.
  var dismissedNotices      = new Set();
  var overlayResizeTimer    = null;

  // Sites known to render page text outside the accessible DOM (canvas, custom
  // virtualized editors) where Oculist's text-node search can't find anything.
  var KNOWN_OVERRIDE_DOMAINS = [
    'docs.google.com', 'sheets.google.com', 'slides.google.com', 'notion.so', 'www.notion.so'
  ];

  // ── Destroy ───────────────────────────────────────────────────────────────────

  // oculist-cvg: colorSchemeQuery's and prefersMoreContrastQuery's 'change' listeners
  // (registered once, at module scope, near each singleton's declaration) are
  // intentionally NOT torn down here, matching chrome.storage.onChanged.addListener
  // below (also registered once and never removed). Both call injectHighlightStyles(),
  // which already tolerates a torn-down overlay: it looks up '#oc-global-highlight-styles'
  // by id (recreating it if destroy() removed it — inert, since destroy() also cleared the
  // CSS.highlights registry, so no element is actually painted by it) and only touches
  // wrapRoot inside its own `if (wrapRoot)` guard, which destroy() has already nulled. So a
  // flip arriving after destroy() is a harmless no-op, not a leak or a throw, and removing
  // the listeners here would just re-add them on the next boot() of a fresh script
  // instance for no benefit.
  window.__ocDestroy = function () {
    clearViewportMarkers();
    if (viewportMarkersTimer) {
      clearTimeout(viewportMarkersTimer);
      viewportMarkersTimer = null;
    }
    if (overlayResizeTimer) {
      clearTimeout(overlayResizeTimer);
      overlayResizeTimer = null;
    }
    try {
      window.removeEventListener('resize', handleResize, { passive: true });
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
        CSS.highlights.delete('oculist-dim-match');
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
    listsBtn = listsPanel = null;
    lastTerm = ''; activeIndex = -1; searchRanges = []; firstEnter = false; dismissedNotices.clear();
    chipRow = null; workListTerms = []; activeTermIndex = -1; termRanges = []; termStarved = [];
  };

  // ── Beacons ───────────────────────────────────────────────────────────────────

  function cancelBeacons() {
    var beacons = document.querySelectorAll('.oc-beacon');
    for (var i = 0; i < beacons.length; i++) {
      if (beacons[i].__rafId) cancelAnimationFrame(beacons[i].__rafId);
      // WAAPI animations do NOT stop on their own when their target is detached from the
      // document — verified empirically: playState stays 'running' and currentTime keeps
      // advancing on a removed element unless .cancel() is called explicitly. Canvas
      // effects hang their rAF id off __rafId above; DOM/WAAPI effects (Light Cycle,
      // Cyber-Vision) hang their live Animation objects off __waapiAnims instead, so a
      // beacon cancelled mid-flight actually stops animating, not just leaves the DOM.
      if (beacons[i].__waapiAnims) {
        for (var j = 0; j < beacons[i].__waapiAnims.length; j++) {
          try { beacons[i].__waapiAnims[j].cancel(); } catch (e) {}
        }
      }
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
      'box-sizing:content-box',
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
    var arrowSize = Math.max(30, 36 * scale);
    leftArrow.style.cssText = [
      'position:absolute',
      'left:' + (x - 51 * scale) + 'px',
      'top:' + (y + h/2 - arrowSize/2) + 'px',
      'width:' + (45 * scale) + 'px', 'height:' + arrowSize + 'px',
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
      'width:' + (45 * scale) + 'px', 'height:' + arrowSize + 'px',
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
        'box-sizing:content-box',
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

  // Dispersion Bloom: reproduces the look of shader-driven radial chromatic dispersion
  // (UV distortion -> channel offset -> radial attenuation -> additive recombination) as
  // DOM + WAAPI, with hues derived from the active palette instead of a true RGB spectrum.
  // A real rainbow split conveys information via hue, which is exactly what tritanopia/
  // deuteranopia/protanopia users cannot separate — the whole point of Oculist's vision
  // profiles is to prevent that, so this stays palette-derived, never a hardcoded
  // spectrum. Single expanding pulse only (no repeat/loop) to stay clear of WCAG 2.3.1.
  function animateDispersion(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;

    var cx = rect.left + rect.width / 2 + window.scrollX;
    var cy = rect.top + rect.height / 2 + window.scrollY;
    var color = getEffectiveColors().beacon || '#fbbf24';
    var _dhsl = hexToHsl(color);
    var _dh = _dhsl[0], _ds = _dhsl[1], _dl = _dhsl[2];
    // Palette-derived hue offsets standing in for a shader's RGB channel split — same
    // idiom animateFlame uses at hexToHsl/hslToHex above, just with a symmetric spread.
    var hueOffsets = [-22, 0, 22];
    var endScales = [18, 21, 24.5];
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
      'overflow:visible',
      // Additive recombination confined to the rings themselves: isolate creates a new
      // stacking context so plus-lighter/screen blends the rings against each other only,
      // never bleeding into the host page (which would make the bloom vanish on white).
      'isolation:isolate'
    ].join(';');
    container.style.transform = 'scale(' + scale + ')';
    container.style.transformOrigin = offsetX + 'px ' + offsetY + 'px';

    // Three concentric, hue-offset rings (channel offsetting). A slightly different end
    // scale per ring plus a small stagger IS the dispersion — the rings recombine bright at
    // the core and split into iridescent bands toward the fringe.
    var ringCount = settings.performanceMode ? 1 : 3;
    // Centre the subset of offsets/scales on the ring count instead of indexing hueOffsets
    // by r directly: with ringCount 1 that picks the unshifted (0-offset) hue rather than
    // the -22 entry, and it caps the loop bound to the slice length so a future ringCount
    // can't index past the array and emit undefined/NaN colours.
    // Clamp at 0: ringCount > hueOffsets.length would otherwise centre to a negative
    // start, and Array#slice with a negative index counts back from the end instead of
    // clamping to 0, silently under-rendering rings instead of erroring. ringCount is only
    // ever 1 or 3 today (both safe without the clamp) — this guards a future ringCount.
    var ringStart = Math.max(0, Math.floor((hueOffsets.length - ringCount) / 2));
    var ringHueOffsets = hueOffsets.slice(ringStart, ringStart + ringCount);
    var ringEndScales = endScales.slice(ringStart, ringStart + ringCount);
    for (var r = 0; r < ringHueOffsets.length; r++) {
      var ringColor = hslToHex(_dh + ringHueOffsets[r], _ds, _dl);
      var endScale = ringEndScales[r];

      var ring = document.createElement('div');
      ring.className = 'oc-dispersion-ring';
      ring.setAttribute('data-oc-hue-offset', String(ringHueOffsets[r]));
      ring.style.cssText = [
        'position:absolute',
        'left:' + (offsetX - 5) + 'px', 'top:' + (offsetY - 5) + 'px',
        'width:10px', 'height:10px',
        'box-sizing:content-box',
        'border:2px solid ' + ringColor,
        'border-radius:50%',
        'box-shadow:0 0 10px ' + ringColor + ', inset 0 0 8px ' + ringColor,
        'mix-blend-mode:' + OC_DISPERSION_BLEND,
        'opacity:0', 'filter:blur(0px)', 'pointer-events:none'
      ].join(';');
      container.appendChild(ring);

      ring.animate([
        { transform: 'scale(0.5)', opacity: 0, filter: 'blur(0px)' },
        { transform: 'scale(1)', opacity: 1, filter: 'blur(0px)', offset: 0.1 },
        { transform: 'scale(' + endScale + ')', opacity: 0, filter: 'blur(6px)' }
      ], {
        duration: getBeaconDuration(2100),
        delay: r * getBeaconDuration(110),
        easing: 'cubic-bezier(0.1, 0.8, 0.15, 1)',
        fill: 'forwards'
      });
    }

    // Append to live DOM tree exactly once at the end to prevent layout reflow invalidations
    document.documentElement.appendChild(container);

    setTimeout(function() {
      container.remove();
    }, getBeaconDuration(2900));
  }

  // A single arrowhead travels an L-shaped (one right-angle elbow) path from the user's
  // last known cursor position to the match, via CSS motion path — offset-rotate:auto turns
  // the glyph to face travel direction and pivots it at the elbow for free, which is the
  // whole reason this uses offset-path instead of hand-rolled translate/rotate keyframes.
  function animateTrail(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;

    var endX = rect.left + rect.width / 2 + window.scrollX;
    var endY = rect.top + rect.height / 2 + window.scrollY;

    // Cursor position is tracked document-wide (see lastMouseX/lastMouseY, module scope),
    // but find-in-page is keyboard-driven — a user who typed Ctrl+F and hit Enter without
    // ever moving the mouse leaves those null. Fall back to the find bar itself (where the
    // user's attention actually is), then viewport centre. Never draw from 0,0.
    var startX, startY;
    if (lastMouseX !== null && lastMouseY !== null) {
      startX = lastMouseX + window.scrollX;
      startY = lastMouseY + window.scrollY;
    } else if (wrap) {
      var wrapRect = wrap.getBoundingClientRect();
      startX = wrapRect.left + wrapRect.width / 2 + window.scrollX;
      startY = wrapRect.top + wrapRect.height / 2 + window.scrollY;
    } else {
      startX = window.innerWidth / 2 + window.scrollX;
      startY = window.innerHeight / 2 + window.scrollY;
    }

    // Horizontal first, then vertical elbow: M startX startY L endX startY L endX endY,
    // expressed relative to the arrow's own mounted position (0 0 == startX,startY).
    var dx = endX - startX;
    var dy = endY - startY;

    var color = getEffectiveColors().beacon || '#fbbf24';
    var scale = getBeaconScale();
    var duration = getBeaconDuration(700);
    var arrowSize = Math.max(20, 26 * scale);

    // Trailing line (skipped in Lite Mode): a draw-on SVG path tracing the same L-shape,
    // same idiom animateLightning uses (getTotalLength + stroke-dasharray/dashoffset).
    if (!settings.performanceMode) {
      var lineLeft = Math.min(startX, endX);
      var lineTop = Math.min(startY, endY);
      var lineWidth = Math.max(Math.abs(dx), 1);
      var lineHeight = Math.max(Math.abs(dy), 1);

      var lineSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      lineSvg.setAttribute('class', 'oc-beacon');
      lineSvg.style.cssText = [
        'position:absolute',
        'left:' + lineLeft + 'px', 'top:' + lineTop + 'px',
        'width:' + lineWidth + 'px', 'height:' + lineHeight + 'px',
        'overflow:visible', 'pointer-events:none',
        'z-index:2147483641'
      ].join(';');

      var relStartX = startX - lineLeft;
      var relStartY = startY - lineTop;
      var relEndX = endX - lineLeft;
      var relEndY = endY - lineTop;

      var linePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      linePath.setAttribute('d', 'M ' + relStartX + ' ' + relStartY + ' L ' + relEndX + ' ' + relStartY + ' L ' + relEndX + ' ' + relEndY);
      linePath.setAttribute('stroke', color);
      linePath.setAttribute('stroke-width', String(2 * scale));
      linePath.setAttribute('fill', 'none');
      linePath.setAttribute('stroke-linecap', 'round');
      linePath.setAttribute('stroke-linejoin', 'round');
      linePath.style.opacity = '0.7';
      lineSvg.appendChild(linePath);
      document.documentElement.appendChild(lineSvg);

      var lineLength = Math.abs(dx) + Math.abs(dy) || 1;
      try {
        lineLength = linePath.getTotalLength() || lineLength;
      } catch (e) {}
      linePath.setAttribute('stroke-dasharray', lineLength);
      linePath.setAttribute('stroke-dashoffset', lineLength);

      var lineAnim = linePath.animate([
        { strokeDashoffset: lineLength },
        { strokeDashoffset: '0' }
      ], { duration: duration, easing: 'ease-in-out', fill: 'forwards' });

      lineAnim.finished.then(function () {
        lineSvg.remove();
      }).catch(function () {
        lineSvg.remove();
      });
    }

    // Arrowhead — mounted at the start point, offset-path expressed relative to it.
    var arrow = document.createElement('div');
    arrow.className = 'oc-beacon oc-trail-arrow';
    arrow.textContent = '▶';
    arrow.style.cssText = [
      'position:absolute',
      'left:' + startX + 'px', 'top:' + startY + 'px',
      'width:' + arrowSize + 'px', 'height:' + arrowSize + 'px',
      'line-height:' + arrowSize + 'px',
      'font-size:' + arrowSize + 'px',
      'font-weight:bold',
      'color:' + color,
      'text-align:center',
      'pointer-events:none',
      'z-index:2147483642',
      'offset-path:path("M 0 0 L ' + dx + ' 0 L ' + dx + ' ' + dy + '")',
      'offset-rotate:auto'
    ].join(';');
    document.documentElement.appendChild(arrow);

    var anim = arrow.animate([
      { offsetDistance: '0%', opacity: 1 },
      { offsetDistance: '88%', opacity: 1, offset: 0.88 },
      { offsetDistance: '100%', opacity: 0 }
    ], { duration: duration, easing: 'ease-in-out', fill: 'forwards' });

    anim.finished.then(function () {
      arrow.remove();
    }).catch(function () {
      arrow.remove();
    });

    // Absorption flash — an energy-transfer payoff for the arrowhead's arrival, sized to
    // the match rect itself (not the arrow) and expanded a few px so the glow reads
    // outside the text rather than only under it. delay: duration ties its start to the
    // travel animation's own end, so it can never fire early even if this task's timing
    // constants change independently later.
    var flashPad = 6;
    var flashLeft = rect.left + window.scrollX - flashPad;
    var flashTop = rect.top + window.scrollY - flashPad;
    var flashWidth = rect.width + flashPad * 2;
    var flashHeight = rect.height + flashPad * 2;

    var flash = document.createElement('div');
    flash.className = 'oc-beacon oc-trail-flash';
    var flashCss = [
      'position:absolute',
      'left:' + flashLeft + 'px', 'top:' + flashTop + 'px',
      'width:' + flashWidth + 'px', 'height:' + flashHeight + 'px',
      'border-radius:4px',
      'background:' + color,
      'pointer-events:none',
      'z-index:2147483642',
      'opacity:0'
    ];
    if (settings.performanceMode) {
      // Lite Mode: the flash itself stays (it's the payoff), but the blurred glow — the
      // expensive part — is dropped for a flat fill, the same box-shadow degrade other
      // beacon effects use to keep Lite Mode cheap.
    } else {
      flashCss.push('box-shadow:0 0 ' + (18 * scale) + 'px ' + color + ', 0 0 ' + (6 * scale) + 'px ' + color);
    }
    flash.style.cssText = flashCss.join(';');
    document.documentElement.appendChild(flash);

    var flashDuration = getBeaconDuration(450);
    var flashAnim = flash.animate([
      { opacity: 0, transform: 'scale(1)' },
      { opacity: 1, transform: 'scale(1.15)', offset: 0.35 },
      { opacity: 0, transform: 'scale(1)' }
    ], { duration: flashDuration, delay: duration, easing: 'ease-out', iterations: 1 });

    flashAnim.finished.then(function () {
      flash.remove();
    }).catch(function () {
      flash.remove();
    });
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

  // Speed Lines: horizontal light streaks blasting outward from the match toward both
  // viewport edges — the anime speed-line idiom (long-exposure light trails, a motion-blur
  // taper on every streak's trailing end, hairline-through-white-hot-core brightness
  // tiers). Ported from the approved beacon-bench.html reference geometry (tiers, gradient
  // stops, outward ease, clear lane, flare) verbatim; the only real adaptations are hue
  // (derived from getEffectiveColors().beacon instead of a fixed HUE constant, same
  // hexToHsl() idiom animateDispersion already uses) and sizing (a canvas spanning the
  // current viewport width, clamped vertically against document height, instead of a small
  // fixed mockup stage).
  function animateSpeedLines(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;

    var mw = rect.width;
    var mh = rect.height;
    var vpCx = rect.left + mw / 2;                // viewport-relative match centre x
    var my = rect.top + mh / 2 + window.scrollY;   // document-coord match centre y

    var color = getEffectiveColors().beacon || '#38bdf8';
    var hue = hexToHsl(color)[0];
    var scale = getBeaconScale();

    var vw = window.innerWidth;
    var BAND = 240;   // vertical half-spread of the streak field around the match's line
    var MARGIN = 260; // distance past the viewport edge a streak fades out over

    // Container tracks the current viewport horizontally (left == scrollX, so local x ==
    // viewport-relative x, exactly like the reference geometry's stage-relative x) and is
    // clamped vertically against the page's own scroll height — the same trap
    // animateAnimeLaser guards against: an unclamped container taller than the page would
    // itself enlarge the scrollable area.
    var scrollHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    );
    var containerHeight = Math.min(BAND * 2 + mh + 60, Math.max(mh + 40, scrollHeight));
    var maxTop = Math.max(0, scrollHeight - containerHeight);
    var targetTop = Math.min(Math.max(0, my - containerHeight / 2), maxTop);
    var offsetY = my - targetTop; // match centre, local canvas y

    var container = document.createElement('div');
    container.className = 'oc-beacon';
    container.style.cssText = [
      'position:absolute',
      'left:' + window.scrollX + 'px', 'top:' + targetTop + 'px',
      'width:' + vw + 'px', 'height:' + containerHeight + 'px',
      'pointer-events:none', 'z-index:2147483640',
      'overflow:hidden'
    ].join(';');
    container.style.transform = 'scale(' + scale + ')';
    container.style.transformOrigin = vpCx + 'px ' + offsetY + 'px';
    document.documentElement.appendChild(container);

    var canvas = document.createElement('canvas');
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(vw * dpr));
    canvas.height = Math.max(1, Math.round(containerHeight * dpr));
    canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;display:block';
    container.appendChild(canvas);

    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    var W = vw, H = containerHeight;

    // The clear lane: streaks crossing the match's own text band are attenuated to ~12%
    // alpha, same as the reference — the beacon must never bury the word it points at.
    var laneTop = offsetY - mh / 2 - 3;
    var laneBot = offsetY + mh / 2 + 3;

    var reach = Math.max(vpCx, vw - vpCx) + MARGIN;

    function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

    // Lite Mode cuts the streak count hard (74 -> 20) and drops the tier-2 bloom halos
    // below; the clear lane and the flare are kept either way.
    var N = settings.performanceMode ? 20 : 74;
    var streaks = [];
    var i;
    for (i = 0; i < N; i++) {
      // density weighted toward the match's own line, thinning toward the viewport edges
      var bias = Math.pow(Math.random(), 1.7);
      var side = Math.random() < 0.5 ? -1 : 1;
      var y = offsetY + side * bias * BAND;

      var roll = Math.random();
      var tier = roll > 0.9 ? 2 : roll > 0.62 ? 1 : 0;

      streaks.push({
        y: y,
        dir: Math.random() < 0.5 ? -1 : 1,
        tier: tier,
        thick: tier === 2 ? 5 + Math.random() * 9 : tier === 1 ? 2 + Math.random() * 3 : 0.7 + Math.random() * 1.4,
        len: (tier === 2 ? 190 : tier === 1 ? 130 : 70) + Math.random() * 220,
        rate: 0.75 + Math.random() * 0.7,
        delay: Math.random() * 0.3
      });
    }

    // window.__ocTest is this content script's sanctioned test-only surface (see its
    // definition near the top of this file). lastSpeedLinesStreakCount lets the Lite Mode
    // test assert the streak-count drop directly rather than inferring it from pixel
    // coverage; speedLinesFrameCount is a per-frame tick counter that proves
    // cancelBeacons() (via container.__rafId, set below on every frame) genuinely stops the
    // rAF loop rather than merely removing the container from the DOM.
    //
    // lastSpeedLinesLaneAlphaMax/lastSpeedLinesElseAlphaMax accumulate the running maximum
    // post-attenuation alpha actually applied to lane-crossing vs. non-lane streaks, across
    // every real frame() call this beacon makes — the clear-lane test asserts on these
    // directly instead of racing a second, independent requestAnimationFrame poll against
    // this one for a chance to rasterise the canvas at a lucky instant (that race is what
    // starved the old pixel-sampling test under parallel load). speedLinesDone flips once
    // this run reaches its final frame, giving the test a deterministic completion signal
    // that isn't tied to wall-clock container removal.
    //
    // lastSpeedLinesLaneBounds pins *where* the clear lane actually is, in the same local
    // canvas-y space as everything else in this function: top/bot are the exact laneTop/
    // laneBot the attenuation check below tests against, and matchY is offsetY — the
    // match's own vertical centre. Without this, lastSpeedLinesLaneAlphaMax/ElseAlphaMax
    // alone cannot tell "the lane is dim because it sits over the word" apart from "the
    // lane is dim because it was never over anything" (an emptied or mislocated lane still
    // reports a vacuous laneMax of 0, or a real-but-misplaced max) — bundled into one object
    // instead of three flat keys since all three only ever get read together.
    window.__ocTest.lastSpeedLinesStreakCount = N;
    window.__ocTest.speedLinesFrameCount = 0;
    window.__ocTest.lastSpeedLinesLaneAlphaMax = 0;
    window.__ocTest.lastSpeedLinesElseAlphaMax = 0;
    window.__ocTest.lastSpeedLinesLaneBounds = { top: laneTop, bot: laneBot, matchY: offsetY };
    window.__ocTest.speedLinesDone = false;

    var DUR = getBeaconDuration(760);
    var startTime = performance.now();
    var animFrameId;

    function frame(now) {
      var elapsed = now - startTime;
      var t = Math.min(1, elapsed / DUR);
      window.__ocTest.speedLinesFrameCount++;

      ctx.clearRect(0, 0, W, H);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      // fast attack, long decay — the burst reads as one impulse
      var env = t < 0.12 ? t / 0.12 : Math.pow(1 - (t - 0.12) / 0.88, 1.6);

      for (var k = 0; k < streaks.length; k++) {
        var L = streaks[k];
        var p = (t - L.delay) / (1 - L.delay);
        if (p <= 0) continue;
        p = Math.min(1, p);

        var travel = easeOut(p) * reach * L.rate;
        var head = vpCx + L.dir * travel;
        var tail = head - L.dir * L.len;

        // fade a streak as it runs off its own viewport edge
        var edge = L.dir > 0 ? 1 - Math.max(0, (head - W) / MARGIN) : 1 - Math.max(0, (0 - head) / MARGIN);
        var a = env * Math.max(0, Math.min(1, edge));
        if (a <= 0.01) continue;

        // part around the word
        var inLane = L.y > laneTop - 6 && L.y < laneBot + 6;
        if (inLane) a *= 0.12;

        // See the __ocTest block above the streak loop's setup: record the post-attenuation
        // alpha this streak actually got drawn with, split by lane membership.
        if (inLane) {
          if (a > window.__ocTest.lastSpeedLinesLaneAlphaMax) window.__ocTest.lastSpeedLinesLaneAlphaMax = a;
        } else if (a > window.__ocTest.lastSpeedLinesElseAlphaMax) {
          window.__ocTest.lastSpeedLinesElseAlphaMax = a;
        }

        var x0 = Math.min(head, tail), x1 = Math.max(head, tail);
        var g = ctx.createLinearGradient(tail, 0, head, 0);
        g.addColorStop(0, 'hsla(' + hue + ',100%,55%,0)');

        if (L.tier === 2) {
          g.addColorStop(0.55, 'hsla(' + hue + ',100%,62%,' + a * 0.55 + ')');
          g.addColorStop(0.93, 'hsla(' + (hue - 6) + ',100%,88%,' + a + ')');
          g.addColorStop(1, 'rgba(255,255,255,' + a + ')');
        } else if (L.tier === 1) {
          g.addColorStop(0.6, 'hsla(' + hue + ',100%,58%,' + a * 0.5 + ')');
          g.addColorStop(1, 'hsla(' + hue + ',100%,76%,' + a * 0.95 + ')');
        } else {
          g.addColorStop(1, 'hsla(' + (hue + 8) + ',95%,52%,' + a * 0.7 + ')');
        }

        ctx.fillStyle = g;
        ctx.fillRect(x0, L.y - L.thick / 2, x1 - x0, L.thick);

        // bloom halo under the hottest streaks, dropped in Lite Mode
        if (L.tier === 2 && !settings.performanceMode) {
          ctx.fillStyle = 'hsla(' + hue + ',100%,60%,' + a * 0.16 + ')';
          ctx.fillRect(x0, L.y - L.thick * 2.2, x1 - x0, L.thick * 4.4);
        }
      }

      // flare at the source
      var fl = env * 0.9;
      if (fl > 0.01) {
        var rg = ctx.createRadialGradient(vpCx, offsetY, 0, vpCx, offsetY, Math.max(90, mw));
        rg.addColorStop(0, 'rgba(255,255,255,' + fl * 0.75 + ')');
        rg.addColorStop(0.35, 'hsla(' + hue + ',100%,70%,' + fl * 0.38 + ')');
        rg.addColorStop(1, 'hsla(' + hue + ',100%,60%,0)');
        ctx.fillStyle = rg;
        ctx.fillRect(vpCx - mw * 2 - 90, offsetY - 90, mw * 4 + 180, 180);

        // hot horizontal core through the word
        ctx.fillStyle = 'rgba(255,255,255,' + fl * 0.5 + ')';
        ctx.fillRect(rect.left - 14, offsetY - 1, mw + 28, 2);
      }

      ctx.restore();

      if (t < 1) {
        animFrameId = requestAnimationFrame(frame);
        container.__rafId = animFrameId;
      } else {
        ctx.clearRect(0, 0, W, H);
        window.__ocTest.speedLinesDone = true;
      }
    }

    animFrameId = requestAnimationFrame(frame);
    container.__rafId = animFrameId;

    setTimeout(function () {
      container.remove();
    }, DUR);
  }

  // Chrono Tunnel: a slit-scan tunnel of rotating polygons rushing outward past the
  // match on an exponential radius curve, additive-blended, each ring's radius wobbling
  // as a function of angle (the slit-scan smear — the signature of the effect, not
  // decoration). Ported from the approved beacon-bench.html reference geometry (ring
  // count, sides, radius curve, rotation, wobble, envelope) verbatim; the one deliberate
  // departure from that reference is colour. The mockup cycles the full 360-degree hue
  // spectrum; this ships a hue that rides getEffectiveColors().beacon instead (same
  // hexToHsl() idiom animateSpeedLines/animateDispersion already use), swept a bounded
  // +/-60 degrees around that base across depth and time combined, because a full-
  // spectrum cycle would ignore both the user's chosen beacon colour and
  // motionSensitivity, and would be the only effect in the registry that does. Lite Mode
  // collapses the sweep to a single hue and cuts the ring count hard — this is the
  // loudest of the four new effects, so Lite Mode has to be genuinely calm.
  function animateChronoTunnel(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;

    var mw = rect.width;
    var mh = rect.height;
    var vpCx = rect.left + mw / 2;                // viewport-relative match centre x
    var my = rect.top + mh / 2 + window.scrollY;   // document-coord match centre y

    var color = getEffectiveColors().beacon || '#38bdf8';
    var baseHue = hexToHsl(color)[0];
    var scale = getBeaconScale();

    var vw = window.innerWidth;
    var vh = window.innerHeight;

    // Container spans the viewport width and (up to) the viewport height around the
    // match, clamped vertically against the page's own scroll height — same trap
    // animateAnimeLaser and animateSpeedLines guard against: an unclamped container
    // taller than the page would itself enlarge the scrollable area.
    var scrollHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    );
    var containerHeight = Math.min(vh, Math.max(mh + 40, scrollHeight));
    var maxTop = Math.max(0, scrollHeight - containerHeight);
    var targetTop = Math.min(Math.max(0, my - containerHeight / 2), maxTop);
    var offsetY = my - targetTop; // match centre, local canvas y

    var container = document.createElement('div');
    container.className = 'oc-beacon';
    container.style.cssText = [
      'position:absolute',
      'left:' + window.scrollX + 'px', 'top:' + targetTop + 'px',
      'width:' + vw + 'px', 'height:' + containerHeight + 'px',
      'pointer-events:none', 'z-index:2147483640',
      'overflow:hidden'
    ].join(';');
    container.style.transform = 'scale(' + scale + ')';
    container.style.transformOrigin = vpCx + 'px ' + offsetY + 'px';
    document.documentElement.appendChild(container);

    var canvas = document.createElement('canvas');
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(vw * dpr));
    canvas.height = Math.max(1, Math.round(containerHeight * dpr));
    canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;display:block';
    container.appendChild(canvas);

    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    var W = vw, H = containerHeight;
    var maxR = Math.hypot(Math.max(vpCx, W - vpCx), Math.max(offsetY, H - offsetY)) + 60;

    // Lite Mode cuts the ring count hard (26 -> 8) and collapses the sweep to a single
    // hue in hueAt() below — this is the loudest of the four effects, so Lite Mode must
    // be genuinely calm rather than merely smaller.
    var RINGS = settings.performanceMode ? 8 : 26;
    var SIDES = 7;
    var SWEEP = 60; // bounded +/-60 degrees around the beacon hue; never the full spectrum

    // hue(d, t) is the single source of truth for every hue this effect renders — the
    // core glow calls it too (at d = 0, the nearest depth). Bounded by construction: raw
    // is sin(...) in [-1, 1], so the offset added to baseHue is always in [-SWEEP,
    // SWEEP], and the +360 before the final %360 keeps the modular wrap correct when
    // baseHue - SWEEP goes negative (e.g. baseHue 10 with a -60 offset must land on 310,
    // not -50). Lite Mode short-circuits to baseHue with no offset at all.
    function hueAt(d, t) {
      if (settings.performanceMode) return baseHue;
      var raw = Math.sin((d * 2 + t * 1.3) * Math.PI);
      return (baseHue + raw * SWEEP + 360) % 360;
    }

    // window.__ocTest is this content script's sanctioned test-only surface (see its
    // definition near the top of this file). lastChronoHueRun bundles baseHue, the ring
    // count Lite Mode is expected to cut, and every hue actually applied to a ring's
    // strokeStyle this run (pushed at the same point that value is used to draw, not a
    // parallel copy computed some other way) — the hue-tracking and bounded-sweep tests
    // read hueSamples directly rather than re-deriving hue themselves, so a mutation to
    // hueAt() (fixed hue, widened sweep, wrong wraparound) shows up as a real difference
    // in the recorded values. chronoFrameCount/chronoDone mirror
    // speedLinesFrameCount/speedLinesDone: a per-frame tick counter the cancellation test
    // proves stops growing after cancelBeacons(), and a deterministic completion flag the
    // other tests can wait on instead of racing this rAF loop with a second one.
    window.__ocTest.lastChronoHueRun = { baseHue: baseHue, ringCount: RINGS, hueSamples: [] };
    window.__ocTest.chronoFrameCount = 0;
    window.__ocTest.chronoDone = false;

    var DUR = getBeaconDuration(1100);
    var startTime = performance.now();
    var animFrameId;

    function frame(now) {
      var elapsed = now - startTime;
      var t = Math.min(1, elapsed / DUR);
      window.__ocTest.chronoFrameCount++;

      ctx.clearRect(0, 0, W, H);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      // ramp in over the first ~18%, hold, ramp out over the last ~28%
      var envelope = t < 0.18 ? t / 0.18 : (t > 0.72 ? 1 - (t - 0.72) / 0.28 : 1);

      for (var i = 0; i < RINGS; i++) {
        // depth runs 0..1, advanced by time so rings rush outward past the viewer
        var d = ((i / RINGS) + t * 1.35) % 1;
        var r = Math.pow(d, 2.35) * maxR;
        if (r < 4) continue;

        var hue = hueAt(d, t);
        window.__ocTest.lastChronoHueRun.hueSamples.push(hue);

        var a = envelope * (1 - d) * 0.55;
        var rot = d * 2.6 + t * 1.1;

        ctx.beginPath();
        for (var s = 0; s <= SIDES; s++) {
          var ang = rot + (s / SIDES) * Math.PI * 2;
          // slit-scan smear: radius wobbles with angle — the signature of the effect
          var rr = r * (1 + 0.14 * Math.sin(ang * 3 + t * 6));
          var px = vpCx + Math.cos(ang) * rr;
          var py = offsetY + Math.sin(ang) * rr * 0.78;
          if (s === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.strokeStyle = 'hsla(' + hue + ',100%,62%,' + a + ')';
        ctx.lineWidth = 1 + (1 - d) * 4.5;
        ctx.stroke();
      }

      // soft core glow at the match
      var coreHue = hueAt(0, t);
      var g = ctx.createRadialGradient(vpCx, offsetY, 0, vpCx, offsetY, 70);
      g.addColorStop(0, 'hsla(' + coreHue + ',100%,78%,' + envelope * 0.55 + ')');
      g.addColorStop(1, 'hsla(0,0%,0%,0)');
      ctx.fillStyle = g;
      ctx.fillRect(vpCx - 70, offsetY - 70, 140, 140);
      ctx.restore();

      if (t < 1) {
        animFrameId = requestAnimationFrame(frame);
        container.__rafId = animFrameId;
      } else {
        ctx.clearRect(0, 0, W, H);
        window.__ocTest.chronoDone = true;
      }
    }

    animFrameId = requestAnimationFrame(frame);
    container.__rafId = animFrameId;

    setTimeout(function () {
      container.remove();
    }, DUR);
  }

  // Light Cycle: a cycle head runs in toward the match on right angles only — no curves,
  // no diagonals, the whole aesthetic — leaving a solid glowing wall behind it, segment by
  // segment. On arrival the wall holds, a box outline snaps around the match, then the
  // wall de-rezzes from the tail forward (the segment drawn first fades first). Ported
  // from the approved beacon-bench.html reference geometry (the four-point right-angle
  // path, transformOrigin-anchored scaleX/scaleY growth, tail-first de-rez stagger)
  // verbatim; the departures are the ones every DOM effect in this registry makes: viewport
  // -relative geometry converted to document space, a container clamped against the page's
  // own scroll height, and every duration routed through getBeaconDuration(). This ships
  // alongside animateTrail, not in place of it (operator decision, oculist-dvt epic notes)
  // — the two do overlap visibly, both tracing an L-shaped path to the match.
  //
  // First of the two DOM/WAAPI effects in this batch (Cyber-Vision is the second) — this
  // establishes the container/__waapiAnims pattern that one follows.
  function animateLightCycle(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;

    var mw = rect.width;
    var mh = rect.height;
    var vpCx = rect.left + mw / 2;               // viewport-relative match centre x
    var vpCy = rect.top + mh / 2;                // viewport-relative match centre y
    var my = vpCy + window.scrollY;              // document-coord match centre y

    var color = getEffectiveColors().beacon || '#38bdf8';
    var scale = getBeaconScale();

    // Right-angle path in viewport space, mirroring the reference geometry: enter from
    // just off the left edge, turn once to align with the match's own column, turn again
    // to approach the match. Lite Mode collapses this to a single straight approach.
    var entryXVp = -20;
    var midYVp = Math.min(vpCy + 96, window.innerHeight - 26);
    var finalYVp = vpCy + mh / 2 + 16;
    var turnXVp = vpCx - 118;

    var fullPts = [
      { x: entryXVp, y: midYVp },
      { x: turnXVp, y: midYVp },
      { x: turnXVp, y: finalYVp },
      { x: vpCx, y: finalYVp }
    ];
    var litePts = [
      { x: entryXVp, y: finalYVp },
      { x: vpCx, y: finalYVp }
    ];
    var pts = settings.performanceMode ? litePts : fullPts;
    var numSegments = pts.length - 1;

    // Container spans the full document width — children position with document x
    // directly, the same idiom animateAnimeLaser uses — and is clamped vertically against
    // the page's own scroll height (animateAnimeLaser, content.js:840-850) so a tall
    // container cannot itself extend the page.
    var vMin = Math.min(midYVp, finalYVp) - 60;
    var vMax = Math.max(midYVp, finalYVp) + 60;
    var containerHeight = Math.max(120, vMax - vMin);
    var scrollHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    );
    var maxTop = Math.max(0, scrollHeight - containerHeight);
    var targetTop = Math.min(Math.max(0, my - containerHeight / 2), maxTop);
    var offsetY = my - targetTop; // match centre, local container y

    function localX(xVp) { return xVp + window.scrollX; }
    function localY(yVp) { return offsetY + (yVp - vpCy); }

    var container = document.createElement('div');
    container.className = 'oc-beacon';
    container.style.cssText = [
      'position:absolute',
      'left:0', 'top:' + targetTop + 'px',
      'width:100%', 'height:' + containerHeight + 'px',
      'pointer-events:none', 'z-index:2147483640',
      'overflow:visible'
    ].join(';');
    container.style.transform = 'scale(' + scale + ')';
    container.style.transformOrigin = localX(vpCx) + 'px ' + offsetY + 'px';
    document.documentElement.appendChild(container);

    var anims = [];
    var THICK = 3 * scale;

    var SEG = getBeaconDuration(300);          // per-segment run-in duration
    var BOX_HOLD = getBeaconDuration(250);      // gap between wall completion and de-rez start
    var DEREZ_TOTAL = getBeaconDuration(400);   // total de-rez window, split across segments
    var HEAD_BURN = getBeaconDuration(150);

    var runIn = SEG * numSegments;
    var derezStep = DEREZ_TOTAL / numSegments;

    // window.__ocTest is this content script's sanctioned test-only surface. Reset per run
    // (mirrors speedLinesDone/chronoDone): lightCycleWallsGrown counts real growth
    // animations that have naturally finished (via their own .finished promise, not a
    // guessed timeout), and lightCycleRunInDone flips once every segment has — a
    // deterministic completion signal the right-angle geometry test waits on before
    // reading real getBoundingClientRect() values, instead of racing a guessed delay
    // against this run's own WAAPI schedule.
    window.__ocTest.lightCycleWallsGrown = 0;
    window.__ocTest.lightCycleRunInDone = false;

    var head = document.createElement('div');
    head.className = 'oc-lightcycle-head';
    var headSize = Math.max(6, 8 * scale);
    head.style.cssText = [
      'position:absolute',
      'width:' + headSize + 'px', 'height:' + headSize + 'px',
      'margin:' + (-headSize / 2) + 'px 0 0 ' + (-headSize / 2) + 'px',
      'background:#ffffff',
      'border-radius:50%',
      'box-shadow:0 0 ' + (8 * scale) + 'px #ffffff, 0 0 ' + (18 * scale) + 'px ' + color,
      'pointer-events:none'
    ].join(';');
    container.appendChild(head);

    var walls = [];
    var elapsed = 0;
    for (var i = 0; i < numSegments; i++) {
      var a = pts[i], b = pts[i + 1];
      var horiz = a.y === b.y;
      var aX = localX(a.x), bX = localX(b.x), aY = localY(a.y), bY = localY(b.y);
      var len = horiz ? Math.abs(bX - aX) : Math.abs(bY - aY);

      var wall = document.createElement('div');
      wall.className = 'oc-lightcycle-wall';
      wall.setAttribute('data-oc-lc-index', String(i));
      wall.style.cssText = [
        'position:absolute',
        'background:' + color,
        'box-shadow:0 0 ' + (6 * scale) + 'px ' + color + ', 0 0 ' + (16 * scale) + 'px ' + color,
        'opacity:0.92',
        'pointer-events:none'
      ].join(';');
      if (horiz) {
        wall.style.left = Math.min(aX, bX) + 'px';
        wall.style.top = (aY - THICK / 2) + 'px';
        wall.style.height = THICK + 'px';
        wall.style.width = Math.max(len, 1) + 'px';
        wall.style.transformOrigin = (bX > aX ? 'left' : 'right') + ' center';
      } else {
        wall.style.left = (aX - THICK / 2) + 'px';
        wall.style.top = Math.min(aY, bY) + 'px';
        wall.style.width = THICK + 'px';
        wall.style.height = Math.max(len, 1) + 'px';
        wall.style.transformOrigin = 'center ' + (bY > aY ? 'top' : 'bottom');
      }
      container.appendChild(wall);
      walls.push(wall);

      var growthAnim = wall.animate([
        { transform: horiz ? 'scaleX(0)' : 'scaleY(0)' },
        { transform: horiz ? 'scaleX(1)' : 'scaleY(1)' }
      ], { duration: SEG, delay: elapsed, easing: 'linear', fill: 'both' });
      anims.push(growthAnim);
      growthAnim.finished.then(function () {
        window.__ocTest.lightCycleWallsGrown++;
        if (window.__ocTest.lightCycleWallsGrown >= numSegments) {
          window.__ocTest.lightCycleRunInDone = true;
        }
      }).catch(function () {});

      // The head rides this segment's boundary.
      anims.push(head.animate([
        { transform: 'translate(' + aX + 'px,' + aY + 'px)' },
        { transform: 'translate(' + bX + 'px,' + bY + 'px)' }
      ], { duration: SEG, delay: elapsed, easing: 'linear', fill: 'both' }));

      elapsed += SEG;
    }

    // Head burns out on arrival.
    anims.push(head.animate([
      { opacity: 1 }, { opacity: 0 }
    ], { duration: HEAD_BURN, delay: runIn, fill: 'forwards' }));

    // Box outline snaps around the match, expanded a few px past the raw rect so the glow
    // reads outside the text — the same idiom animateTrail's absorption flash uses.
    var boxPad = 6 * scale;
    var box = document.createElement('div');
    box.className = 'oc-lightcycle-box';
    box.style.cssText = [
      'position:absolute',
      'left:' + (localX(rect.left) - boxPad) + 'px',
      'top:' + (localY(rect.top) - boxPad) + 'px',
      'width:' + (mw + boxPad * 2) + 'px',
      'height:' + (mh + boxPad * 2) + 'px',
      'box-sizing:content-box',
      'border:' + Math.max(1, 2 * scale) + 'px solid ' + color,
      'box-shadow:0 0 ' + (10 * scale) + 'px ' + color + ', inset 0 0 ' + (8 * scale) + 'px ' + color,
      'pointer-events:none'
    ].join(';');
    container.appendChild(box);

    anims.push(box.animate([
      { opacity: 0, transform: 'scale(1.3)' },
      { opacity: 1, transform: 'scale(1)', offset: 0.18 },
      { opacity: 1, transform: 'scale(1)', offset: 0.7 },
      { opacity: 0, transform: 'scale(1.06)' }
    ], { duration: BOX_HOLD + DEREZ_TOTAL, delay: runIn, fill: 'both' }));

    // De-rez from the tail forward: each wall segment fades out in the order it was drawn
    // (tail first), not all at once. Lite Mode's single segment trivially satisfies this —
    // there is nothing left to stagger against.
    for (var k = 0; k < walls.length; k++) {
      anims.push(walls[k].animate([
        { opacity: 0.92 }, { opacity: 0 }
      ], { duration: derezStep, delay: runIn + BOX_HOLD + k * derezStep, fill: 'forwards' }));
    }

    var total = runIn + BOX_HOLD + DEREZ_TOTAL;

    // See cancelBeacons(): WAAPI animations keep running on a detached element unless
    // explicitly cancelled, so every Animation this beacon created is hung off the
    // container for cancelBeacons() to reach.
    container.__waapiAnims = anims;

    window.__ocTest.lastLightCycleRun = {
      segmentCount: numSegments,
      liteMode: !!settings.performanceMode,
      runIn: runIn,
      boxHold: BOX_HOLD,
      derezTotal: DEREZ_TOTAL,
      derezStep: derezStep
    };

    setTimeout(function () {
      container.remove();
    }, total);
  }

  // Cyber-Vision: a targeting-HUD sweep over the viewport, resolving down onto the match.
  // Ported from the approved beacon-bench.html reference geometry (the scanline/tint wash,
  // the single downward sweep bar with its hard bright leading edge, the per-column
  // staggered thermal false-colour grid, the four corner brackets snapping in from outside
  // then holding, and the readout beside them) verbatim, with the same departures every DOM
  // effect in this registry makes: viewport-relative geometry converted to document space, a
  // container clamped against the page's own scroll height, and every duration routed
  // through getBeaconDuration(). Second of the two DOM/WAAPI effects in this batch (Light
  // Cycle was the first, at content.js:2471) — reuses its container/__waapiAnims pattern.
  //
  // Scaling follows animateAnimeLaser (content.js:847), NOT Light Cycle: getBeaconScale()
  // is applied exactly once, as the container's own transform, anchored on the match centre
  // so the targeting geometry (brackets, thermal grid) grows/shrinks around the match the
  // way AnimeLaser's beam grows/shrinks around it. Every child element below therefore uses
  // a FIXED pixel size — multiplying an already-scaled container's children by scale again
  // is the double-scaling defect filed separately against Light Cycle (oculist-dvt.8).
  //
  // The four thermal heat colours are the approved mockup's fixed false-colour palette, not
  // derived from getEffectiveColors().beacon — a thermal camera's whole visual point is
  // multiple fixed hues, so recolouring the blocks to a single user beacon colour would
  // undercut the effect's own premise. Every other surface (tint, scanlines, sweep, brackets,
  // readout) rides getEffectiveColors().beacon per the shared beacon contract.
  function animateCyberVision(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;

    var mw = rect.width;
    var mh = rect.height;
    var mxDoc = rect.left + window.scrollX;   // document-coord match left
    var myDoc = rect.top + window.scrollY;    // document-coord match top
    var matchCxDoc = mxDoc + mw / 2;
    var matchCyDoc = myDoc + mh / 2;

    var color = getEffectiveColors().beacon || '#fbbf24';
    var scale = getBeaconScale();
    var lite = !!settings.performanceMode;

    // The container spans the full document width (left:0, width:100% — the same idiom
    // animateAnimeLaser and Light Cycle use) and the CURRENT viewport height, so the sweep
    // bar has a full viewport to travel — clamped vertically against the page's own scroll
    // extent exactly like animateAnimeLaser (content.js:859-866), so a viewport-tall
    // container can never itself extend the page.
    var containerHeight = window.innerHeight;
    var scrollHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    );
    var maxTop = Math.max(0, scrollHeight - containerHeight);
    var targetTop = Math.min(Math.max(0, window.scrollY), maxTop);

    function localY(yDoc) { return yDoc - targetTop; }

    var container = document.createElement('div');
    container.className = 'oc-beacon';
    container.style.cssText = [
      'position:absolute',
      'left:0', 'top:' + targetTop + 'px',
      'width:100%', 'height:' + containerHeight + 'px',
      'pointer-events:none', 'z-index:2147483640',
      'overflow:visible'
    ].join(';');
    container.style.transform = 'scale(' + scale + ')';
    container.style.transformOrigin = matchCxDoc + 'px ' + localY(matchCyDoc) + 'px';
    document.documentElement.appendChild(container);

    var anims = [];

    function add(className, cssText) {
      var el = document.createElement('div');
      if (className) el.className = className;
      el.style.cssText = cssText;
      container.appendChild(el);
      return el;
    }

    var DUR_WASH = getBeaconDuration(1000);
    var DUR_SWEEP = getBeaconDuration(620);
    var THERMAL_DUR = getBeaconDuration(760);
    var THERMAL_BASE_DELAY = getBeaconDuration(300);
    var THERMAL_COL_STEP = getBeaconDuration(14);
    var THERMAL_ROW_STEP = getBeaconDuration(20);
    var BRACKET_DELAY = getBeaconDuration(440);
    var BRACKET_DUR = getBeaconDuration(900);
    var READOUT_DELAY = getBeaconDuration(460);
    var READOUT_DUR = getBeaconDuration(900);

    var maxEnd = Math.max(DUR_WASH, DUR_SWEEP, BRACKET_DELAY + BRACKET_DUR, READOUT_DELAY + READOUT_DUR);

    // 1. Tint wash + scanline overlay, fading in and out across the whole effect. The
    // scanline overlay is dropped in Lite Mode (see the Lite Mode note on the thermal grid
    // below); the tint wash is a single, cheap div and stays.
    var tint = add('oc-cv-tint', [
      'position:absolute', 'left:0', 'top:0', 'width:100%', 'height:100%',
      'background:' + hexToRgba(color, 0.07)
    ].join(';'));
    anims.push(tint.animate(
      [{ opacity: 0 }, { opacity: 1 }, { opacity: 1 }, { opacity: 0 }],
      { duration: DUR_WASH, easing: 'linear', fill: 'both' }
    ));

    if (!lite) {
      var lines = add('oc-cv-scanlines', [
        'position:absolute', 'left:0', 'top:0', 'width:100%', 'height:100%',
        'background:repeating-linear-gradient(to bottom,' +
          hexToRgba(color, 0.10) + ' 0px,' + hexToRgba(color, 0.10) + ' 1px,' +
          'transparent 1px, transparent 4px)'
      ].join(';'));
      anims.push(lines.animate(
        [{ opacity: 0 }, { opacity: 1 }, { opacity: 1 }, { opacity: 0 }],
        { duration: DUR_WASH, easing: 'linear', fill: 'both' }
      ));
    }

    // 2. A bright bar sweeping the full viewport height once, hard bright edge (the solid
    // border) on its leading (bottom) side.
    var sweep = add('oc-cv-sweep', [
      'position:absolute', 'left:0', 'width:100%', 'height:78px',
      'box-sizing:content-box',
      'background:linear-gradient(to bottom, transparent,' + hexToRgba(color, 0.32) + ', transparent)',
      'border-bottom:2px solid ' + color
    ].join(';'));
    anims.push(sweep.animate(
      [
        { transform: 'translateY(-90px)', opacity: 1 },
        { transform: 'translateY(' + containerHeight + 'px)', opacity: 1 },
        { transform: 'translateY(' + containerHeight + 'px)', opacity: 0 }
      ],
      { duration: DUR_SWEEP, easing: 'cubic-bezier(.4,0,.5,1)', fill: 'both' }
    ));

    // 3. Thermal false-colour blocks resolving over the match, staggered in by column so
    // they resolve left to right. Dropped entirely in Lite Mode.
    if (!lite) {
      var cols = Math.max(6, Math.round(mw / 9));
      var rows = 3;
      var bw = mw / cols;
      var bh = (mh + 6) / rows;
      for (var c = 0; c < cols; c++) {
        for (var r = 0; r < rows; r++) {
          var heat = Math.random();
          var heatColor = heat > 0.72 ? '#FFE9A8' : heat > 0.45 ? '#FF7A2D' : heat > 0.22 ? '#C42B7A' : '#2C2470';
          var block = add('oc-cv-thermal', [
            'position:absolute',
            'left:' + (mxDoc + c * bw) + 'px',
            'top:' + localY(myDoc - 3 + r * bh) + 'px',
            'width:' + (bw + 0.6) + 'px',
            'height:' + (bh + 0.6) + 'px',
            'background:' + heatColor
          ].join(';'));
          block.setAttribute('data-oc-cv-col', String(c));
          var thermalDelay = THERMAL_BASE_DELAY + c * THERMAL_COL_STEP + r * THERMAL_ROW_STEP;
          anims.push(block.animate(
            [{ opacity: 0 }, { opacity: 0.85 }, { opacity: 0.85 }, { opacity: 0 }],
            { duration: THERMAL_DUR, delay: thermalDelay, fill: 'both' }
          ));
          maxEnd = Math.max(maxEnd, thermalDelay + THERMAL_DUR);
        }
      }
    }

    // 4. Targeting brackets: four corners, each a div with two borders removed, snapping
    // inward onto the match from outside, holding, then fading. Fixed pixel sizes (L, pad,
    // border width) — the container's own transform above is the only scaling applied.
    var L = 15, pad = 11;
    var corners = [
      ['border-right:0;border-bottom:0;', mxDoc - pad, localY(myDoc - pad), -22, -22],
      ['border-left:0;border-bottom:0;', mxDoc + mw + pad - L, localY(myDoc - pad), 22, -22],
      ['border-right:0;border-top:0;', mxDoc - pad, localY(myDoc + mh + pad - L), -22, 22],
      ['border-left:0;border-top:0;', mxDoc + mw + pad - L, localY(myDoc + mh + pad - L), 22, 22]
    ];
    for (var i = 0; i < corners.length; i++) {
      var cdef = corners[i];
      var bracket = add('oc-cv-bracket', [
        'position:absolute', 'box-sizing:content-box', 'border:2px solid ' + color, cdef[0],
        'left:' + cdef[1] + 'px', 'top:' + cdef[2] + 'px',
        'width:' + L + 'px', 'height:' + L + 'px'
      ].join(';'));
      anims.push(bracket.animate(
        [
          { opacity: 0, transform: 'translate(' + cdef[3] + 'px,' + cdef[4] + 'px)' },
          { opacity: 1, transform: 'translate(0,0)', offset: 0.3 },
          { opacity: 1, transform: 'translate(0,0)', offset: 0.78 },
          { opacity: 0, transform: 'translate(0,0)' }
        ],
        { duration: BRACKET_DUR, delay: BRACKET_DELAY, easing: 'cubic-bezier(.2,.9,.3,1)', fill: 'both' }
      ));
    }

    // window.__ocTest is this content script's sanctioned test-only surface. Reset per run
    // (mirrors lightCycleRunInDone). The brackets' own keyframes (above) reach translate(0,0)
    // — fully snapped in — at offset 0.3 of their delay+duration and hold there until the
    // fade-out; that offset is exact real math derived from this run's own BRACKET_DELAY/
    // BRACKET_DUR, not a guess, so a timeout keyed to it is a genuine completion signal
    // (mirrors why Light Cycle instead uses .finished — there, "done" IS the animation's
    // end; here "settled" is a mid-animation point .finished cannot express, since waiting
    // for full completion would race the container's own self-removal timeout below, which
    // fires at the same moment the brackets' fade-out actually finishes).
    window.__ocTest.cyberVisionBracketsSettled = false;
    setTimeout(function () {
      window.__ocTest.cyberVisionBracketsSettled = true;
    }, BRACKET_DELAY + BRACKET_DUR * 0.3);

    // Readout beside the brackets. Decorative HUD chrome, not content — aria-hidden so it is
    // never announced and never collides with the chip/counter accessible names, which are
    // the actual source of truth for match position. "MATCH n OF m" is real: activeIndex and
    // searchRanges describe exactly the match this beacon is firing on (animate() only ever
    // fires the registry's run(rect) for the active match), the same module state
    // drawActiveMatchLabel() and the chip counter already read (content.js:2966, :4356) — so
    // this reuses that state directly rather than duplicating any counting logic. Falls back
    // to the static line alone rather than ever printing a count it cannot vouch for.
    var countLabel = (searchRanges.length > 0 && activeIndex >= 0 && activeIndex < searchRanges.length)
      ? ('MATCH ' + (activeIndex + 1) + ' OF ' + searchRanges.length)
      : '';
    var readout = add('oc-cv-readout', [
      'position:absolute',
      'left:' + (mxDoc + mw + 26) + 'px',
      'top:' + localY(myDoc - 8) + 'px',
      'font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      'font-size:11px', 'letter-spacing:0.08em', 'line-height:1.5', 'white-space:pre',
      'color:' + color,
      'text-shadow:0 0 8px ' + hexToRgba(color, 0.8)
    ].join(';'));
    readout.textContent = countLabel ? ('TARGET ACQUIRED\n' + countLabel) : 'TARGET ACQUIRED';
    readout.setAttribute('aria-hidden', 'true');
    anims.push(readout.animate(
      [{ opacity: 0 }, { opacity: 1, offset: 0.32 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }],
      { duration: READOUT_DUR, delay: READOUT_DELAY, fill: 'both' }
    ));

    // See cancelBeacons(): WAAPI animations keep running on a detached element unless
    // explicitly cancelled, so every Animation this beacon created is hung off the
    // container for cancelBeacons() to reach.
    container.__waapiAnims = anims;

    setTimeout(function () {
      container.remove();
    }, maxEnd);
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
      'box-sizing:content-box',
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
        'box-sizing:content-box',
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
      'box-sizing:content-box',
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
      'box-sizing:content-box',
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

  // Companion overlay to drawActiveMatchLabel (oculist-l6m.39), not an effectsRegistry
  // entry: the registry's run(rect) contract only gets a rect, with no access to the
  // matched text, so this is called directly from drawActiveOverlays() instead, where it
  // composes with whichever effect happens to be selected.
  //
  // Absorbs the "N of M" counter: when it successfully draws, drawActiveOverlays() skips
  // drawActiveMatchLabel() entirely rather than stacking two boxes in the same spot above
  // the match. Returns whether it actually drew a card so the caller knows whether to fall
  // back to the plain label — magnifier off, zero matches, or a match whose text collapses
  // to nothing after whitespace trimming all decline without leaving anything behind.
  function drawActiveMatchMagnifier(rect) {
    var existing = document.getElementById('oc-active-match-magnifier');
    if (existing) existing.remove();

    if (!rect || rect.width === 0 || rect.height === 0) return false;
    if (!settings.visionSettings || !settings.visionSettings.magnifier) return false;
    if (searchRanges.length === 0 || activeIndex < 0 || activeIndex >= searchRanges.length) return false;

    var range = searchRanges[activeIndex];
    if (!range) return false;

    var rawText;
    try {
      rawText = range.toString();
    } catch (e) {
      return false;
    }

    // The real page text with its original casing, not the typed term — search is
    // case-insensitive and accent-folded, so a search for "peanut" may land on "Peanuts"
    // or "PEANUT" on the page, and showing the actual hit is the point of "magnify".
    // Collapse internal whitespace: a match can span text nodes and line breaks.
    var text = (rawText || '').replace(/\s+/g, ' ').trim();
    if (!text) return false;

    if (text.length > 24) {
      text = text.slice(0, 24) + '…';
    }

    // Size rides the match's own rendered font-size, not getBeaconScale() — that knob is
    // already wrongly reused for chip sizing (oculist-l6m.11); this must not repeat it.
    var startNode = range.startContainer;
    var matchEl = (startNode && startNode.nodeType === 3) ? startNode.parentElement : startNode;
    var baseFontSize = 16;
    if (matchEl && window.getComputedStyle) {
      try {
        var parsedSize = parseFloat(window.getComputedStyle(matchEl).fontSize);
        if (!isNaN(parsedSize) && parsedSize > 0) baseFontSize = parsedSize;
      } catch (e) {}
    }
    var fontSize = Math.min(48, Math.max(16, baseFontSize * 2.5));

    var colors = getEffectiveColors();
    var color = colors.beacon;

    // Read once, before any element exists, so the very first style ever applied to the
    // card/connector already carries the right starting opacity. The global '.oc-beacon'
    // rule (see injectHighlightStyles()) sets a CSS `transition: opacity`, which fires on
    // any LATER opacity change to an already-rendered element (e.g. offsetWidth/Height
    // below forces a layout, giving the element an observable "before" frame) — starting
    // 'off' at its final opacity:1 instead of flipping it after the fact avoids that
    // transition firing and keeps 'off' genuinely static, with zero animations.
    var motion = effectiveMotion();
    var initialOpacity = motion === 'off' ? '1' : '0';

    var card = document.createElement('div');
    card.id = 'oc-active-match-magnifier';
    card.className = 'oc-beacon';
    // The word is already page content, and oculist-l6m.16 just made chip counts
    // announced — announcing a magnified duplicate on top of that would be noise.
    card.setAttribute('aria-hidden', 'true');
    card.style.cssText = [
      'position:absolute',
      'background:#0f172a',
      'color:#ffffff',
      'border:2px solid ' + color,
      'border-radius:6px',
      'padding:8px 14px',
      'font-family:system-ui, -apple-system, sans-serif',
      'z-index:2147483645',
      'pointer-events:none',
      'white-space:nowrap',
      'text-align:center',
      'box-shadow:0 4px 10px rgba(0,0,0,0.4)',
      'opacity:' + initialOpacity
    ].join(';');

    var wordEl = document.createElement('div');
    wordEl.style.cssText = [
      'font-size:' + fontSize + 'px',
      'font-weight:700',
      'line-height:1.15'
    ].join(';');
    wordEl.textContent = text;
    card.appendChild(wordEl);

    var counterEl = document.createElement('div');
    counterEl.style.cssText = [
      'font-size:11px',
      'font-weight:600',
      'color:rgba(255,255,255,0.6)',
      'margin-top:2px'
    ].join(';');
    counterEl.textContent = 'Match #' + (activeIndex + 1) + ' of ' + searchRanges.length;
    card.appendChild(counterEl);

    // The connector to the match — a short line filling the gap between the card and the
    // match it points at, on whichever side the card ends up on once flip-below is decided
    // below.
    var GAP = 8;
    var connector = document.createElement('div');
    connector.style.cssText = [
      'position:absolute',
      'left:50%',
      'width:2px',
      'height:' + GAP + 'px',
      'background:' + color,
      'transform:translateX(-50%)',
      'opacity:' + initialOpacity
    ].join(';');
    card.appendChild(connector);

    document.documentElement.appendChild(card);

    var cw = card.offsetWidth || 120;
    var ch = card.offsetHeight || 50;

    var cx = rect.left + window.scrollX + rect.width / 2 - cw / 2;
    var maxLeft = Math.max(0, document.documentElement.scrollWidth - cw - 10);
    cx = Math.min(Math.max(10, cx), maxLeft);

    // Flip below the match instead of clamping the card on top of it when there is no
    // room above — e.g. a match near the top of the viewport.
    var placeAbove = (rect.top - ch - GAP) >= 0;
    var cy;
    if (placeAbove) {
      cy = rect.top + window.scrollY - ch - GAP;
      connector.style.top = '100%';
    } else {
      cy = rect.top + window.scrollY + rect.height + GAP;
      connector.style.top = (-GAP) + 'px';
    }

    var maxTop = Math.max(0, document.documentElement.scrollHeight - ch - 10);
    cy = Math.min(Math.max(10, cy), maxTop);

    card.style.left = cx + 'px';
    card.style.top = cy + 'px';

    if (motion === 'off') {
      // Opacity is already baked into the initial cssText above — nothing left to do.
      return true;
    }

    if (motion === 'reduced') {
      // Fades in at final size and position: no scale, no lift. This is a
      // vision-accessibility product — the magnifier does not get to be the one overlay
      // that ignores the motion settings.
      var fadeDuration = getBeaconDuration(220);
      card.animate([{ opacity: 0 }, { opacity: 1 }], { duration: fadeDuration, fill: 'forwards' });
      connector.animate([{ opacity: 0 }, { opacity: 1 }], { duration: fadeDuration, fill: 'forwards' });
      return true;
    }

    // Zoom-lift: render at the match's own position at page font size with opacity 0,
    // scale up and rise ~40px, then the connector to the match fades in last.
    card.style.transformOrigin = placeAbove ? 'bottom center' : 'top center';
    var startScale = Math.min(1, Math.max(0.2, baseFontSize / fontSize));
    var liftPx = 40;
    var liftDuration = getBeaconDuration(320);

    card.animate([
      { transform: 'translateY(' + liftPx + 'px) scale(' + startScale + ')', opacity: 0 },
      { transform: 'translateY(0px) scale(1)', opacity: 1 }
    ], { duration: liftDuration, easing: 'ease-out', fill: 'forwards' });

    var connectorDuration = getBeaconDuration(150);
    connector.animate([
      { opacity: 0 },
      { opacity: 1 }
    ], { duration: connectorDuration, delay: liftDuration, fill: 'forwards' });

    return true;
  }

  // The OS-level preference is a downgrade-only signal: it can turn 'full' into
  // 'reduced', but it never overrides an explicit 'reduced'/'off' upward. Matching
  // live (not once at load) means toggling the OS setting takes effect immediately.
  var reducedMotionQuery = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

  // oculist-cvg: unlike colorSchemeQuery/prefersMoreContrastQuery, this one intentionally
  // gets no 'change' listener. Those two get baked into a <style> textContent snapshot by
  // injectHighlightStyles() (theme custom properties / dimHighlightCss), so a flip needs
  // an explicit re-inject to be seen. Nothing injectHighlightStyles() writes depends on
  // reducedMotionQuery — motion only ever gates JS behaviour (effectiveMotion(), consulted
  // fresh on every beacon render, e.g. drawActiveOverlays()/animate() below), so an OS
  // flip is already visible on the very next beacon with zero staleness window and nothing
  // to re-inject. Re-running injectHighlightStyles() on this query's change would be a
  // byte-for-byte no-op. See prefers_reduced_motion.test.js (oculist-mg3) for the existing
  // coverage that this live read already works without any listener.
  function effectiveMotion() {
    var motion = (settings.visionSettings && settings.visionSettings.motionSensitivity) ? settings.visionSettings.motionSensitivity : 'full';
    if (motion === 'full' && reducedMotionQuery && reducedMotionQuery.matches) return 'reduced';
    return motion;
  }

  // The accessibility overlays (border, label, shape) are absolutely positioned in
  // document coordinates from a one-shot rect, so any reflow strands them. Split out
  // from animate() so a resize can redraw them in place without replaying the beacon.
  function drawActiveOverlays(rect) {
    var motion = effectiveMotion();

    // Draw accessibility overlays (border + label) if motion is not completely off
    if (motion !== 'off') {
      drawActiveMatchBorder(rect);
    }

    // The magnifier absorbs the "N of M" counter when it draws — both want the same
    // space above the match, so exactly one of them may. Falls back to the plain label
    // when the magnifier declines (off, or a match whose text collapsed to nothing).
    var magnifierDrawn = drawActiveMatchMagnifier(rect);
    if (!magnifierDrawn) {
      drawActiveMatchLabel(rect);
    }
    drawActiveMatchShape(rect);

    if (motion === 'off') {
      drawStaticActiveBorder(rect);
    }
  }

  // Resize reflows the page and moves the active match, but the overlays keep their
  // old document coordinates. Redraw them at the match's current rect. Deliberately
  // does not re-run the beacon effect: that is transient, and replaying it on every
  // resize is noise for exactly the low-vision and reduced-motion users who rely on
  // these overlays.
  function repositionActiveOverlays() {
    if (!wrap || activeIndex < 0 || activeIndex >= searchRanges.length) return;
    var range = searchRanges[activeIndex];
    if (!range) return;
    var rect;
    try {
      rect = range.getBoundingClientRect();
    } catch (e) {
      return;
    }
    if (!rect || rect.width === 0 || rect.height === 0) return;
    cancelBeacons();
    drawActiveOverlays(rect);
  }

  function animate(rect) {
    if (!wrap) return;
    cancelBeacons();

    drawActiveOverlays(rect);

    var motion = effectiveMotion();

    if (motion === 'off') {
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

  // Walks the DOM once per scan, returning the flattened/normalised page text
  // and the text-node offset maps needed to resolve match ranges. Called once
  // per scan (not once per term) so multiple terms can share the same index.
  function buildPageIndex() {
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
          // oculist-hf6: collapsed from an ad-hoc oc-beacon classList check into the
          // shared helper, so this can't silently diverge if isOculistNode() gains a
          // marker. Behaviourally identical: the helper matches more (oc-wrap,
          // oc-global-highlight-styles, oc-viewport-marker), but none of it is reachable
          // here — the element branch below already refuses to descend into any Oculist
          // node, traversal roots at document.body while markers and the style tag mount
          // outside it, and SKIP_TAGS already excludes STYLE. Dead defense, kept for the
          // day descent-blocking changes.
          if (parent && !SKIP_TAGS[parent.tagName] && !isOculistNode(parent)) {
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
          // isOculistNode(): never descend into any Oculist-owned element (bar/chip row,
          // beacons, viewport markers, ...). wrap's bar/chip row lives in wrap's shadow
          // root; chip terms render the literal searched text as button labels, so
          // without this exclusion every chip would always match its own label —
          // inflating every count by at least 1, and by more for any other chip whose
          // term happens to be a substring/superstring of it. Routed through the shared
          // helper (rather than a narrower `child !== wrap` identity check) so any future
          // Oculist node mounted under body is excluded automatically instead of
          // silently self-matching. The extra cost per element is a couple of cheap
          // string/classList comparisons on top of the classList.contains() this branch
          // already did, not a closest()/getComputedStyle() walk, so it stays cheap on
          // this hot path.
          if (!SKIP_TAGS[child.tagName] && !isOculistNode(child)) {
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

    return { flatText: flatText, normalizedFlatText: normalizedFlatText, textNodeMaps: textNodeMaps };
  }

  // Finds every occurrence of term in a page index built by buildPageIndex()
  // and returns the visible Ranges (capped at 999). Called once per term.
  function findRanges(pageIndex, term) {
    var normalizedFlatText = pageIndex.normalizedFlatText;
    var textNodeMaps = pageIndex.textNodeMaps;
    var normalizedTerm = foldAccentsSafe(term.toLowerCase()).replace(/\s+/g, ' ');
    var ranges = [];

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
          ranges.push(range);
        }
      }

      index += term.length;
      if (ranges.length >= 999) break;
    }

    return ranges;
  }

  // Lite Mode's cheap path for an INACTIVE term (oculist-l6m.7): a plain indexOf scan
  // over normalizedFlatText that counts matches without ever creating a Range or calling
  // getClientRects — the layout-thrashing part of findRanges(). No visibility filtering
  // happens here, so this count can be higher than what findRanges() would report for the
  // same term (invisible matches are counted too); activating the term's chip runs
  // findRanges() for it and corrects the count. Capped at 999, same ceiling as
  // findRanges(), so one runaway term can't blow the count display up unboundedly.
  //
  // ponytail: 999/2000 are deliberate ceilings, not tuned limits — if a real page needs
  // more, the fix is switching findRanges()/this function to a streaming/paged scan, not
  // raising the numbers.
  function countMatchesOnly(pageIndex, term) {
    var normalizedFlatText = pageIndex.normalizedFlatText;
    var normalizedTerm = foldAccentsSafe(term.toLowerCase()).replace(/\s+/g, ' ');
    var count = 0;
    var index = 0;
    while ((index = normalizedFlatText.indexOf(normalizedTerm, index)) !== -1) {
      count++;
      index += term.length;
      if (count >= 999) break;
    }
    return count;
  }

  // Total match budget across every term in a performListSearch() scan (oculist-l6m.7),
  // separate from findRanges()'s per-term 999 cap. The active term is always materialised
  // first and is never subject to this cap (see performListSearch()), so the term the
  // user is currently looking at can never be starved by other terms' matches.
  var TOTAL_MATCH_CAP = 2000;

  function performSearch(term) {
    try {
      if (typeof Highlight !== 'undefined' && CSS.highlights) {
        CSS.highlights.delete('oculist-match');
        CSS.highlights.delete('oculist-active-match');
        CSS.highlights.delete('oculist-dim-match');
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

    var pageIndex = buildPageIndex();
    searchRanges = findRanges(pageIndex, term);

    if (searchRanges.length > 0) {
      firstEnter = true;
      try {
        if (typeof Highlight !== 'undefined' && CSS.highlights) {
          var matchHighlight = new Highlight();
          searchRanges.forEach(function (r) { matchHighlight.add(r); });
          matchHighlight.priority = 1;
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

  // Union of every INACTIVE term's Ranges from a performListSearch() scan, so the chip row
  // can show all terms' hits at once while only the active term gets the bright
  // oculist-match/oculist-active-match treatment. activeIdx === -1 (no active chip) means
  // every term is inactive, so nothing is skipped and the whole set is dim. Kept as its own
  // function with a single call site inside performListSearch() so oculist-l6m.7's Lite
  // Mode can skip dimming entirely (e.g. by guarding or removing that one call) without
  // touching how oculist-match/oculist-active-match are built.
  function updateDimHighlight(terms, ranges, activeIdx) {
    try {
      if (typeof Highlight === 'undefined' || !CSS.highlights) return;
      var dimHighlight = new Highlight();
      for (var i = 0; i < terms.length; i++) {
        if (i === activeIdx) continue;
        var termRangeList = ranges[i];
        if (!termRangeList) continue;
        for (var j = 0; j < termRangeList.length; j++) {
          // oculist-l6m.7's Lite Mode count-only placeholder (new Array(count)) is a
          // sparse array of holes carrying only a .length — skip falsy entries rather
          // than passing one to dimHighlight.add(), which throws on anything that is not
          // a Range and would otherwise abort this whole loop, silently dropping every
          // other (real) term's dim ranges too.
          if (termRangeList[j]) dimHighlight.add(termRangeList[j]);
        }
      }
      dimHighlight.priority = 0;
      CSS.highlights.set('oculist-dim-match', dimHighlight);
    } catch (e) {}
  }

  // Scans the page once for every term in the working list, filling termRanges (parallel
  // to workListTerms) so renderChipRow() can show each chip's own hit count. searchRanges/
  // activeIndex/firstEnter/countEl continue to describe only the ACTIVE term, exactly as
  // performSearch() left them, so findNext(), highlightActiveRange(), beacons, and the
  // viewport markers need no changes to keep working off them.
  //
  // buildPageIndex() runs exactly once per call — it is the expensive DOM traversal — and
  // the active term is materialised first (via findRanges) so a later match cap (bead
  // oculist-l6m.7) can never starve the term the user is currently looking at.
  //
  // When the working list is empty (no chip has been committed yet, e.g. the user is still
  // typing a draft that hasn't hit Enter), this falls back to lastTerm as an implicit
  // single term so the mutation-rescan caller below behaves exactly like the old
  // performSearch(lastTerm) call it replaces. The module-level termRanges array MUST stay
  // index-aligned with workListTerms at every exit of this function — a zero-length
  // workListTerms therefore always leaves termRanges zero-length too, even in the implicit
  // branch below. The implicit term's own Ranges still power searchRanges/countEl/nav/
  // highlights (its plain find-in-page purpose) via a local newTermRanges, they are simply
  // never written into the module-level termRanges renderChipRow()/restoreActiveChip()/
  // findNext() read by index (oculist-l6m.15 — the implicit branch used to write a
  // length-1 termRanges against a length-0 workListTerms, a state only invisible today
  // because every reader happens to gate on workListTerms.length first).
  function performListSearch() {
    try {
      if (typeof Highlight !== 'undefined' && CSS.highlights) {
        CSS.highlights.delete('oculist-match');
        CSS.highlights.delete('oculist-active-match');
        CSS.highlights.delete('oculist-dim-match');
      }
    } catch (e) {}

    searchRanges = [];
    activeIndex = -1;
    firstEnter = false;
    clearViewportMarkers();

    var terms = workListTerms;
    var activeIdx = activeTermIndex;
    // True only for the implicit-lastTerm fallback below — the sole case where `terms`
    // diverges from workListTerms itself. Gates the termRanges write-through further down
    // so the module-level array never grows past workListTerms.length (oculist-l6m.15).
    var isImplicitTerm = false;

    if (terms.length === 0) {
      termRanges = [];
      termStarved = [];
      if (!lastTerm) {
        countEl.textContent = '';
        setNavEnabled(false);
        renderChipRow();
        return;
      }
      terms = [lastTerm];
      activeIdx = 0;
      isImplicitTerm = true;
    }

    var pageIndex = buildPageIndex();

    // Running total across every term this scan materialises, active term included (see
    // TOTAL_MATCH_CAP above). The active term is always scanned first and unconditionally
    // — it is exempt from the cap check below — so it can never be the term that gets
    // starved.
    var totalMatches = 0;
    var termsStarved = false;

    var newTermRanges = new Array(terms.length);
    // Parallel to newTermRanges — set true for a term this scan skips outright because
    // TOTAL_MATCH_CAP was already spent (see the loop below). Written through to the
    // module-level termStarved alongside newTermRanges/termRanges further down so
    // renderChipRow() can tell "not scanned yet" apart from "scanned scan, but skipped by
    // the cap" (oculist-l6m.21) — both otherwise leave the same undefined termRanges[i].
    var newTermStarved = new Array(terms.length);
    // This is the only place the module-level termRanges[activeTermIndex] is ever given
    // real Ranges (Lite Mode's cheap placeholder below is for inactive terms only) — every
    // writer of activeTermIndex must either call performListSearch() synchronously after
    // setting it, or set termRanges to a state consistent with the index just written (the
    // buildUI() mount-restore path takes this second form: it sets termRanges = [] itself
    // rather than scanning, so every chip renders blank until the user picks one). The
    // implicit-lastTerm branch also lands real Ranges in newTermRanges here, but (per
    // oculist-l6m.15, below) that array is deliberately never copied into the module-level
    // termRanges, so this invariant still only ever concerns the real workListTerms/
    // activeTermIndex pairing.
    if (activeIdx >= 0 && activeIdx < terms.length) {
      newTermRanges[activeIdx] = findRanges(pageIndex, terms[activeIdx]);
      totalMatches += newTermRanges[activeIdx].length;
    }
    for (var i = 0; i < terms.length; i++) {
      if (i === activeIdx) continue;

      // Budget already spent by earlier terms in this loop (plus the active term) — stop
      // materialising any further inactive term entirely rather than truncating one mid-
      // scan. termsStarved drives the cap notice below; newTermStarved[i] marks this one
      // term's chip so renderChipRow() can render it distinctly from an unscanned chip.
      if (totalMatches >= TOTAL_MATCH_CAP) {
        termsStarved = true;
        newTermStarved[i] = true;
        continue;
      }

      if (settings.performanceMode) {
        // Lite Mode: count-only, no Range objects and no getClientRects for an inactive
        // term — this is the layout-thrashing cost oculist-l6m.7 exists to bound.
        newTermRanges[i] = new Array(countMatchesOnly(pageIndex, terms[i]));
      } else {
        newTermRanges[i] = findRanges(pageIndex, terms[i]);
      }
      totalMatches += newTermRanges[i].length;
    }
    // Skipped for the implicit-lastTerm fallback: workListTerms is empty there, and
    // termRanges must stay empty right alongside it (already set at the top of the
    // terms.length === 0 branch above) rather than picking up this scan's one-element
    // array. searchRanges/dim highlighting below read newTermRanges directly instead of
    // termRanges, so the implicit term's own scan still works exactly as before — only the
    // module-level array that renderChipRow()/restoreActiveChip()/findNext() index into by
    // chip position is held back (oculist-l6m.15).
    if (!isImplicitTerm) {
      termRanges = newTermRanges;
      termStarved = newTermStarved;
    }

    searchRanges = (activeIdx >= 0 && activeIdx < newTermRanges.length) ? newTermRanges[activeIdx] : [];

    // Single call site — this is the one line oculist-l6m.7's Lite Mode skips to turn
    // dimming off entirely, without touching the oculist-match/oculist-active-match logic
    // below. No Ranges were built for inactive terms above in Lite Mode, so there would be
    // nothing real to dim even if this ran.
    if (!settings.performanceMode) {
      updateDimHighlight(terms, newTermRanges, activeIdx);
    }

    // A committed working list can legitimately have no active chip (activeIdx === -1,
    // e.g. a persisted/restored list before any chip has been (re-)activated — see
    // dim_highlight.test.js). That is not the same thing as "searched and found zero
    // matches": every term may well have real hits, just none of them "active" right
    // now. hasActiveTerm distinguishes the two so a restored-but-unselected list never
    // writes the misleading "no matches" count or fires checkSiteOverride's unsolicited
    // notice against terms that are simply sitting dim (oculist-l6m.5, from the .4 review).
    var hasActiveTerm = activeIdx >= 0 && activeIdx < terms.length;

    if (searchRanges.length > 0) {
      firstEnter = true;
      try {
        if (typeof Highlight !== 'undefined' && CSS.highlights) {
          var matchHighlight = new Highlight();
          searchRanges.forEach(function (r) { matchHighlight.add(r); });
          matchHighlight.priority = 1;
          CSS.highlights.set('oculist-match', matchHighlight);
        }
      } catch (e) {
        console.warn('Oculist: CSS Custom Highlight API not supported or blocked.', e);
      }
      setNavEnabled(searchRanges.length > 1);
      countEl.textContent = '0 ' + i18n.of + ' ' + searchRanges.length;
    } else if (hasActiveTerm) {
      countEl.textContent = i18n.noMatch;
      setNavEnabled(false);
    } else {
      countEl.textContent = '';
      setNavEnabled(false);
    }

    checkSiteOverride(hasActiveTerm && searchRanges.length === 0);

    // Shown after checkSiteOverride() on purpose: checkSiteOverride() unconditionally
    // removeNotice()s whenever it isn't itself showing a notice (see its zeroMatches
    // branch), so calling showNotice() any earlier would have this notice wiped out from
    // under it in the same scan — the same ordering addChipTerm()'s cap message relies on.
    //
    // totalMatches, not TOTAL_MATCH_CAP, is what actually gets shown: the cap is checked
    // BEFORE materialising each term (see the loop above), so a term already in flight
    // when the budget is spent still gets its full (up to per-term-capped) count — the
    // real total this notice reports can run past 2000, up to 2997 (oculist-l6m.21).
    if (termsStarved) {
      showNotice('Showing the first ' + totalMatches + ' matches. Remove a term for a complete count.', 'match-scan-cap');
    }

    renderChipRow();
  }

  // ── Draft input vs. active chip ownership (oculist-l6m.5) ───────────────────────
  //
  // A non-empty input holds a DRAFT term that has not been committed to a chip yet. The
  // draft owns searchRanges and the active highlight (oculist-match/oculist-active-match)
  // exactly like a lone performSearch() always has — live debounced typing is unchanged.
  // But committed chips must stay rendered with their last known counts and stay in the
  // dim registry while the draft is being typed, so this rebuilds oculist-dim-match from
  // the working list's already-known termRanges (no chip term is re-scanned; only the
  // draft term itself gets a fresh buildPageIndex() call, exactly one per keystroke as
  // before). No chip is "active" for highlight purposes while a draft owns the highlight,
  // so every committed term — including whichever chip was active before typing began —
  // goes into the dim set (activeIdx -1 excludes nothing, see updateDimHighlight()).
  function performDraftSearch(term) {
    try {
      if (typeof Highlight !== 'undefined' && CSS.highlights) {
        CSS.highlights.delete('oculist-match');
        CSS.highlights.delete('oculist-active-match');
        // Only touch oculist-dim-match when there is a working list to keep dim — with
        // no chips at all (today's overwhelmingly common lone-search case) this must
        // behave byte-for-byte like the old performSearch(), which left it deleted. Lite
        // Mode always deletes it too (oculist-l6m.7): it is never rebuilt below in that
        // mode, so leaving a prior scan's registry in place would dim-highlight stale
        // ranges during draft typing instead of showing none at all.
        if (workListTerms.length === 0 || settings.performanceMode) CSS.highlights.delete('oculist-dim-match');
      }
    } catch (e) {}

    searchRanges = [];
    activeIndex = -1;
    firstEnter = false;
    clearViewportMarkers();

    var pageIndex = buildPageIndex();
    searchRanges = findRanges(pageIndex, term);

    if (workListTerms.length > 0 && !settings.performanceMode) {
      updateDimHighlight(workListTerms, termRanges, -1);
    }

    if (searchRanges.length > 0) {
      firstEnter = true;
      try {
        if (typeof Highlight !== 'undefined' && CSS.highlights) {
          var matchHighlight = new Highlight();
          searchRanges.forEach(function (r) { matchHighlight.add(r); });
          matchHighlight.priority = 1;
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

  // Clearing the input hands ownership back to whichever chip was active before the draft
  // started — its cached termRanges become searchRanges again and oculist-match returns,
  // reusing the last scan rather than re-scanning the page (so rapid type-then-clear never
  // costs a second buildPageIndex() call and never leaves a stale registry entry: every
  // registry this function touches is either deleted or freshly .set() before it returns).
  // Deliberately does not call highlightActiveRange() — restoring a chip must never
  // trigger the beacon, exactly like a plain chip click never has.
  function restoreActiveChip() {
    if (activeTermIndex < 0 || activeTermIndex >= workListTerms.length) {
      // No chips, or no chip currently active — today's empty state, byte-for-byte via
      // the same early-return branch a lone performSearch('') has always used.
      performSearch('');
      return;
    }

    try {
      if (typeof Highlight !== 'undefined' && CSS.highlights) {
        CSS.highlights.delete('oculist-active-match');
        // Lite Mode never rebuilds oculist-dim-match below (oculist-l6m.7) — delete it
        // explicitly here rather than leaving a prior (pre-toggle) scan's registry on
        // screen, since this function otherwise only ever .set()s it, never .delete()s it.
        if (settings.performanceMode) CSS.highlights.delete('oculist-dim-match');
      }
    } catch (e) {}

    activeIndex = -1;
    firstEnter = false;
    clearViewportMarkers();

    // termRanges[activeTermIndex] === undefined means this chip has never been scanned
    // (restored-but-unscanned carry-over); an empty array means it HAS been scanned and
    // genuinely has zero matches. The || [] below coalesces both to [], so this has to be
    // captured before that assignment or the distinction is lost (oculist-l6m.19's
    // undefined-vs-empty-array rule, reused verbatim from findNext()'s guard).
    var chipUnscanned = typeof termRanges[activeTermIndex] === 'undefined';

    searchRanges = termRanges[activeTermIndex] || [];

    if (!settings.performanceMode) {
      updateDimHighlight(workListTerms, termRanges, activeTermIndex);
    }

    try {
      if (typeof Highlight !== 'undefined' && CSS.highlights) {
        var matchHighlight = new Highlight();
        searchRanges.forEach(function (r) { matchHighlight.add(r); });
        matchHighlight.priority = 1;
        CSS.highlights.set('oculist-match', matchHighlight);
      }
    } catch (e) {}

    setNavEnabled(searchRanges.length > 1);
    countEl.textContent = searchRanges.length > 0
      ? '0 ' + i18n.of + ' ' + searchRanges.length
      : (chipUnscanned ? '' : i18n.noMatch);
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
      if (typeof node.classList === 'undefined') return false;
      // Beacons and viewport markers are mounted on documentElement, which the observer
      // now watches, so both have to be recognised or our own drawing retriggers a scan.
      if (node.classList.contains('oc-beacon')) return true;
      if (node.classList.contains('oc-viewport-marker')) return true;
    }
    return false;
  }

  // A mutation is ours if it happened inside our UI, or if every node it added or
  // removed is ours. Without the node check, drawing a beacon on documentElement would
  // schedule a rescan, which redraws the beacon, which schedules another rescan.
  function isOculistMutation(m) {
    if (isOculistNode(m.target)) return true;
    var total = m.addedNodes.length + m.removedNodes.length;
    if (total === 0) return false;
    for (var i = 0; i < m.addedNodes.length; i++) {
      if (!isOculistNode(m.addedNodes[i])) return false;
    }
    for (var j = 0; j < m.removedNodes.length; j++) {
      if (!isOculistNode(m.removedNodes[j])) return false;
    }
    return true;
  }

  // SPA frameworks like Turbo (GitHub) navigate by swapping in a whole new <body>. That
  // takes our bar down with it while `wrap` still points at the detached element, so the
  // finder looked closed-but-unopenable. Put it back on the current body instead.
  function remountIfDetached() {
    if (!wrap || wrap.isConnected || !document.body) return false;
    document.body.appendChild(wrap);
    injectHighlightStyles();
    return true;
  }

  function rescanAfterMutation() {
    remountIfDetached();
    // Fires as long as there is either a draft term in flight or a committed working
    // list — the guard used to be "no draft term", but a working list with an empty
    // input (e.g. right after Enter commits a chip and the user hasn't typed since)
    // must still keep rescanning.
    if (!wrap || (!lastTerm && workListTerms.length === 0)) return;
    var previousActiveIndex = activeIndex;
    performListSearch();
    if (searchRanges.length > 0) {
      activeIndex = Math.min(Math.max(previousActiveIndex, 0), searchRanges.length - 1);
      firstEnter = false;
      // skipScroll: a background rescan re-attaches highlights, it must not yank the
      // viewport back to the match while the user is scrolling elsewhere.
      highlightActiveRange(false, true);
    }
  }

  function startDomObserver() {
    if (domObserver || !window.MutationObserver) return;
    domObserver = new window.MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        if (isOculistMutation(mutations[i])) continue;
        if (domObserverTimer) clearTimeout(domObserverTimer);
        domObserverTimer = setTimeout(rescanAfterMutation, 350);
        return;
      }
    });
    // documentElement, not body — an observer bound to a body that gets swapped out goes
    // deaf, and the swap itself is a mutation we need to see.
    domObserver.observe(document.documentElement, { childList: true, subtree: true });
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

  // key identifies which notice CLASS this is (see the call sites for the full list:
  // 'site-override', 'term-cap', 'term-length', 'list-cap', 'list-write-failed',
  // 'list-rename-failed', 'list-delete-failed', 'match-scan-cap'). Dismissing a notice
  // only suppresses further showNotice() calls for that same key, for the rest of this
  // session — never every notice, and never permanently (oculist-l6m.12). A
  // falsy/unrecognized key lands in a shared 'default' bucket rather than either extreme.
  function showNotice(text, key) {
    var noticeKey = key || 'default';
    if (!wrapRoot || dismissedNotices.has(noticeKey) || noticeEl) return;
    noticeEl = document.createElement('div');
    noticeEl.className = 'oc-notice';
    noticeEl.setAttribute('data-oc-notice', noticeKey);

    var textEl = document.createElement('span');
    textEl.className = 'oc-notice-text';
    textEl.textContent = text;

    var closeEl = document.createElement('span');
    closeEl.className = 'oc-notice-close';
    closeEl.textContent = '✕';
    closeEl.addEventListener('click', function () {
      dismissedNotices.add(noticeKey);
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
      showNotice('Oculist may not find text on ' + hostname + ' — it renders content in a way standard page search can\'t scan.', 'site-override');
      return;
    }
    if (zeroMatches && document.body && document.body.innerText && document.body.innerText.trim().length > 500) {
      showNotice('No matches found. If you can see the text on screen, this page may render it in a way Oculist can\'t scan.', 'site-override');
    } else {
      removeNotice();
    }
  }

  // ── Navigation ────────────────────────────────────────────────────────────────

  // Ownership rule (oculist-l6m.19): lastTerm is kept in sync with whichever input value
  // last actually produced the current searchRanges — a plain performSearch()/
  // performDraftSearch() call sets it to the searched term, an Enter commit sets it to
  // input.value, and the input's own debounce handler sets it to '' immediately before
  // calling restoreActiveChip(). So term !== lastTerm is the ONLY reliable staleness
  // signal: it is true precisely when the user typed something new and got here (Ctrl+G/
  // F3/prev/next) before the debounced search ran, and false whenever the current
  // searchRanges already reflects input.value, no matter which of those three paths built
  // it. Two things that are NOT staleness on their own, and must never force a re-scan
  // through this signal: an empty searchRanges (a real chip can legitimately have zero
  // matches) and input.value not matching the active chip's term (leftover text from a
  // previous commit, sitting untouched in the box after a chip click, still owns nothing).
  // Treating either as "stale" is exactly what used to wipe oculist-dim-match (case 1) and
  // desync the count/nav from what was actually highlighted after a restore (case 2).
  function findNext(backwards) {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    var term = input.value;

    if (term !== lastTerm) {
      lastTerm = term;
      if (term) {
        // A working list in play must stay list-owned even for this catch-up search —
        // performSearch() unconditionally deletes oculist-dim-match, which would blow
        // away every other chip's dim ranges for a keystroke that has nothing to do with
        // them.
        if (workListTerms.length > 0) {
          performDraftSearch(term);
        } else {
          performSearch(term);
        }
      } else {
        // Mirrors the input's own debounce handler: an emptied input hands ownership
        // back to whichever chip was active before (or blanks out via performSearch('')
        // if there is none).
        restoreActiveChip();
      }
    }

    var hasActiveChip = activeTermIndex >= 0 && activeTermIndex < workListTerms.length;

    if (!term) {
      if (!hasActiveChip) {
        // Nothing is or was being searched: no draft in the input, no chip to fall back
        // on. Matches performSearch('')'s own blank (not "no match") count text.
        countEl.textContent = '';
        setNavEnabled(false);
        return;
      }
    }

    if (searchRanges.length === 0) {
      // A restored-but-unscanned active chip (mount carry-over, or a saved list just
      // loaded) has never had a real search run for it — termRanges[activeTermIndex] is
      // undefined, not an empty array. Reporting "no match" here would be a false claim
      // about the page; the carry-over contract is that restoring a list never scans
      // until the user asks for one (see loadWorkList()/loadSavedList()), so this leaves
      // the count blank instead, exactly like the pre-restore blank state. A chip that
      // HAS been scanned and genuinely has zero matches (termRanges[activeTermIndex] is
      // an array, just an empty one) still falls through to the real "no match" text below.
      // Gated on !term as well: a non-empty draft with genuinely zero matches already got
      // its own correct "no match" text from performDraftSearch() above, keyed off the
      // draft's own scan, not off whatever an unrelated restored-but-unscanned chip's
      // termRanges slot happens to hold — this branch must never clobber that.
      if (!term && hasActiveChip && typeof termRanges[activeTermIndex] === 'undefined') {
        countEl.textContent = '';
        setNavEnabled(false);
        return;
      }
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

  // ── Working-list chip row ────────────────────────────────────────────────────
  //
  // A "working list" of search terms rendered as chips beneath the bar. Every mutation
  // here persists via saveWorkList() directly (no window.__oc* hook — those two exist
  // purely for test-reachability into this closure, not as a call path for real UI
  // code).

  function persistWorkList() {
    saveWorkList({ terms: workListTerms, activeIndex: activeTermIndex });
  }

  // Activating a chip re-scans the whole working list (one performListSearch() call),
  // not just the newly active term — every chip's count slot needs to reflect the
  // current page state, not just the one that was clicked.
  function activateChip(i) {
    if (i < 0 || i >= workListTerms.length) return;
    activeTermIndex = i;
    persistWorkList();
    performListSearch();
  }

  // Removing the active chip moves the pointer to the previous index (index - 1),
  // clamped to 0 so removing the first chip while others remain activates the new
  // leftmost chip rather than clearing. The list-emptying case is handled separately
  // below, which forces -1 regardless of what this clamp computes.
  function removeChipAt(index) {
    if (index < 0 || index >= workListTerms.length) return;
    workListTerms.splice(index, 1);
    // Keep termRanges parallel to workListTerms so a stale/misaligned count is never
    // shown for a term that shifted index — termRanges itself is only fully refreshed
    // by the next performListSearch() call, splice() here is a no-op if there is no
    // scan yet (termRanges shorter than index). termStarved gets the same treatment so a
    // starved marker never survives onto the wrong (shifted) chip either.
    termRanges.splice(index, 1);
    termStarved.splice(index, 1);
    if (activeTermIndex === index) {
      activeTermIndex = Math.max(0, index - 1);
    } else if (activeTermIndex > index) {
      activeTermIndex -= 1;
    }
    if (workListTerms.length === 0) activeTermIndex = -1;
    persistWorkList();

    // Reuse performListSearch() — the same single rescan/refresh call activateChip()
    // already runs on every chip-row interaction — so the count, nav enabled-state,
    // termRanges, and all three highlight registries (oculist-match, oculist-dim-match,
    // oculist-active-match) converge on whatever chip is now active, exactly once
    // (oculist-l6m.33). Before this fix, removal only spliced the term/range arrays and
    // called renderChipRow(), leaving every registry and the count/nav UI holding the
    // just-removed chip's stale state.
    if (workListTerms.length === 0) {
      // True empty state: no chip left to search for. Backspace can only ever reach
      // this function with the input already empty (see keydownHandler's Backspace
      // guard), and the X button's common case matches too. When that holds, force
      // lastTerm into sync with the empty input *before* calling performListSearch() —
      // otherwise a lastTerm left stale by an in-flight debounce (the user backspaced
      // through the chip's own leftover text faster than the 150ms debounce settles)
      // would make performListSearch() treat it as an implicit lone search and re-scan
      // the very term that was just removed, reproducing this bug through a different
      // path. With lastTerm forced to '', performListSearch() takes its existing
      // no-terms/no-lastTerm early return — the same free "clear" path it already uses
      // at mount — so removing the only chip never costs a real page rescan
      // (buildPageIndex() is never called). Also cancels any pending debounce so it
      // can't independently re-fire restoreActiveChip() against now-stale closures
      // after we've already settled the empty state.
      //
      // When the input instead holds a non-empty draft, a debounce may still be in
      // flight from the user's typing. Leaving lastTerm pointing at the just-removed
      // chip's term would make the implicit-lastTerm fallback below re-scan that
      // removed term for one tick until the debounce fires and corrects it
      // (oculist-bxm). Syncing lastTerm to the draft here instead makes that same
      // implicit scan search what the user is actually typing, so there is nothing
      // stale to flash. The debounce itself is left alone — cancelling it would drop
      // the user's in-flight draft search — and it stays idempotent: it re-sets
      // lastTerm to this same value and re-runs the equivalent scan via
      // performDraftSearch().
      if (input) {
        if (input.value === '') {
          if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
          }
          lastTerm = '';
        } else {
          lastTerm = input.value;
        }
      }
    }
    performListSearch();
  }

  function removeLastChip() {
    if (workListTerms.length === 0) return;
    removeChipAt(workListTerms.length - 1);
  }

  // Trims, then: rejects whitespace-only silently, enforces the 100-char cap (checked
  // against the trimmed length), activates rather than duplicates an existing term, and
  // enforces the 10-term cap. Both caps surface through showNotice(), each under its own
  // notice key ('term-length'/'term-cap' — oculist-l6m.12, so dismissing one cap notice
  // never silences the other); the whitespace-only rejection does not. Returns
  // { message, key } on either cap (undefined otherwise) so the caller can re-show it,
  // under the same key, after findNext()'s performSearch -> checkSiteOverride() call —
  // which runs right after this, in the same Enter handler, and unconditionally clears
  // whatever notice is up when the term the user just typed matches the page — has had a
  // chance to wipe it out from under this same keystroke.
  //
  // oculist-l6m.5: a real commit (a new chip pushed, or an existing one re-activated on a
  // duplicate) now runs performListSearch() itself, so dim highlights and every chip's
  // count are on screen the instant Enter lands a chip — not just after a later chip
  // click or DOM-mutation rescan. A cap hit never reaches either scan call below.
  function addChipTerm(rawTerm) {
    var trimmed = (rawTerm || '').trim();
    if (trimmed === '') return;

    if (trimmed.length > 100) {
      // removeNotice() first: showNotice() is a no-op while a notice is already showing
      // (e.g. a stale "no matches" notice from the search that is about to run right
      // after this, via keydownHandler's Enter -> findNext fall-through). A cap being hit
      // must always surface, not lose a race with whatever notice happened to be up.
      removeNotice();
      var lengthMessage = 'Search terms are limited to 100 characters. Shorten the term and try again.';
      showNotice(lengthMessage, 'term-length');
      return { message: lengthMessage, key: 'term-length' };
    }

    var existingIndex = workListTerms.indexOf(trimmed);
    if (existingIndex !== -1) {
      activateChip(existingIndex);
      return;
    }

    if (workListTerms.length >= 10) {
      removeNotice();
      var capMessage = 'Oculist searches up to 10 terms at once. Remove a term to add another.';
      showNotice(capMessage, 'term-cap');
      return { message: capMessage, key: 'term-cap' };
    }

    workListTerms.push(trimmed);
    activeTermIndex = workListTerms.length - 1;
    persistWorkList();
    performListSearch();
  }

  // Called from keydownHandler's Enter branch. Adds/activates a chip as a side effect of
  // Enter when the input holds a term that differs from the currently active chip;
  // otherwise Enter is next-match exactly as before. Never clears the input — the search
  // bar keeps whatever the user typed.
  //
  // Returns { committed, message, key }. committed is true only when addChipTerm()
  // actually pushed or (re)activated a chip — i.e. ran its one performListSearch() scan —
  // so keydownHandler can land directly off that fresh state instead of falling through to
  // findNext(), which would otherwise re-scan the page a second time on the same
  // keystroke (oculist-l6m.5). message/key are the cap notice's text and notice key
  // (oculist-l6m.12) on a cap hit, undefined otherwise; committed is always false
  // whenever message is set.
  function maybeAddChipFromInput() {
    if (!input || !input.value) return { committed: false };
    var activeTerm = (activeTermIndex >= 0 && activeTermIndex < workListTerms.length)
      ? workListTerms[activeTermIndex]
      : null;
    var trimmed = input.value.trim();
    if (trimmed === '' || trimmed === activeTerm) return { committed: false };
    var result = addChipTerm(input.value);
    return { committed: !result, message: result && result.message, key: result && result.key };
  }

  function renderChipRow() {
    if (!wrapRoot || !chipRow) return;

    // oculist-l6m.26 fix-pass: keep the lists popover's Save button in sync with main-bar
    // chip edits (add/remove) while the popover stays open, in both directions. Guarded on
    // listsPanel so this is a no-op whenever the popover is closed.
    if (listsPanel) updateSaveBtnDisabled();

    chipRow.textContent = '';

    if (workListTerms.length === 0) {
      chipRow.hidden = true;
      chipRow.style.display = 'none';
      return;
    }

    chipRow.hidden = false;
    chipRow.style.display = '';

    // 'full' is the only motion level chips animate under; 'reduced' and 'off' both
    // suppress it, matching effectiveMotion()'s own two-tier gate elsewhere.
    var noMotion = effectiveMotion() !== 'full';

    workListTerms.forEach(function (term, i) {
      var isActive = i === activeTermIndex;

      var chip = document.createElement('span');
      chip.className = 'oc-chip' + (noMotion ? ' oc-no-motion' : '');

      // termRanges[i] is undefined until performListSearch() has scanned this term at
      // least once — right after addChipTerm() pushes it before any scan, or a term
      // skipped outright by the oculist-l6m.7 total-match cap (termsStarved). Both cases
      // leave termRanges[i] undefined, but they are not the same state to the user: an
      // unscanned chip simply hasn't been looked at yet, while a starved chip WAS in this
      // scan and got skipped because the cap was already spent. termStarved[i] (set
      // alongside termRanges in performListSearch()) is how the two are told apart here
      // (oculist-l6m.21) — the accessible name must not claim a count for either: "0
      // matches" is only correct once termRanges[i] is a real (possibly empty) array from
      // an actual scan (oculist-l6m.19's undefined-vs-empty-array distinction).
      var hasCount = !!termRanges[i];
      var countValue = hasCount ? termRanges[i].length : 0;
      var isStarved = !hasCount && !!termStarved[i];

      var termBtn = document.createElement('button');
      termBtn.type = 'button';
      termBtn.className = 'oc-chip-term' + (isActive ? ' active' : '');
      termBtn.textContent = term;
      termBtn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      var termLabel = (isActive ? 'Active search term: ' : 'Search term: ') + term;
      if (hasCount) {
        termLabel += ', ' + countValue + ' ' + (countValue === 1 ? i18n.matchSingular : i18n.matchPlural);
      } else if (isStarved) {
        termLabel += ', ' + i18n.matchCapReached;
      }
      termBtn.setAttribute('aria-label', termLabel);
      termBtn.addEventListener('click', function () { activateChip(i); });

      // The visual count span stays aria-hidden — its value is already folded into
      // termBtn's aria-label above, so a screen reader is never asked to read it twice.
      // A starved chip gets an em dash rather than the plain blank an unscanned chip
      // shows: visually distinct from both a real number and "nothing rendered yet",
      // without needing a new colour or icon (oculist-l6m.21).
      var chipCountEl = document.createElement('span');
      chipCountEl.className = 'oc-chip-count';
      chipCountEl.setAttribute('aria-hidden', 'true');
      chipCountEl.textContent = hasCount ? String(countValue) : (isStarved ? '—' : '');

      var removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'oc-chip-remove';
      removeBtn.textContent = '✕';
      removeBtn.setAttribute('aria-label', 'Remove search term: ' + term);
      removeBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        removeChipAt(i);
      });

      chip.appendChild(termBtn);
      chip.appendChild(chipCountEl);
      chip.appendChild(removeBtn);
      chipRow.appendChild(chip);
    });
  }

  // Display the active match with the high-visibility visual animation
  function highlightActiveRange(shouldAnimate, skipScroll) {
    if (searchRanges.length === 0 || activeIndex < 0) return;

    var activeRange = searchRanges[activeIndex];

    try {
      if (typeof Highlight !== 'undefined' && CSS.highlights) {
        var activeHighlight = new Highlight();
        activeHighlight.add(activeRange);
        activeHighlight.priority = 2;
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

    if (!isFullyInViewport && !skipScroll) {
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
          'box-sizing:content-box',
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

  // Bound to resize only, not folded into scheduleViewportMarkersUpdate — that one is
  // shared with handleScroll, which fades the overlays out on purpose, and redrawing
  // them 100ms later would resurrect what the scroll just dismissed.
  function handleResize() {
    scheduleViewportMarkersUpdate();
    if (overlayResizeTimer) clearTimeout(overlayResizeTimer);
    overlayResizeTimer = setTimeout(repositionActiveOverlays, 100);
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
        if (wrap && wrap.isConnected) {
          input.focus();
          input.select();
        } else {
          window.__ocToggle();
        }
      }
      return;
    }
    if (!wrap) return;
    if (e.key === 'Escape') {
      // Both dialogs (lists popover, settings panel) get their own first Escape, closing
      // only themselves and returning focus to their trigger button, so a user browsing
      // saved lists or adjusting settings never loses the whole overlay by accident — they
      // now carry identical role="dialog" semantics (oculist-l6m.27) and so must behave
      // identically for Escape per the WAI-ARIA APG (oculist-l6m.37). A second Escape, with
      // both dialogs already gone, falls through to the existing full-destroy below exactly
      // as before oculist-l6m.9. toggleListsMenu()/toggleSettings() keep the two mutually
      // exclusive, so in practice only one of the next two branches can ever fire — the
      // listsPanel check simply stays first for a deterministic order if that invariant is
      // ever broken.
      if (listsPanel) { closeListsMenu(); return; }
      if (settingsPanel) { closeSettings(); return; }
      window.__ocDestroy();
      return;
    }

    var isGKey = (e.key && e.key.toLowerCase() === 'g') || e.keyCode === 71 || e.code === 'KeyG';
    var isF3Key = e.key === 'F3' || e.keyCode === 114;
    if (((e.ctrlKey || e.metaKey) && isGKey) || isF3Key) {
      try { e.preventDefault(); } catch (err) {}
      e.stopPropagation();
      e.stopImmediatePropagation();
      findNext(e.shiftKey);
      return;
    }
    
    // Backspace with the input in focus and empty removes the last chip. Scoped to the
    // input specifically (not "focus anywhere in wrap") so backspacing inside, say, a
    // settings field never eats a chip by accident.
    if (e.key === 'Backspace' && wrapRoot && wrapRoot.activeElement === input && input && input.value === '') {
      removeLastChip();
      return;
    }

    if (e.key === 'Enter') {
      // Enter inside the list popover's own text inputs (Save current as…/rename) is
      // handled entirely by their own confirm-button bindings — this is not the main
      // find input's commit-a-chip Enter, and must not fall through to it (which reads
      // input.value, the MAIN find input, regardless of what's actually focused, and
      // could otherwise silently commit a stray draft term as a chip).
      if (listsPanel && wrapRoot && wrapRoot.activeElement && listsPanel.contains(wrapRoot.activeElement)) {
        return;
      }
      // Same reasoning as the listsPanel guard above, mirrored for the settings panel:
      // Enter on a settings control (a <button>, a color <input>, a link) must trigger
      // its own native activation, not be swallowed into a chip-commit on the main find
      // input (oculist-oxh).
      if (settingsPanel && wrapRoot && wrapRoot.activeElement && settingsPanel.contains(wrapRoot.activeElement)) {
        return;
      }
      if (document.activeElement === wrap || wrap.contains(document.activeElement) || (wrapRoot && wrapRoot.activeElement)) {
        try { e.preventDefault(); } catch (err) {}
        // A non-empty term that differs from the active chip becomes a chip and the
        // active one, as a side effect. maybeAddChipFromInput() itself runs the one
        // performListSearch() scan when it actually commits (new chip or duplicate
        // activation), so a committed Enter lands directly off that fresh state below
        // instead of falling through to findNext() — which called a bare performSearch()
        // here before oculist-l6m.5, wiping the dim registry and rebuilding oculist-match
        // for a single term, undoing the scan that just ran.
        var commitResult = maybeAddChipFromInput();
        if (commitResult.committed) {
          if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
          }
          lastTerm = input.value;
          // Land on match 0 (or the last match, backwards) via the existing firstEnter
          // flag — performListSearch() already set it when the fresh scan found matches,
          // exactly like a lone performSearch() always has.
          if (searchRanges.length > 0) {
            if (firstEnter) {
              firstEnter = false;
              activeIndex = e.shiftKey ? searchRanges.length - 1 : 0;
            } else {
              activeIndex = e.shiftKey
                ? (activeIndex <= 0 ? searchRanges.length - 1 : activeIndex - 1)
                : (activeIndex >= searchRanges.length - 1 ? 0 : activeIndex + 1);
            }
            highlightActiveRange(true);
          }
        } else {
          // No commit happened (blank/whitespace input, a cap hit, or the input already
          // matches the active chip) — Enter is plain next-match, exactly as before.
          findNext(e.shiftKey);
        }
        // A cap hit never commits, so it always takes the findNext() branch above, whose
        // performSearch() -> checkSiteOverride() call unconditionally clears whatever
        // notice is up when the just-typed term matches the page — erasing the cap notice
        // addChipTerm() just showed in the same keystroke. Re-show it.
        if (commitResult.message) {
          removeNotice();
          showNotice(commitResult.message, commitResult.key);
        }
      }
    }
  }

  // ── Settings panel ────────────────────────────────────────────────────────────

  // skipFocusReturn mirrors closeListsMenu()'s option (oculist-l6m.27): set when this
  // close is a step on the way to focus landing somewhere else on purpose — here, only
  // the list popover's own toggleListsMenu() mutual-exclusion branch, where focus is
  // about to move into the list popover instead of back to gearBtn.
  function closeSettings(opts) {
    var returnFocus = !(opts && opts.skipFocusReturn);
    var t = T();
    if (settingsPanel) {
      settingsPanel.remove();
      settingsPanel = null;
    }
    if (gearBtn) {
      gearBtn.classList.remove('active');
      gearBtn.style.color = t.text;
      gearBtn.setAttribute('aria-expanded', 'false');
      if (returnFocus) gearBtn.focus();
    }
  }

  function openSettings() {
    buildSettingsPanel();
    if (gearBtn) {
      gearBtn.classList.add('active');
      gearBtn.style.color = T().accent;
      gearBtn.setAttribute('aria-expanded', 'true');
    }
    // Move focus into the dialog itself (tabIndex -1, set in buildSettingsPanel()) rather
    // than guessing at a "first" control — the panel has no single obvious default field,
    // and landing on a text input by default is its own anti-pattern.
    if (settingsPanel) settingsPanel.focus();
  }

  function toggleSettings() {
    if (settingsPanel) {
      closeSettings();
    } else {
      // Opening Settings while the list popover is open must close the list popover —
      // the two are mutually exclusive (oculist-l6m.9 edge case). skipFocusReturn: focus
      // is about to move into the settings panel instead of back to listsBtn.
      if (listsPanel) { closeListsMenu({ skipFocusReturn: true }); }
      openSettings();
    }
  }

  // groupKey (optional) + item.value forms a stable data-oc-key identifier
  // (oculist-l6m.38) that survives an in-place settings-panel rebuild — the item arrays
  // themselves are static per call site, so the same key always resolves to the "same"
  // control across a rebuild even though the DOM node itself is new.
  function makeOptionGroup(items, currentVal, onChange, groupKey) {
    var group = document.createElement('div');
    group.className = 'oc-toggle-group';

    items.forEach(function (item) {
      var btn = document.createElement('button');
      btn.className = 'oc-toggle-btn' + (item.value === currentVal ? ' active' : '');
      btn.textContent = item.label;
      btn.title = item.title || item.label;
      if (groupKey) btn.setAttribute('data-oc-key', groupKey + ':' + item.value);
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

  function makeRadioList(items, currentVal, onChange, disabled, groupKey) {
    var list = document.createElement('div');
    list.className = 'oc-radio-list';
    if (disabled) {
      list.style.opacity = '0.5';
      list.style.pointerEvents = 'none';
    }

    items.forEach(function (item) {
      var row = document.createElement('button');
      row.className = 'oc-radio-item' + (item.value === currentVal ? ' active' : '');
      if (groupKey) row.setAttribute('data-oc-key', groupKey + ':' + item.value);
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
    // role="dialog" + a focusable (tabIndex -1) container match listsPanel below
    // (oculist-l6m.27) — the two panels are the same interaction pattern and must expose
    // and behave identically for assistive tech. A dialog sharing its accessible name with
    // its trigger button is a normal, correct pattern (screen readers disambiguate by role,
    // e.g. "Options button" vs. "Options dialog") — listsPanel's aria-label below does
    // exactly that, and this panel deliberately matches it rather than using aria-labelledby:
    // Blink applies CSS text-transform when computing a name from a *referenced* element, so
    // pointing aria-labelledby at the visible header (which is uppercase via CSS, see
    // .oc-settings-title below) would ship a shouty, letter-spelled announced name even
    // though i18n.prefTitle itself is sentence case. aria-label reads the JS string directly,
    // bypassing that CSS, so the announced name stays sentence case while the header still
    // renders in caps. Do not "fix" this back to aria-labelledby.
    settingsPanel.setAttribute('role', 'dialog');
    settingsPanel.setAttribute('aria-label', i18n.prefTitle);
    settingsPanel.tabIndex = -1;
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
    resetBtn.setAttribute('data-oc-key', 'reset');
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
      rebuildSettingsPanelPreservingFocus();
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
    }, 'site')));

    col1.appendChild(makeSettingsField(i18n.visualTheme, i18n.themeDesc, makeOptionGroup([
      { value: 'dark',  label: i18n.dark  },
      { value: 'light', label: i18n.light },
      { value: 'system', label: i18n.system },
    ], settings.theme, function (v) {
      settings.theme = v; saveSettings();
      injectHighlightStyles();
      applyWrapPosition();
      rebuildSettingsPanelPreservingFocus();
    }, 'theme')));

    var scrollBehaviorField = makeSettingsField(i18n.scrollBehavior, i18n.scrollBehaviorDesc, makeOptionGroup([
      { value: 'smooth', label: i18n.smooth },
      { value: 'instant', label: i18n.instant }
    ], settings.scrollBehavior, function (v) {
      settings.scrollBehavior = v; saveSettings();
    }, 'scroll'));
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
      constraints.effectDisabled,
      'effect'
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
      rebuildSettingsPanelPreservingFocus();
    }, 'position')));

    var pickerGroup = document.createElement('div');
    pickerGroup.className = 'oc-settings-picker-group';

    var items = [
      { key: 'match', label: i18n.matchLabel, val: effColors.match, title: i18n.matchTitle, cb: function (v) { settings.matchColor = v; saveSettings(); injectHighlightStyles(); } },
      { key: 'active', label: i18n.activeLabel, val: effColors.active, title: i18n.activeTitle, cb: function (v) { settings.activeColor = v; saveSettings(); injectHighlightStyles(); } },
      { key: 'beacon', label: i18n.beaconColorLabel || i18n.beaconLabel, val: effColors.beacon, title: i18n.beaconTitle, cb: function (v) { settings.beaconColor = v; saveSettings(); } }
    ];

    items.forEach(function (item) {
      var picker = makeColorPicker(item.label, item.val, item.title, item.cb, constraints.colorsDisabled, item.key);
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

  // Rebuilds the settings panel in place (theme/position/reset changes, or a settings
  // change syncing in from another tab/the popup) without ejecting keyboard focus to
  // document body (oculist-l6m.38). buildSettingsPanel() tears the whole subtree down and
  // recreates it, so the previously focused node is gone; this captures a data-oc-key
  // identifier for whatever was focused *inside the panel* beforehand (see makeOptionGroup/
  // makeRadioList/makeColorPicker) and re-resolves the equivalent control afterward,
  // falling back to the panel container (tabIndex -1) if no key was captured, the control
  // no longer exists, or the control exists but is no longer a valid focus target (e.g. a
  // control that's now profile-disabled) — verified by checking wrapRoot.activeElement
  // actually landed on it after calling .focus(), rather than trusting a bare `disabled`
  // check, since disabled is only one of several reasons a focus() call can silently no-op
  // (hidden, display:none, inert, removed from the tab order, etc).
  //
  // Deliberately does NOT restore focus if it wasn't inside the panel to begin with — a
  // rebuild triggered by a remote settings change (the storage.onChanged listener) must
  // never steal focus from the page/find-input/another overlay into the panel.
  function rebuildSettingsPanelPreservingFocus() {
    if (!settingsPanel) { buildSettingsPanel(); return; }

    var focusWasInPanel = false;
    var focusKey = null;
    if (wrapRoot && wrapRoot.activeElement && settingsPanel.contains(wrapRoot.activeElement)) {
      focusWasInPanel = true;
      var fe = wrapRoot.activeElement;
      focusKey = (fe.getAttribute && fe.getAttribute('data-oc-key')) || null;
    }

    settingsPanel.remove();
    settingsPanel = null;
    buildSettingsPanel();
    if (!settingsPanel) return;

    if (focusWasInPanel) {
      var restored = focusKey
        ? settingsPanel.querySelector('[data-oc-key="' + focusKey + '"]')
        : null;
      if (restored) restored.focus();
      if (!restored || !wrapRoot || wrapRoot.activeElement !== restored) {
        settingsPanel.focus();
      }
    }
  }

  function makeColorPicker(label, val, title, onChange, disabled, key) {
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
    if (key) input.setAttribute('data-oc-key', 'color:' + key);
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

  // ── List menu (saved lists popover, oculist-l6m.9) ─────────────────────────────
  //
  // Reuses the settings panel's popover styling and shadow-root mount pattern (same
  // wrapRoot.appendChild + entrance animation), but is its own element (#oc-lists-panel)
  // so it and #oc-settings-panel stay mutually exclusive rather than one incidentally
  // hiding the other.

  // Newest-first ordering with no stored timestamp: generateListId() ids are
  // Date.now().toString(36) + random suffix, so for ids of equal length a plain string
  // compare is equivalent to a numeric compare of the timestamp prefix. The length check
  // guards the (currently many decades off) day base36 timestamps grow an extra digit,
  // so a longer id always outranks a shorter one regardless of the character comparison.
  function compareListsNewestFirst(a, b) {
    if (a.id.length !== b.id.length) return b.id.length - a.id.length;
    if (a.id === b.id) return 0;
    return a.id < b.id ? 1 : -1;
  }

  function closeListsMenu(opts) {
    var returnFocus = !(opts && opts.skipFocusReturn);
    if (listsPanel) {
      listsPanel.remove();
      listsPanel = null;
    }
    if (listsBtn) {
      listsBtn.classList.remove('active');
      listsBtn.style.color = T().text;
      listsBtn.setAttribute('aria-expanded', 'false');
      if (returnFocus) listsBtn.focus();
    }
  }

  function openListsMenu() {
    buildListsPanel();
    if (listsBtn) {
      listsBtn.classList.add('active');
      listsBtn.style.color = T().accent;
      listsBtn.setAttribute('aria-expanded', 'true');
    }
    // Move focus into the dialog itself (tabIndex -1, set in buildListsPanel()) — same
    // rationale as openSettings() (oculist-l6m.27): no single obvious default control,
    // and a text input (Save current as…) is the wrong thing to autofocus.
    if (listsPanel) listsPanel.focus();
  }

  function toggleListsMenu() {
    if (listsPanel) {
      closeListsMenu();
      return;
    }
    // Opening the list popover while Settings is open must close Settings — the two are
    // mutually exclusive (oculist-l6m.9 edge case). skipFocusReturn: focus is about to
    // move into the list popover instead of back to gearBtn.
    if (settingsPanel) {
      closeSettings({ skipFocusReturn: true });
    }
    openListsMenu();
  }

  // Loading a saved list replaces the working list outright, with no confirmation —
  // "Save current as…" sits directly above the list for exactly this reason. Mirrors the
  // same blank-counts, no-scan state loadWorkList() leaves a freshly restored working
  // list in on mount (oculist-l6m.3): chips render immediately, but hit counts and the
  // active highlight stay blank until the user clicks a chip to scan.
  //
  // sanitizeListTerms() re-caps to MAX_LIST_TERMS defensively — saveList() already caps
  // saved terms to 10 before they ever reach storage, so this should never trim anything
  // in practice, but a saved list is stored data a future format change (or a manual
  // edit of chrome.storage.sync) could still hand back over-length, and the working list
  // must never be corrupted by it.
  function loadSavedList(list) {
    var terms = sanitizeListTerms(list.terms);

    // Storage-layer backstop for oculist-l6m.26, mirroring the disabled load control in
    // buildListItem() above: this function has no other caller, so the button's disabled
    // attribute already stops a real click from reaching here, but a 0-term list must
    // never be allowed to replace the working list regardless of how this got called —
    // loading has no confirmation step, so there would be no way back from the wipe.
    if (terms.length === 0) return;

    try {
      if (typeof Highlight !== 'undefined' && CSS.highlights) {
        CSS.highlights.delete('oculist-match');
        CSS.highlights.delete('oculist-active-match');
        CSS.highlights.delete('oculist-dim-match');
      }
    } catch (e) {}
    clearViewportMarkers();

    // Cancel any in-flight debounce so it can't fire after this function returns and
    // independently re-invoke restoreActiveChip()/performSearch() against now-stale
    // closures — the same reasoning oculist-l6m.33 applied to removeChipAt()'s
    // list-emptying branch. Unlike that branch, this reset is unconditional rather than
    // gated on `input.value === ''`: loadSavedList() always force-clears input.value and
    // lastTerm below regardless of what the user had typed, so there is no "leftover
    // draft text" case to preserve here the way Backspace's guard has to.
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }

    workListTerms = terms;
    activeTermIndex = -1;
    termRanges = [];
    termStarved = [];
    searchRanges = [];
    activeIndex = -1;
    firstEnter = false;
    lastTerm = '';
    if (input) input.value = '';
    if (countEl) countEl.textContent = '';
    setNavEnabled(false);
    removeNotice();

    persistWorkList();
    renderChipRow();
    closeListsMenu({ skipFocusReturn: true });
    if (input) input.focus();
  }

  function refreshListsPanel() {
    if (!listsPanel) return;
    var saveInput = listsPanel.querySelector('.oc-list-save-input');
    var saveBtn = listsPanel.querySelector('.oc-list-save-btn');
    if (saveInput) saveInput.value = '';
    if (saveBtn) saveBtn.disabled = true;
    var listContainer = listsPanel.querySelector('.oc-list-items');
    if (!listContainer) return;
    listSavedLists(function (lists) {
      if (!listsPanel) return;
      renderListItems(listContainer, lists);
    });
  }

  function buildListItem(list) {
    var item = document.createElement('div');
    item.className = 'oc-list-item';
    item.title = list.terms.join(', ');

    function renderView() {
      item.textContent = '';
      item.classList.remove('oc-list-item-editing');

      var nameBtn = document.createElement('button');
      nameBtn.type = 'button';
      nameBtn.className = 'oc-list-item-name';
      nameBtn.textContent = list.name;
      nameBtn.setAttribute('aria-label', i18n.loadListLabel + ': ' + list.name);
      // A 0-term saved list is unreachable through today's Save control (oculist-l6m.26
      // disables it whenever the working list is empty), but one can still exist here: it
      // may have been saved by a version of the extension before this fix, then synced in
      // from another device, or hand-edited/corrupted in sync storage (e.g. terms: ['   '],
      // whitespace-only — oculist-l6m.35). loadSavedList() has no confirmation step
      // by design, so loading a 0-term list would silently wipe the working list with no
      // way back — disable the load control outright for it, the same disabled-control
      // treatment the Save button and the rename confirm button already get elsewhere in
      // this popover, rather than let the click through to a destructive no-op.
      //
      // list.terms is already sanitizeListTerms()'d by listSavedLists() before it ever
      // reaches here, so this is the same "real terms" definition loadSavedList() itself
      // gates on below — a list badged N terms is guaranteed to load exactly N terms.
      if (list.terms.length === 0) {
        nameBtn.disabled = true;
        nameBtn.title = i18n.emptyListHint;
      }
      nameBtn.addEventListener('click', function () {
        loadSavedList(list);
      });

      var countBadge = document.createElement('span');
      countBadge.className = 'oc-list-item-count';
      countBadge.setAttribute('aria-hidden', 'true');
      countBadge.textContent = String(list.terms.length) + ' ' +
        (list.terms.length === 1 ? i18n.termSingular : i18n.termPlural);

      var renameBtn = document.createElement('button');
      renameBtn.type = 'button';
      renameBtn.className = 'oc-list-rename-btn';
      renameBtn.textContent = '✎';
      renameBtn.setAttribute('aria-label', i18n.renameListLabel + ': ' + list.name);
      renameBtn.addEventListener('click', function () {
        renderEdit();
      });

      var deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'oc-list-delete-btn';
      deleteBtn.textContent = '✕';
      deleteBtn.setAttribute('aria-label', i18n.deleteListLabel + ': ' + list.name);
      deleteBtn.addEventListener('click', function () {
        deleteList(list.id, function (result) {
          // 'write-failed' already shows its own notice via deleteList(); leave the item
          // in place so the user can retry. 'exception' is silent by design — same, leave
          // it. Only a genuine delete (or a stale item already gone elsewhere) refreshes.
          if (result && (result.ok || result.reason === 'not-found')) {
            refreshListsPanel();
          }
        });
      });

      item.appendChild(nameBtn);
      item.appendChild(countBadge);
      item.appendChild(renameBtn);
      item.appendChild(deleteBtn);
    }

    function renderEdit() {
      item.textContent = '';
      item.classList.add('oc-list-item-editing');

      var renameInput = document.createElement('input');
      renameInput.type = 'text';
      renameInput.className = 'oc-list-rename-input';
      renameInput.value = list.name;
      renameInput.maxLength = 100;
      renameInput.setAttribute('aria-label', i18n.renameListLabel + ': ' + list.name);

      var confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'oc-list-rename-confirm';
      confirmBtn.textContent = '✓';
      confirmBtn.setAttribute('aria-label', i18n.confirmRenameLabel);

      var cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'oc-list-rename-cancel';
      cancelBtn.textContent = '✕';
      cancelBtn.setAttribute('aria-label', i18n.cancelRenameLabel);

      // Inherited obligation (oculist-l6m.8 review, carried into this bead): renameList()
      // rejects a blank/whitespace-only name SILENTLY (no notice) — the confirm control
      // must therefore stay disabled on blank input rather than let the user press it
      // into a silent no-op.
      function updateConfirmState() {
        confirmBtn.disabled = renameInput.value.trim() === '';
      }
      updateConfirmState();

      renameInput.addEventListener('input', updateConfirmState);
      renameInput.addEventListener('keydown', function (e) {
        e.stopPropagation();
        if (e.key === 'Enter' && !confirmBtn.disabled) {
          e.preventDefault();
          confirmBtn.click();
        }
      });

      confirmBtn.addEventListener('click', function () {
        var name = renameInput.value;
        if (name.trim() === '') return;
        renameList(list.id, name, function (result) {
          if (!result) return;
          if (result.ok || result.reason === 'not-found') {
            // A genuine rename, or the item having vanished from under the edit (e.g.
            // deleted from another device mid-edit) — either way the panel needs a
            // fresh read.
            refreshListsPanel();
          }
          // 'write-failed' already shows its own notice via renameList(); leave the edit
          // row open (with the user's typed text intact) so they can retry. 'empty-name'
          // cannot occur here (confirm is disabled on blank input) and 'exception' is
          // silent by design — both also leave the row as-is.
        });
      });

      cancelBtn.addEventListener('click', function () {
        renderView();
      });

      item.appendChild(renameInput);
      item.appendChild(confirmBtn);
      item.appendChild(cancelBtn);
      renameInput.focus();
      renameInput.select();
    }

    renderView();
    return item;
  }

  function renderListItems(container, lists) {
    container.textContent = '';
    if (!lists || lists.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'oc-list-empty';
      empty.textContent = i18n.noSavedLists;
      container.appendChild(empty);
      return;
    }
    var sorted = lists.slice().sort(compareListsNewestFirst);
    sorted.forEach(function (list) {
      container.appendChild(buildListItem(list));
    });
  }

  // Shared between buildListsPanel's own 'input' listener and renderChipRow (oculist-l6m.26
  // fix-pass): main-bar chip edits (add/remove) never touched the popover before, so the
  // Save button's disabled state could go stale in *either* direction while the popover
  // stayed open — not just enabled-when-it-should-be-disabled (the click-handler re-check
  // above guards that), but disabled-when-it-should-be-enabled too, with no recovery short
  // of retyping the name or closing/reopening the popover. Queries listsPanel by selector
  // rather than closing over buildListsPanel's local saveInput/saveBtn so it can be called
  // from outside that closure.
  function updateSaveBtnDisabled() {
    if (!listsPanel) return;
    var saveInput = listsPanel.querySelector('.oc-list-save-input');
    var saveBtn = listsPanel.querySelector('.oc-list-save-btn');
    if (!saveInput || !saveBtn) return;
    saveBtn.disabled = saveInput.value.trim() === '' || workListTerms.length === 0;
  }

  function buildListsPanel() {
    var p = P();

    listsPanel = document.createElement('div');
    listsPanel.id = 'oc-lists-panel';
    listsPanel.setAttribute('role', 'dialog');
    listsPanel.setAttribute('aria-label', i18n.listsBtnTitle);
    listsPanel.tabIndex = -1;

    var saveRow = document.createElement('div');
    saveRow.className = 'oc-list-save-row';

    var saveInput = document.createElement('input');
    saveInput.type = 'text';
    saveInput.className = 'oc-list-save-input';
    saveInput.placeholder = i18n.saveListPlaceholder;
    saveInput.maxLength = 100;
    saveInput.setAttribute('aria-label', i18n.saveListPlaceholder);

    var saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'oc-list-save-btn';
    saveBtn.textContent = i18n.saveListBtn;
    saveBtn.setAttribute('aria-label', i18n.saveListBtn);
    // Inherited obligation (oculist-l6m.8 review): saveList() rejects a blank/whitespace-
    // only name SILENTLY. Disabled-by-default plus the live 'input' listener below means
    // the confirm control can never be pressed into that silent no-op. oculist-l6m.26
    // extends the same treatment to an empty working list: saveList() also silently
    // rejects zero terms, so the button must also stay disabled whenever workListTerms
    // is empty, not just whenever the name field is blank.
    saveBtn.disabled = true;

    saveInput.addEventListener('input', updateSaveBtnDisabled);
    saveInput.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter' && !saveBtn.disabled) {
        e.preventDefault();
        saveBtn.click();
      }
    });

    saveBtn.addEventListener('click', function () {
      var name = saveInput.value;
      // workListTerms.length === 0 is re-checked here as belt-and-braces: renderChipRow()
      // now calls updateSaveBtnDisabled() on every chip add/remove while the popover is
      // open, so the disabled attribute should already be current. This guard just avoids
      // an unnecessary round trip if it somehow isn't, and keeps the click a true no-op
      // rather than a click that goes nowhere visibly. saveList() itself would reject an
      // empty terms array anyway ('empty-terms', silent).
      if (name.trim() === '' || workListTerms.length === 0) return;
      saveList(name, workListTerms, function (result) {
        // 'cap' and 'write-failed' already show their own notice via saveList(); leave
        // the input populated either way so the user can retry (e.g. after freeing up a
        // slot) without retyping the name. 'empty-name'/'empty-terms'/'exception' can't
        // surface here (both the name and the working list are validated above and the
        // button is disabled on either being empty) but are handled the same, doing
        // nothing further.
        if (result && result.ok) {
          refreshListsPanel();
        }
      });
    });

    saveRow.appendChild(saveInput);
    saveRow.appendChild(saveBtn);
    listsPanel.appendChild(saveRow);

    var divider = document.createElement('div');
    divider.className = 'oc-list-divider';
    listsPanel.appendChild(divider);

    var listContainer = document.createElement('div');
    listContainer.className = 'oc-list-items';
    listsPanel.appendChild(listContainer);

    wrapRoot.appendChild(listsPanel);

    listSavedLists(function (lists) {
      // A rapid close before this async read lands would already have torn listsPanel
      // down — skip a stale render into a detached container.
      if (!listsPanel) return;
      renderListItems(listContainer, lists);
    });

    // 'full' is the only motion level the settings panel's own entrance animation runs
    // under too in spirit — 'reduced' and 'off' both suppress it here, matching
    // effectiveMotion()'s two-tier gate used elsewhere (chip row, beacons).
    if (effectiveMotion() === 'full') {
      listsPanel.animate([
        { opacity: 0, transform: p.isBottom ? 'translateY(8px)' : 'translateY(-8px)' },
        { opacity: 1, transform: 'translateY(0)' }
      ], {
        duration: 180,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
        fill: 'forwards'
      });
    }
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

  var ICON_CHARS = { up: '↑', down: '↓', replay: '↺', gear: '⚙', close: '✕', list: '☰' };

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
        // Rule 1: a non-empty input is a draft that owns searchRanges/the active
        // highlight. Rule 4: an emptied input hands ownership back to whichever chip was
        // active before the draft started (oculist-l6m.5).
        if (term) {
          performDraftSearch(term);
          if (searchRanges.length > 0) {
            activeIndex = 0;
            highlightActiveRange(false);
          }
        } else {
          restoreActiveChip();
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

    // aria-haspopup="dialog" + a live aria-expanded (oculist-l6m.27) signal that these two
    // buttons open a role="dialog" panel and whether it is currently open — kept identical
    // between the two since they are the same interaction pattern. aria-expanded itself is
    // flipped by open/closeListsMenu() and open/closeSettings(), never set again here.
    listsBtn = makeIconBtn('list', i18n.listsBtnTitle);
    listsBtn.setAttribute('aria-haspopup', 'dialog');
    listsBtn.setAttribute('aria-expanded', 'false');
    listsBtn.addEventListener('click', toggleListsMenu);

    gearBtn = makeIconBtn('gear', i18n.optionsTitle);
    gearBtn.setAttribute('aria-haspopup', 'dialog');
    gearBtn.setAttribute('aria-expanded', 'false');
    gearBtn.addEventListener('click', toggleSettings);

    closeBtn = makeIconBtn('close', i18n.closeTitle);
    closeBtn.addEventListener('click', window.__ocDestroy);

    setNavEnabled(false);

    bar.appendChild(input);
    bar.appendChild(countEl);
    bar.appendChild(prevBtn);
    bar.appendChild(nextBtn);
    bar.appendChild(replayBtn);
    bar.appendChild(listsBtn);
    bar.appendChild(gearBtn);
    bar.appendChild(closeBtn);

    wrapRoot.appendChild(bar);

    chipRow = document.createElement('div');
    chipRow.className = 'oc-chip-row';
    // Hidden until a real term list renders — an empty working list must be pixel-
    // identical to the overlay before this bead existed.
    chipRow.hidden = true;
    chipRow.style.display = 'none';
    wrapRoot.appendChild(chipRow);

    document.body.appendChild(wrap);
    input.focus();

    // Restore any working list carried over from a previous mount in this tab. This must
    // never trigger a search — carry-over to a new page/mount is deliberately manual, so
    // only workListTerms/activeTermIndex and the chip DOM are touched here.
    loadWorkList(function (list) {
      // A rapid close before this callback lands would have already torn wrapRoot/chipRow
      // down; __ocDestroy() also resets workListTerms/activeTermIndex, so skip stale data.
      if (!wrapRoot || !chipRow) return;
      workListTerms = list.terms;
      activeTermIndex = list.activeIndex;
      // No scan has run against this term set yet, so termRanges must not carry over any
      // stale entries from before this mount — see the "every writer of activeTermIndex"
      // note in performListSearch() for the invariant this upholds without scanning.
      termRanges = [];
      termStarved = [];
      renderChipRow();
    });
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

  // WCAG 2.2 SC 1.4.11 (non-text contrast) relative-luminance formula: sRGB channels are
  // linearized, then combined with the standard luminance weights.
  function relativeLuminance(rgb) {
    var srgb = rgb.map(function (v) {
      var c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
  }

  function contrastRatio(rgbA, rgbB) {
    var lA = relativeLuminance(rgbA);
    var lB = relativeLuminance(rgbB);
    var lighter = Math.max(lA, lB);
    var darker = Math.min(lA, lB);
    return (lighter + 0.05) / (darker + 0.05);
  }

  function hexToRgbArray(hex) {
    var c = hex.substring(1);
    if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
    var rgb = parseInt(c, 16);
    return [(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff];
  }

  // Blends matchColor at the dim wash's alpha over bgRgb (simple alpha compositing —
  // matches what `background-color: rgba(...)` actually renders on top of an opaque page
  // background). Falls back to the same amber hexToRgba() falls back to, so an unset
  // matchColor measures consistently with what would actually be painted.
  function blendOverBackground(hex, alpha, bgRgb) {
    var rgb = hex ? hexToRgbArray(hex) : [245, 158, 11];
    return [
      alpha * rgb[0] + (1 - alpha) * bgRgb[0],
      alpha * rgb[1] + (1 - alpha) * bgRgb[1],
      alpha * rgb[2] + (1 - alpha) * bgRgb[2]
    ];
  }

  function parseComputedColor(str) {
    if (!str) return null;
    if (str === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    var m = str.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\s*\)$/);
    if (!m) return null;
    return { r: parseFloat(m[1]), g: parseFloat(m[2]), b: parseFloat(m[3]), a: m[4] !== undefined ? parseFloat(m[4]) : 1 };
  }

  // Oculist highlights text on arbitrary host pages, so there is no single background it
  // can know for certain — a match's actual ancestor background can differ per element,
  // and walking each highlighted range's own ancestor chain would be per-range work on
  // pages with thousands of matches. Instead this takes one cheap, page-level reading:
  // <body>'s computed background, falling through to <html>'s, and finally to white if
  // both are transparent/unresolvable (matching how an unstyled page actually renders).
  // LIMITATION: pages where the matched text sits on a differently-coloured container
  // (a dark card on a light page, or vice versa) are measured against the wrong swatch.
  // This is still a real limitation, but as of oculist-32d it only affects the alpha-wash
  // measurement below (used to gate whether the dim treatment gets to keep matchColor's
  // hue) — the dotted-underline path it can fall back to is painted in currentColor, so it
  // inherits each element's own text-vs-background contrast and needs no measurement here.
  function getPageBackgroundRgb() {
    try {
      var candidates = [document.body, document.documentElement];
      for (var i = 0; i < candidates.length; i++) {
        var el = candidates[i];
        if (!el) continue;
        var parsed = parseComputedColor(window.getComputedStyle(el).backgroundColor);
        if (parsed && parsed.a > 0) return [parsed.r, parsed.g, parsed.b];
      }
    } catch (e) {
      // getComputedStyle can throw in detached/foreign-document edge cases; fall through.
    }
    return [255, 255, 255];
  }

  // Live (not cached across calls) the same way reducedMotionQuery is: matchMedia's
  // .matches is itself O(1) to read, so there is no cost to checking it fresh each time
  // injectHighlightStyles() runs rather than snapshotting it once at load.
  var prefersMoreContrastQuery = window.matchMedia
    ? window.matchMedia('(prefers-contrast: more)')
    : null;

  // oculist-cvg: dimIsHighContrast (below, inside injectHighlightStyles()) reads
  // .matches at inject time and bakes the result into the dimHighlightCss it writes into
  // the shared <style id="oc-global-highlight-styles"> element. Without this listener, a
  // prefers-contrast flip mid-session left the dim treatment on whichever branch (wash vs
  // underline) was resolved at the last inject. Registered once here, at module scope —
  // see colorSchemeQuery above and __ocDestroy() below for why it is intentionally not
  // removed there.
  if (prefersMoreContrastQuery) {
    prefersMoreContrastQuery.addEventListener('change', function () {
      injectHighlightStyles();
    });
  }

  // WCAG 2.2 SC 1.4.11 non-text contrast minimum. Below this, the dotted-underline
  // treatment (oculist-l6m.17) is used instead of the alpha wash regardless of vision
  // profile name — see dimHighlightCss below.
  var DIM_CONTRAST_THRESHOLD = 3;

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

    // oculist-32d: the dim treatment has two branches, and only one of them still needs a
    // contrast measurement.
    //
    // The underline branch is painted in `currentColor`, i.e. the host element's own text
    // colour, not matchColor. `::highlight()` resolves `currentColor` per element, so this
    // inherits whatever contrast the page already has against its own background — a page
    // that failed that contrast would already be unreadable on its own terms. That branch
    // is readable by construction and needs no gate.
    //
    // The wash branch still paints matchColor (a currentColor wash would paint dark text
    // dark-on-dark, so it can't adopt the same trick), and a translucent matchColor wash
    // shifts lightness/saturation but not hue, so it never introduces a colour-blind
    // confusion — but a pale matchColor (tritanopia's #ffcbd1, or any pale custom colour)
    // blends to near-invisible against a light page background (oculist-l6m.17). The gate
    // below measures the ACTUAL blended wash colour's contrast against the page background;
    // its job is "does the wash read well enough to be worth using for its hue", and if not,
    // fall back to the underline, which is readable regardless of the measurement. This also
    // means every built-in profile (whose matchColor is always pale, by design, so it reads
    // as a highlight rather than solid text) fails this gate on every background and always
    // takes the underline branch — expected, not a bug. The wash survives only for custom
    // colours saturated/dark enough to clear 3:1 on their own. Also falls back to the
    // underline whenever the OS/browser signals prefers-contrast: more.
    var dimPageBgRgb = getPageBackgroundRgb();
    var dimBlendedRgb = blendOverBackground(matchColor, 0.35, dimPageBgRgb);
    var dimContrastRatio = contrastRatio(dimBlendedRgb, dimPageBgRgb);
    var dimPrefersMoreContrast = !!(prefersMoreContrastQuery && prefersMoreContrastQuery.matches);
    var dimIsHighContrast = dimContrastRatio < DIM_CONTRAST_THRESHOLD || dimPrefersMoreContrast;
    // Edge case (documented, not handled): text styled `color: transparent` (visually-hidden
    // text, legacy image-replacement techniques) yields a transparent `currentColor`
    // underline here, i.e. an invisible dim mark for that element. The highlight rule is
    // global CSS shared by every dim match on the page, so there is no per-range branch
    // available without splitting the highlight registry per element's computed colour,
    // which would be disproportionate to a rare edge case on text that is itself already
    // invisible to sighted users. Accepted as a known limitation.
    var dimHighlightCss = dimIsHighContrast
      ? '::highlight(oculist-dim-match) { text-decoration-line: underline; text-decoration-style: dotted; text-decoration-color: currentColor; text-decoration-thickness: 2px; }'
      : '::highlight(oculist-dim-match) { background-color: ' + hexToRgba(matchColor, 0.35) + '; }';

    var highlightCss = [
      designTokensCss,
      '::highlight(oculist-match) { background-color: ' + matchColor + '; color: ' + matchTextColor + '; }',
      '::highlight(oculist-active-match) { background-color: ' + activeColor + '; color: ' + activeTextColor + '; }',
      dimHighlightCss,
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
      // oculist-6cd: .oc-bar's own rendered height, used below to cap #oc-settings-panel's
      // max-height to whatever's left of the viewport once the bar is accounted for. Not
      // measured live off the real `bar` element — the very first injectHighlightStyles()
      // call of a session runs *before* this same CSS (specifically the '.oc-bar button'
      // rule below, which pins the bar's tallest child to a fixed 26px) has ever been
      // attached to the shadow root, so a live getBoundingClientRect() read here would
      // measure the *unstyled* bar (an unstyled div of default-sized form controls, ~22px)
      // and bake that too-small number into the stylesheet for the rest of the session.
      // 44px is a fixed, deterministic upper bound instead: 6px + 6px .oc-bar padding + the
      // 26px fixed height '.oc-bar button' sets below (font-size/DPI/OS-independent, unlike
      // the bar's own text/line-height) + :host's own 1px top + 1px bottom border, rounded
      // up a few px for cross-platform subpixel-rounding safety.
      var barChromePx = 44;

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
        '  --oc-chip-scale: ' + getChipScale() + ';',
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
        '  background-color: ' + (activeTheme === 'dark' ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)') + ';',
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
        // Same trick as .oc-notice: width:0 keeps the panel out of the shadow host's
        // intrinsic width so opening Settings cannot widen the bar, and min-width:100%
        // then fills whatever width the bar settled on. Without it the panel's own
        // horizontal padding was added on top of a content box already as wide as the
        // bar, so the whole popover jumped ~33px.
        '  width: 0;',
        '  min-width: 100%;',
        // oculist-6cd: the panel's own intrinsic height (header + grid content) had no cap,
        // so on short viewports the whole host (bar + this panel, both position: fixed with
        // no scrollable ancestor per :host's overflow: hidden above) grew past the viewport
        // with no way to reach the clipped end — top-anchored bars (tl/tr) lost the footer,
        // bottom-anchored bars (bl/br) pushed the header (and the bar itself) above y=0
        // instead, since a bottom-anchored host grows upward. This predates oculist-dvt's
        // effect-list growth (oculist-dvt.5 capped .oc-radio-list, one level down, for the
        // same underlying reason) and is independent of effect-registry size entirely.
        // Capping this panel at 100vh minus the bar's own chrome (barChromePx, above) keeps
        // panel + bar together within the viewport regardless of which of the four positions
        // is active — the same numeric cap applies to all four since the bar's contribution
        // to total host height does not depend on which edge it is anchored to.
        '  max-height: calc(100vh - ' + barChromePx + 'px);',
        '  overflow-y: auto;',
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
        // oculist-6cd: #oc-settings-panel is now itself a bounded scroll container (max-
        // height/overflow-y above). Flex items shrink to fit their container by default
        // (flex-shrink: 1) — without this the header would get visually squashed instead of
        // the panel actually overflowing and scrolling, the same failure oculist-dvt.5 found
        // for .oc-radio-item one level down.
        '  flex-shrink: 0;',
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
        '  text-transform: uppercase;',
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
        // oculist-6cd: same flex-shrink: 0 rationale as .oc-settings-header above — keeps
        // the grid (and the effect list/footer content inside it) at natural height so the
        // panel overflows and scrolls instead of squashing this content to fit.
        '  flex-shrink: 0;',
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
        // oculist-dvt.5: the effect list grew from 9 to 13 rows and its intrinsic height
        // (no cap before this) was growing the whole settings panel past short viewports,
        // with no scroll mechanism anywhere in the panel to reach the clipped rows. Capping
        // and scrolling just this list (same idiom as #oc-lists-panel's
        // max-height/overflow-y above) keeps every effect row keyboard- and
        // scroll-reachable regardless of registry size, without touching selection
        // semantics or the rebuild path.
        '  max-height: 220px;',
        '  overflow-y: auto;',
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
        // oculist-dvt.5: .oc-radio-list is a flex column with a max-height (above). Flex
        // items shrink to fit their container by default (flex-shrink: 1), so without this
        // the 13 rows were being visually squashed down to fit inside max-height instead of
        // overflowing it — no scrollbar ever appeared and every row's own height shrank.
        // flex-shrink: 0 keeps each row at its natural height so the list can actually
        // overflow and scroll.
        '  flex-shrink: 0;',
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
        '  align-items: flex-start;',
        '  gap: 8px;',
        '  padding: 6px 10px;',
        // ponytail: width:0 keeps the notice out of the shadow host's intrinsic
        // width so it can't stretch the bar; min-width:100% then fills whatever
        // width the bar settled on, and the text wraps inside it.
        '  width: 0;',
        '  min-width: 100%;',
        '  box-sizing: border-box;',
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
        '}',
        '.oc-chip-row {',
        '  display: flex;',
        '  flex-wrap: wrap;',
        '  align-items: center;',
        '  gap: 6px;',
        '  padding: 6px 10px;',
        // Same trick as .oc-notice / #oc-settings-panel: width:0 keeps the row out of the
        // shadow host's intrinsic width so it cannot stretch the bar; min-width:100% then
        // fills whatever width the bar settled on.
        '  width: 0;',
        '  min-width: 100%;',
        '  box-sizing: border-box;',
        '  background: ' + t.bg + ';',
        '  border-top: 1px solid ' + t.divider + ';',
        '}',
        '.oc-chip-row[hidden] {',
        '  display: none;',
        '}',
        '.oc-chip {',
        '  display: inline-flex;',
        '  align-items: center;',
        '  gap: 4px;',
        '  border-radius: calc(10px * var(--oc-chip-scale, 1));',
        '  background: var(--oc-input-bg);',
        '  border: 1px solid var(--oc-input-border);',
        '  padding: calc(2px * var(--oc-chip-scale, 1)) calc(6px * var(--oc-chip-scale, 1));',
        '  box-sizing: border-box;',
        '  max-width: 100%;',
        '}',
        '.oc-chip-term {',
        '  color: var(--oc-text);',
        '  background: none;',
        '  border: none;',
        '  padding: 0;',
        '  margin: 0;',
        '  font-size: calc(12px * var(--oc-chip-scale, 1));',
        '  font-family: system-ui, -apple-system, sans-serif;',
        '  font-weight: 500;',
        '  cursor: pointer;',
        '  max-width: 160px;',
        '  overflow: hidden;',
        '  text-overflow: ellipsis;',
        '  white-space: nowrap;',
        '  transition: color 150ms, transform 150ms;',
        '  box-shadow: none;',
        '  width: auto;',
        '  height: auto;',
        '  min-width: 0;',
        '  min-height: 0;',
        '  max-height: none;',
        '  line-height: 1.3;',
        '  border-radius: 0;',
        '}',
        '.oc-chip-term:hover, .oc-chip-term:focus-visible {',
        '  color: ' + t.accent + ';',
        '}',
        '.oc-chip-term.active {',
        '  color: ' + t.accent + ';',
        '  font-weight: 700;',
        '}',
        '.oc-chip-count {',
        '  font-size: calc(10px * var(--oc-chip-scale, 1));',
        '  color: ' + t.subtle + ';',
        '  opacity: 0.7;',
        '  white-space: nowrap;',
        '  font-family: system-ui, -apple-system, sans-serif;',
        '  user-select: none;',
        '}',
        '.oc-chip-remove {',
        '  color: ' + t.text + ';',
        '  background: none;',
        '  border: none;',
        '  padding: 0;',
        '  margin: 0;',
        '  font-size: calc(10px * var(--oc-chip-scale, 1));',
        '  width: calc(14px * var(--oc-chip-scale, 1));',
        '  height: calc(14px * var(--oc-chip-scale, 1));',
        '  min-width: 0;',
        '  min-height: 0;',
        '  max-width: none;',
        '  max-height: none;',
        '  display: inline-flex;',
        '  align-items: center;',
        '  justify-content: center;',
        '  cursor: pointer;',
        '  border-radius: 50%;',
        '  opacity: 0.6;',
        '  line-height: 1;',
        '  box-shadow: none;',
        '  transition: opacity 150ms, background-color 150ms, transform 150ms;',
        '}',
        '.oc-chip-remove:hover {',
        '  opacity: 1;',
        '  background-color: ' + (activeTheme === 'dark' ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)') + ';',
        '}',
        // effectiveMotion() !== 'full' (i.e. 'reduced' or 'off') suppresses chip
        // transitions entirely, same two-tier gate used elsewhere for beacon motion.
        '.oc-chip.oc-no-motion .oc-chip-term, .oc-chip.oc-no-motion .oc-chip-remove {',
        '  transition: none;',
        '}',
        // ── List menu popover (oculist-l6m.9) ──────────────────────────────────
        '#oc-lists-panel {',
        '  background: var(--oc-panel-bg);',
        '  padding: 10px 12px;',
        '  display: flex;',
        '  flex-direction: column;',
        '  gap: 8px;',
        '  box-sizing: border-box;',
        // Same trick as #oc-settings-panel: width:0 keeps the popover out of the shadow
        // host's intrinsic width so it cannot stretch the bar; min-width:100% then fills
        // whatever width the bar settled on.
        '  width: 0;',
        '  min-width: 100%;',
        '  max-height: 320px;',
        '  overflow-y: auto;',
        '  box-sizing: border-box;',
        '}',
        ':host(.is-bottom) #oc-lists-panel {',
        '  border-bottom: 1px solid var(--oc-divider);',
        '}',
        ':host(.is-top) #oc-lists-panel {',
        '  border-top: 1px solid var(--oc-divider);',
        '}',
        '.oc-list-save-row {',
        '  display: flex;',
        '  gap: 6px;',
        '  align-items: center;',
        '}',
        'input.oc-list-save-input, input.oc-list-rename-input {',
        '  flex: 1;',
        '  border: 1px solid var(--oc-input-border);',
        '  border-radius: 6px;',
        '  background: var(--oc-input-bg);',
        '  color: var(--oc-input-text);',
        '  padding: 4px 8px;',
        '  font-size: 13px;',
        '  font-family: system-ui, -apple-system, sans-serif;',
        '  outline: none;',
        '  box-sizing: border-box;',
        '  margin: 0;',
        '  height: auto;',
        '  min-width: 0;',
        '  transition: border-color 150ms, box-shadow 150ms;',
        '}',
        'input.oc-list-save-input:focus, input.oc-list-rename-input:focus {',
        '  border-color: var(--oc-accent);',
        '  box-shadow: 0 0 0 2px var(--oc-accent-alpha);',
        '}',
        '.oc-list-save-btn {',
        '  flex-shrink: 0;',
        '  background: var(--oc-btn-active-bg);',
        '  color: var(--oc-btn-active-text);',
        '  font-size: 12px;',
        '  font-weight: 600;',
        '  padding: 5px 10px;',
        '  border-radius: 6px;',
        '  width: auto;',
        '  height: auto;',
        '  min-width: 0;',
        '  min-height: 0;',
        '  max-width: none;',
        '  max-height: none;',
        '  box-shadow: none;',
        '}',
        '.oc-list-divider {',
        '  height: 1px;',
        '  background: var(--oc-divider);',
        '  flex-shrink: 0;',
        '}',
        '.oc-list-items {',
        '  display: flex;',
        '  flex-direction: column;',
        '  gap: 4px;',
        '}',
        '.oc-list-empty {',
        '  font-size: 12px;',
        '  color: var(--oc-subtle);',
        '  opacity: 0.75;',
        '  padding: 4px 2px;',
        '  font-family: system-ui, -apple-system, sans-serif;',
        '}',
        '.oc-list-item {',
        '  display: flex;',
        '  align-items: center;',
        '  gap: 6px;',
        '  padding: 4px 2px;',
        '  border-radius: 6px;',
        '}',
        '.oc-list-item:hover {',
        '  background: var(--oc-btn-hover-bg);',
        '}',
        '.oc-list-item-name {',
        '  flex: 1;',
        '  text-align: left;',
        '  color: var(--oc-text);',
        '  background: none;',
        '  border: none;',
        '  padding: 2px 4px;',
        '  font-size: 13px;',
        '  font-weight: 500;',
        '  font-family: system-ui, -apple-system, sans-serif;',
        '  cursor: pointer;',
        '  overflow: hidden;',
        '  text-overflow: ellipsis;',
        '  white-space: nowrap;',
        '  width: auto;',
        '  height: auto;',
        '  min-width: 0;',
        '  min-height: 0;',
        '  max-width: none;',
        '  max-height: none;',
        '  box-shadow: none;',
        '  justify-content: flex-start;',
        '}',
        '.oc-list-item-name:hover, .oc-list-item-name:focus-visible {',
        '  color: ' + t.accent + ';',
        '}',
        '.oc-list-item-count {',
        '  font-size: 11px;',
        '  color: ' + t.subtle + ';',
        '  opacity: 0.7;',
        '  flex-shrink: 0;',
        '  white-space: nowrap;',
        '  font-family: system-ui, -apple-system, sans-serif;',
        '  user-select: none;',
        '}',
        '.oc-list-rename-btn, .oc-list-delete-btn, .oc-list-rename-confirm, .oc-list-rename-cancel {',
        '  flex-shrink: 0;',
        '  width: 22px;',
        '  height: 22px;',
        '  min-width: 22px;',
        '  min-height: 22px;',
        '  max-width: 22px;',
        '  max-height: 22px;',
        '  font-size: 11px;',
        '  border-radius: 50%;',
        '  opacity: 0.7;',
        '}',
        '.oc-list-rename-btn:hover, .oc-list-delete-btn:hover, .oc-list-rename-confirm:hover, .oc-list-rename-cancel:hover {',
        '  opacity: 1;',
        '  background-color: ' + (activeTheme === 'dark' ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)') + ';',
        '}',
        '.oc-list-rename-confirm:disabled, .oc-list-save-btn:disabled {',
        '  opacity: 0.4;',
        '  cursor: default;',
        '}',
        '.oc-list-item-editing {',
        '  align-items: center;',
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
      // A detached wrap means an SPA swapped the body out from under us. Tear the stale
      // state down first so this reads as "closed" and the branch below rebuilds it,
      // instead of toggling an element that is no longer in the document.
      if (wrap && !wrap.isConnected) window.__ocDestroy();
      if (wrap) {
        window.__ocDestroy();
      } else {
        buildUI();
        injectHighlightStyles();
        startDomObserver();
        checkSiteOverride(false);
        window.addEventListener('scroll', handleScroll, { passive: true });
        window.addEventListener('resize', handleResize, { passive: true });
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
      // Our own writes echo back here. Rebuilding the panel on that echo detaches the
      // live <input type="color">, dismissing the native colour dialog mid-interaction.
      // Drop the matching entry and everything queued before it — a coalesced write can
      // swallow the earlier echoes, and those are stale by definition. Applying an echo's
      // values is skipped too: for our own write memory is already current or newer, so
      // copying an older payload back in would undo the most recent pick.
      var echo = stableStringify(nv);
      var selfIndex = pendingSelfWrites.indexOf(echo);
      if (selfIndex !== -1) {
        pendingSelfWrites.splice(0, selfIndex + 1);
        return;
      }

      var changed = false;
      var performanceModeChanged = false;
      // Only these keys feed drawActiveOverlays()/getEffectiveColors(): visionSettings
      // carries magnifier/textLabels/borderStyle/colorPalette/customColors/motionSensitivity,
      // and matchColor/activeColor/beaconColor are the 'default' palette's own colours.
      // Everything else in SETTINGS_KEYS (disabledSites, effect, position, theme,
      // scrollBehavior, performanceMode, visionProfile, ...) is either handled by its own
      // branch below or never read by the active-match overlays, so redrawing on it would
      // just be unnecessary DOM churn on an unrelated change.
      var OVERLAY_AFFECTING_KEYS = { visionSettings: 1, matchColor: 1, activeColor: 1, beaconColor: 1 };
      var overlaysAffected = false;
      SETTINGS_KEYS.forEach(function(k) {
        if (!(k in nv)) return;
        if (stableStringify(nv[k]) !== stableStringify(settings[k])) {
          changed = true;
          if (k === 'performanceMode') performanceModeChanged = true;
          if (OVERLAY_AFFECTING_KEYS[k]) overlaysAffected = true;
        }
        settings[k] = nv[k];
      });
      if (!changed) return;
      if (!Array.isArray(settings.disabledSites)) settings.disabledSites = [];
      if (!effectsRegistry[settings.effect]) settings.effect = 'hud';
      if (settings.disabledSites.indexOf(window.location.hostname) !== -1 && wrap) {
        window.__ocDestroy();
      } else {
        injectHighlightStyles();
        // The overlay may be closed (wrap null) when a settings change lands from another
        // context (popup, another tab, or a direct storage write) — applyWrapPosition()
        // dereferences wrap unconditionally, so skip it until the overlay is reopened.
        // `settings` above is already updated regardless, so reopening picks up the
        // change via buildUI() -> applyWrapPosition() on its own.
        if (wrap) {
          applyWrapPosition();
          updateViewportMarkers();
          // Placed after applyWrapPosition()/updateViewportMarkers() (geometry unrelated to
          // the active-match overlays anyway) but still inside this `if (wrap)` guard, since
          // repositionActiveOverlays() redraws the border/label/magnifier for whatever match
          // is currently active — without this, flipping the magnifier or Match Labels
          // toggle left the on-screen match showing the stale overlay state until the next
          // navigation or redraw (oculist-l6m.42). repositionActiveOverlays() already
          // no-ops safely when there is no active match (activeIndex out of range) or the
          // match's rect collapses to zero size, so gating on overlaysAffected here is only
          // about not doing needless work on unrelated settings changes, not about safety.
          if (overlaysAffected) {
            repositionActiveOverlays();
          }
        }
        if (settingsPanel) {
          rebuildSettingsPanelPreservingFocus();
        }
        // Toggling Lite Mode changes both which terms get Ranges (and thus counts) and
        // whether oculist-dim-match gets built at all (oculist-l6m.7) — a working list
        // that is already on screen has to be rescanned immediately, or its dim
        // highlights/counts stay stuck showing the mode that was active when it was last
        // scanned instead of the one now in effect.
        if (performanceModeChanged && workListTerms.length > 0) {
          performListSearch();
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
