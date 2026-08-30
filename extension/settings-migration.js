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

  var api = {
    LEGACY_DISPLAY_PRESET_MAP: LEGACY_DISPLAY_PRESET_MAP,
    LEGACY_COLOR_PALETTE_MAP: LEGACY_COLOR_PALETTE_MAP,
    mapLegacyDisplayPreset: mapLegacyDisplayPreset,
    mapLegacyColorPalette: mapLegacyColorPalette,
    normalizeOcSettings: normalizeOcSettings
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
