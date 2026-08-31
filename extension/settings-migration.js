// settings-migration.js — oculist-rnr.12's single canonical settings-migration module.
//
// content.js, popup.js, and welcome.js each read and write the 'oc-settings' object in
// chrome.storage.sync independently. Every one of those three surfaces must normalise a
// stored settings object away from clinical vocabulary before using it and before writing
// it back — three copies of that logic is how it drifts, so this file is the one place it
// lives: both the mapping tables below AND the normalisation logic that uses them (oculist-
// rnr.16 — popup.js and welcome.js used to keep their own verbatim/trimmed copies of
// LEGACY_DISPLAY_PRESET_MAP; they now reference this module's export directly instead).
// content.js is manifest-injected (see extension/manifest.json's content_scripts), so this
// file is listed there *before* content.js and the two run in the same isolated world,
// sharing this module's global. popup.html and welcome.js load it as an ordinary <script>
// tag before their own script, sharing the page's global instead.
//
// Legacy fields this normalises:
//   - 'visionProfile' (a clinical label, e.g. 'color-blind-deuteranopia') -> 'displayPreset'
//     (a functional rendering key). The legacy field is always deleted. If 'displayPreset'
//     is already present, it wins and the legacy value is discarded unused — a fresh user
//     choice must never be reverted by a stale legacy field a not-yet-updated surface
//     re-persisted (oculist-rnr.12 review gap 2). Only when 'displayPreset' is entirely
//     absent does the legacy value get translated and used.
//   - 'visionSettings.colorPalette' clinical values ('deuteranopia'/'protanopia'/
//     'tritanopia') -> their functional replacements. The field name itself never changed,
//     so this is a value-only rewrite, not a presence/absence one.
(function () {
  'use strict';

  // Frozen (oculist-rnr.22): this table is exported and aliased by reference elsewhere
  // (popup.js's LEGACY_TO_FUNCTIONAL_PRESET) — freezing keeps any future write through an
  // alias from silently corrupting the canonical copy that content.js also reads.
  // Object.freeze() is shallow — this is sufficient today because every value here is a
  // string (freezing already blocks reassigning any key), but it stops protecting the
  // instant a value here ever becomes an object of its own (a nested write wouldn't be
  // caught). Not deep-frozen pre-emptively (oculist-rnr.24): there is no such value today,
  // and a deep-freeze helper for a hazard that doesn't exist yet is speculative machinery.
  // Revisit if a value here ever stops being a plain string.
  var LEGACY_DISPLAY_PRESET_MAP = Object.freeze({
    'low-vision': 'high-contrast',
    'color-blind-deuteranopia': 'rg-adjust-deut',
    'color-blind-protanopia': 'rg-adjust-prot',
    'color-blind-tritanopia': 'by-adjust',
    'eye-strain': 'reduced-motion',
    'custom': 'custom'
  });

  // Frozen for the same reason as LEGACY_DISPLAY_PRESET_MAP above.
  var LEGACY_COLOR_PALETTE_MAP = Object.freeze({
    'deuteranopia': 'amber-sky',
    'protanopia': 'amber-indigo',
    'tritanopia': 'rose-cyan'
  });

  // Maps a legacy visionProfile value to its functional displayPreset equivalent. Any
  // value not in the table (including null/undefined, or an unrecognized string) maps to
  // null rather than throwing — covers both "never ran the wizard" and "mid-wizard" users,
  // and any stray/corrupt legacy value.
  function mapLegacyDisplayPreset(legacyValue) {
    if (legacyValue == null) return null;
    return Object.prototype.hasOwnProperty.call(LEGACY_DISPLAY_PRESET_MAP, legacyValue)
      ? LEGACY_DISPLAY_PRESET_MAP[legacyValue]
      : null;
  }

  // Maps a legacy colorPalette value to its functional equivalent. Anything not in the
  // table (including 'default'/'warm'/'custom', null/undefined, or an unrecognized string)
  // is returned unchanged.
  function mapLegacyColorPalette(value) {
    return Object.prototype.hasOwnProperty.call(LEGACY_COLOR_PALETTE_MAP, value)
      ? LEGACY_COLOR_PALETTE_MAP[value]
      : value;
  }

  // Normalises a stored 'oc-settings' object IN PLACE and returns true if it changed
  // anything (the caller's cue to persist the correction), false if the object was already
  // clean. Must be called on the object exactly as read from chrome.storage.sync — before
  // it's merged into any in-memory defaults object that might itself already declare a
  // 'displayPreset' key, which would make a presence check meaningless.
  function normalizeOcSettings(settings) {
    if (!settings || typeof settings !== 'object') return false;
    var changed = false;

    if (Object.prototype.hasOwnProperty.call(settings, 'visionProfile')) {
      // New field wins if both are present; legacy is discarded unused either way.
      if (!Object.prototype.hasOwnProperty.call(settings, 'displayPreset')) {
        settings.displayPreset = mapLegacyDisplayPreset(settings.visionProfile);
      }
      delete settings.visionProfile;
      changed = true;
    }

    if (
      settings.visionSettings &&
      typeof settings.visionSettings === 'object' &&
      Object.prototype.hasOwnProperty.call(LEGACY_COLOR_PALETTE_MAP, settings.visionSettings.colorPalette)
    ) {
      settings.visionSettings.colorPalette = mapLegacyColorPalette(settings.visionSettings.colorPalette);
      changed = true;
    }

    return changed;
  }

  // oculist-xvh: page-side writers (content.js's saveSettings(), popup.js's load-path
  // eager persist and its own saveSettings(), welcome.js's saveProfileAndFinish()) all
  // used to do a bare whole-object chrome.storage.sync.set() of their own in-memory
  // `settings`. Two hazards followed from that: (1) any two of these racing each other,
  // or racing background.js's updateSettings(), could silently drop a write with no
  // transient symptom — content.js's chrome.storage.onChanged handler guards per key
  // (`if (!(k in nv)) return;`), so a key a clobbering write erased just produces no
  // change entry, and an open tab keeps a stale in-memory value forever; (2) because the
  // write was of a surface's own in-memory settings, it also dropped any stored key that
  // surface does not itself model (content.js documents this above its own settings
  // object and works around it for its own single unmodelled key, seededDefaultBlocklist,
  // by round-tripping it through SETTINGS_KEYS — a per-surface patch, not a fix).
  //
  // rememberOcSettings()/writeOcSettings() below are the shared fix: every write is a
  // three-way merge (fresh stored state, this context's last-known base, this context's
  // in-memory settings) rather than a blind overwrite, with confirm-then-retry (the same
  // shape as background.js's updateSettings(), oculist-b65) layered on top so a write
  // landing between this context's own read and write is recomputed against instead of
  // clobbered. background.js's updateSettings() is left as-is (mutate-based, and already
  // correct for its own write sites) — two mechanisms solving the same problem two
  // different ways is fine here; converting it to this one is out of scope and adds risk.
  //
  // One remembered-base variable per JS context: each of the four contexts this file
  // loads into (service worker, popup, welcome page, content script) hosts exactly one
  // settings surface, so module-level state — not a factory — is the right shape.
  var lastKnownOcSettings = null;

  var MAX_SETTINGS_WRITE_ATTEMPTS = 3;

  // chrome.storage hands objects back with keys sorted alphabetically, while an in-memory
  // object may not be — a plain JSON.stringify would report a difference between two
  // identical values purely from key order. Sort keys at every level before comparing;
  // arrays keep their own order. content.js keeps its own copy of this idea (its own
  // stableStringify) rather than this file reaching into content.js for it, since this
  // file must not depend on content.js (popup.js/welcome.js load it independently).
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

  // Records a deep copy of what chrome.storage.sync's 'oc-settings' was last known to
  // hold, as the base writeOcSettings() below diffs this context's in-memory settings
  // against. Call this immediately after every read of 'oc-settings' this context does
  // (its boot read, and — handled internally by writeOcSettings() itself — after every
  // successful write of its own) and BEFORE normalizeOcSettings() or any other in-place
  // mutation touches the object, or the base would already reflect this context's own
  // not-yet-written local changes instead of what storage actually held. Accepts
  // null/undefined (no prior stored value) and records {} for that case.
  function rememberOcSettings(stored) {
    lastKnownOcSettings = JSON.parse(JSON.stringify(stored == null ? {} : stored));
  }

  // Three-way merges `local` (this context's in-memory settings) against the current
  // stored state `fresh`, using `base` (the last-known-stored snapshot) to tell an
  // intentional local change from a key this context simply hasn't touched:
  //   - a key whose value in `local` differs from `base` (including a key `base` never
  //     had at all) is a local change -> `local` wins, overwriting whatever `fresh` holds
  //     for it. This recovers a genuine local edit even when a concurrent writer has
  //     changed some OTHER key. Note it does NOT retire the whole-object-write
  //     unmodelled-key-drop hazard content.js:33 works around: a key this context does
  //     not model survives only while it is also absent from `base`. One already in
  //     storage at boot lands in `base`, misses `local`, and the deletion rule below
  //     removes it — so SETTINGS_KEYS must still carry every key any surface writes.
  //   - a key present in `base` but absent from `local` was deliberately deleted by this
  //     context -> the deletion propagates, even though `fresh` (or nothing) still has it.
  //   - every other key -> `fresh` wins unmodified, preserving a concurrent writer's value.
  //
  // `merged[k] = local[k]` below deep-copies rather than aliasing local[k] directly: a
  // shallow assignment would let `merged` share a nested object (e.g. visionSettings)
  // with `local`, and since `local` is the caller's own live, still-mutable settings
  // object, a LATER write in the same context (mutating that same nested object before
  // THIS write's async set() callback gets around to calling rememberOcSettings()) would
  // silently rewrite what this write's own remembered base ends up holding — corrupting
  // the base a subsequent overlapping writeOcSettings() call in this context diffs
  // against, and making a genuine local change on that nested key look like a no-op
  // (oculist-xvh review: reproduced via popup.js firing three saveSettings() calls in
  // quick succession — vision profile, colour palette, then a custom colour — where the
  // third write's own change was silently dropped by exactly this aliasing).
  function mergeOcSettings(fresh, base, local) {
    var merged = {};
    Object.keys(fresh).forEach(function (k) { merged[k] = fresh[k]; });
    Object.keys(local).forEach(function (k) {
      var baseHas = Object.prototype.hasOwnProperty.call(base, k);
      if (!baseHas || stableStringify(local[k]) !== stableStringify(base[k])) {
        // Only object-valued keys need the deep-copy (see the comment above) — a
        // primitive is already copied by value, and JSON.stringify(undefined) is the
        // literal undefined (not a string), which JSON.parse() would throw on.
        merged[k] = (local[k] !== null && typeof local[k] === 'object')
          ? JSON.parse(JSON.stringify(local[k]))
          : local[k];
      }
    });
    Object.keys(base).forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(local, k)) {
        delete merged[k];
      }
    });
    return merged;
  }

  // Writes `local` (a surface's in-memory 'oc-settings' object) to chrome.storage.sync as
  // a three-way merge (see mergeOcSettings() above) against the last-known base (see
  // rememberOcSettings()) and the freshly-read stored state, with confirm-then-retry on
  // top — the same shape as background.js's updateSettings() (oculist-b65) — so a write
  // landing between this function's own read and its write gets recomputed against
  // instead of clobbered.
  //
  // `done` (optional) fires exactly once: with the merged object actually written, or
  // with null if the write was abandoned (a failed initial read) or failed (a failed
  // set()). It is never wrapped in a try/catch that could reinterpret it throwing as a
  // failure of our own and call it again — if a caller-supplied `done` throws, that
  // throw propagates once and nothing here calls `done` a second time.
  // `onWillWrite` (optional) fires synchronously, exactly once, with the merged object
  // immediately before the chrome.storage.sync.set() call that writes it — content.js
  // uses this to record its self-write echo before the change event that write produces
  // can possibly fire. `attemptsLeft` is internal.
  //
  // ponytail: this narrows the write-loss window to the same residual gap
  // background.js's updateSettings() has, and no smaller — the span between the
  // confirming re-read below and the set() that follows it. A write landing in exactly
  // that gap, or a concurrent writer that keeps landing there across every one of
  // MAX_SETTINGS_WRITE_ATTEMPTS attempts, is still not detected and can still be
  // clobbered; chrome.storage.sync has no compare-and-swap primitive to close it fully.
  function writeOcSettings(local, done, onWillWrite, attemptsLeft) {
    if (attemptsLeft === undefined) attemptsLeft = MAX_SETTINGS_WRITE_ATTEMPTS - 1;

    chrome.storage.sync.get('oc-settings', function (data) {
      if (chrome.runtime.lastError) {
        // A failed read must never let a near-empty merge overwrite real stored data.
        if (done) done(null);
        return;
      }

      var fresh = (data && data['oc-settings']) || {};
      var base = lastKnownOcSettings || {};
      var merged = mergeOcSettings(fresh, base, local);
      if (typeof normalizeOcSettings === 'function') {
        normalizeOcSettings(merged);
      }
      var freshStr = stableStringify(fresh);

      chrome.storage.sync.get('oc-settings', function (confirmData) {
        var confirmErr = chrome.runtime.lastError;
        var confirmRaw = (confirmData && confirmData['oc-settings']) || {};
        if (!confirmErr && stableStringify(confirmRaw) !== freshStr && attemptsLeft > 0) {
          // Something else wrote between our get() and this confirming re-read.
          // Recompute the merge against that fresh state instead of clobbering it.
          writeOcSettings(local, done, onWillWrite, attemptsLeft - 1);
          return;
        }
        // A lastError here means proceed with what we already have rather than abandon
        // outright — the merge computed above is still valid, we just can't confirm it.

        if (onWillWrite) onWillWrite(merged);
        chrome.storage.sync.set({ 'oc-settings': merged }, function () {
          if (chrome.runtime.lastError) {
            if (done) done(null);
            return;
          }
          rememberOcSettings(merged);
          if (done) done(merged);
        });
      });
    });
  }

  var api = {
    LEGACY_DISPLAY_PRESET_MAP: LEGACY_DISPLAY_PRESET_MAP,
    LEGACY_COLOR_PALETTE_MAP: LEGACY_COLOR_PALETTE_MAP,
    mapLegacyDisplayPreset: mapLegacyDisplayPreset,
    mapLegacyColorPalette: mapLegacyColorPalette,
    normalizeOcSettings: normalizeOcSettings,
    rememberOcSettings: rememberOcSettings,
    writeOcSettings: writeOcSettings
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  // Prefer 'window': content.js already relies on it uniformly (window.__ocTest, etc.) for
  // both the real isolated-world content-script context and this suite's jsdom-based unit
  // tests (which assign a jsdom Window to Node's global.window before eval'ing content.js).
  // Falls back to self/globalThis for any other embedding; the module.exports branch above
  // already covers a plain `require()` from a Node test with no window at all.
  if (typeof window !== 'undefined') {
    window.OculistSettingsMigration = api;
  } else if (typeof self !== 'undefined') {
    self.OculistSettingsMigration = api;
  } else if (typeof globalThis !== 'undefined') {
    globalThis.OculistSettingsMigration = api;
  }
})();
