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
    displayPreset: null,
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
    seededDefaultBlocklist: false,
    // oculist-nq1x.2: written by background.js, never read here — same round-trip
    // reasoning as seededDefaultBlocklist just above. A key missing from SETTINGS_KEYS
    // would be dropped from storage on the next whole-object write, and the Halloween
    // pack would re-seed itself back on for a user who deliberately turned it off.
    seededHalloweenPack: false,
    // oculist-tdj: which optional effect packs are turned on, an array of pack ids. Empty
    // means core-only — today's twelve effects, unchanged for every existing user. Read
    // exclusively through availableEffects() (defined by the effectsRegistry below);
    // nothing else should index settings.enabledPacks directly.
    enabledPacks: [],
    // oculist-tdj.3: whether the one-time "a pack is available" discovery prompt
    // (maybeShowPackDiscoveryNotice() below) has already been answered — either its close
    // control or its "Open Settings" link, both routed through
    // dismissPackDiscoveryNotice(). false means "keep showing it on every overlay open
    // that has a pack available"; flips to true exactly once and, being an ordinary
    // SETTINGS_KEYS member, syncs and never reverts on any device from then on.
    packsNoticeDismissed: false
  };

  var SETTINGS_KEYS = [
    'effect', 'position', 'theme', 'matchColor', 'activeColor', 'beaconColor',
    'scrollBehavior', 'disabledSites', 'performanceMode',
    'displayPreset', 'visionSettings', 'setupWizardCompleted',
    'seededDefaultBlocklist', 'seededHalloweenPack', 'enabledPacks', 'packsNoticeDismissed'
  ];

  // oculist-rnr.12 (review fix): the visionProfile -> displayPreset rename and the
  // colorPalette clinical-value rewrite both used to live here as content.js-local copies.
  // Moved into extension/settings-migration.js — the single canonical table/normaliser
  // shared with popup.js and welcome.js, so there is exactly one place this can drift, and
  // so a popup/welcome write can normalise before persisting instead of re-introducing the
  // legacy field content.js had already cleaned up (review gap 1). content.js is
  // manifest-injected with that file listed before this one (see manifest.json's
  // content_scripts), so window.OculistSettingsMigration (set the same way window.__ocTest
  // is, below) is already there by the time this line runs.
  var OculistSettingsMigration = window.OculistSettingsMigration;

  // Every write we make echoes back through chrome.storage.onChanged in this same tab.
  // Recording each payload lets the listener recognise its own echo and ignore it. Value
  // comparison alone is not enough: two colour picks in one tick queue two writes, and by
  // the time the first echo lands memory already holds the second value, so the echo
  // looks like a foreign change and tears the panel down mid-interaction.
  var pendingSelfWrites = [];

  function saveSettings() {
    // oculist-xvh: writeOcSettings() three-way merges this write against a concurrent
    // foreign write instead of blindly overwriting it (see settings-migration.js). The
    // echo record must be of the MERGED object actually written, not of `settings` — a
    // foreign write folded into the merge changes what lands in storage, and recording
    // `settings` instead would make the onChanged listener fail to recognise a merge
    // that included a foreign key as our own echo. Do NOT copy `merged` back into
    // `settings` here: a foreign write already delivers itself through the existing
    // onChanged listener, and copying it in here would defeat that path.
    OculistSettingsMigration.writeOcSettings(settings, undefined, function (merged) {
      pendingSelfWrites.push(stableStringify(merged));
      // Purely a leak guard. An echo that never arrives would otherwise pin an entry here
      // forever; nobody queues twenty writes ahead of the first echo in practice.
      if (pendingSelfWrites.length > 20) pendingSelfWrites.shift();
    });
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
    var rawTerms = Array.isArray(stored && stored.terms) ? stored.terms : [];
    var idx = (stored && typeof stored.activeIndex === 'number' && !isNaN(stored.activeIndex))
      ? stored.activeIndex
      : -1;
    if (idx !== -1 && (idx < 0 || idx >= rawTerms.length)) idx = -1;
    // addChipTerm() only ever pushes a term after checking workListTerms.indexOf(trimmed)
    // === -1, i.e. exact-string dedupe. A stored payload (crafted or from an older build)
    // can still carry duplicates, and updateDimHighlight() skips the active term by index
    // rather than text — a duplicate would otherwise put the active term's own ranges into
    // the dim set. Mirror addChipTerm's exact-match comparison here, keep the first
    // occurrence of each term, and remap activeIndex to that surviving index so it still
    // points at the term it pointed at before dedupe.
    var activeTerm = idx !== -1 ? rawTerms[idx] : undefined;
    var terms = [];
    for (var i = 0; i < rawTerms.length; i++) {
      if (terms.indexOf(rawTerms[i]) === -1) terms.push(rawTerms[i]);
    }
    var newIdx = idx === -1 ? -1 : terms.indexOf(activeTerm);
    return { terms: terms, activeIndex: newIdx };
  }

  // background.js's service-worker startup call to
  // chrome.storage.session.setAccessLevel('TRUSTED_AND_UNTRUSTED_CONTEXTS') races this
  // content script's own boot with no ordering guarantee. Until that grant lands,
  // chrome.storage.session is DEFINED but DENIED here — a call against it fails with
  // chrome.runtime.lastError, not with the API being undefined, so the storageAvailable
  // check above cannot catch this case; it can only catch a genuinely absent API (an
  // older Chrome, or setAccessLevel having never been called at all).
  //
  // Chrome gives no error code or property for this specific failure — lastError is
  // always just a free-text string, so matching its exact wording is the only signal
  // available to tell "denied because the grant hasn't landed yet (retry-worthy)" apart
  // from every other lastError (not retry-worthy: logged and treated as a real failure
  // instead). If a future Chrome release changes this string, isSessionAccessDeniedError
  // simply stops matching and every call falls through to the "unexpected failure"
  // branch below — noisier (it would start logging on the ordinary startup race) but
  // never silently wrong, and still bounded, so this is a safe way for the match to fail.
  var SESSION_ACCESS_DENIED_MESSAGE = 'Access to storage is not allowed from this context.';

  function isSessionAccessDeniedError(err) {
    return !!(err && typeof err.message === 'string' &&
      err.message.indexOf(SESSION_ACCESS_DENIED_MESSAGE) !== -1);
  }

  // Deterministic (not timing-based) gate for the one retry loadWorkList/saveWorkList are
  // allowed: ask background.js — which holds onto its own setAccessLevel() promise — to
  // reply only once that promise has settled, then retry exactly once. This turns "wait
  // out an unmeasured race" into "wait for an observed readiness signal", the same
  // ready-ping strategy the bead suggests instead of a fixed-delay retry (which the
  // measured ~9ms window makes unsafe: an immediate retry can land inside it too).
  // If the extension context is gone (sendMessage throws) or background.js never answers
  // meaningfully, `next()` still runs — the caller having asked at all is what bounds this
  // to one retry, not the reply's content.
  // chrome.runtime.sendMessage is always async in real Chrome, but a synchronous mock (as
  // used against this exact function's own retry callers) invokes its reply callback on
  // the SAME call stack as the try below. If next() throws from there, the throw is still
  // on this stack and would otherwise land in the catch, which exists ONLY to handle
  // sendMessage itself throwing synchronously (e.g. the extension context is gone) — a
  // throw from next() is not that, and re-running next() from the catch would invoke it
  // a second time. reachedCallback distinguishes the two: once set, the reply callback
  // itself already ran, so any exception reaching the catch came from inside next(), not
  // from sendMessage, and must be rethrown rather than reinterpreted as "sendMessage
  // failed" — same "let it throw once" principle as loadWorkList's synchronous-path
  // comment above.
  function retryAfterSessionAccessReady(next) {
    var reachedCallback = false;
    try {
      chrome.runtime.sendMessage({ action: 'ensureSessionAccess' }, function () {
        reachedCallback = true;
        // Reading lastError here only marks a missing receiver handled (e.g. background.js
        // torn down); either way, some real time has passed and there is nothing further
        // to wait for, so it is not treated differently from a normal reply.
        void chrome.runtime.lastError;
        next();
      });
    } catch (err) {
      if (reachedCallback) throw err;
      next();
    }
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
    attemptLoadWorkList(callback, true);
  }

  // allowRetry is exactly-once by construction: this function is entered with
  // allowRetry=true from loadWorkList() itself, and the only recursive call passes
  // false — so no call chain can retry more than once. Every branch below either
  // returns after calling `callback` exactly one time, or (the single access-denied +
  // allowRetry branch) returns without calling it, handing the exactly-once obligation
  // to the one attemptLoadWorkList(callback, false) call it schedules. That recursive
  // call's own allowRetry=false forecloses a further denied+retry branch, so it is
  // itself forced through one of the callback-calling branches. Net: callback fires
  // exactly once across the original attempt, the retry, and every failure path.
  // The try below exists to catch chrome.storage.session.get() itself throwing
  // synchronously (an old/broken environment that fails before ever invoking its own
  // callback) — it must NOT be understood to also cover the result callback passed to
  // get(). get() is always async in real Chrome, but a synchronous mock invokes that
  // callback on the SAME call stack as this try, so if the caller's own `callback` throws
  // from inside it, the throw is still on this stack and would otherwise land in the catch
  // below, which would mistake it for "our" get() failure and call callback(defaultWorkList())
  // a second time. reachedResultHandler distinguishes the two: once set, the result
  // callback already started running, so any exception reaching the catch originated from
  // inside our own result handling (very likely the caller's callback), and must be
  // rethrown rather than reinterpreted as a get() failure — same "let it throw once"
  // principle as loadWorkList's synchronous-path comment above.
  function attemptLoadWorkList(callback, allowRetry) {
    var reachedResultHandler = false;
    try {
      chrome.storage.session.get(WORK_LIST_KEY, function (data) {
        reachedResultHandler = true;
        var err = chrome.runtime.lastError;
        if (err) {
          if (isSessionAccessDeniedError(err)) {
            if (allowRetry) {
              retryAfterSessionAccessReady(function () {
                attemptLoadWorkList(callback, false);
              });
              return;
            }
            // Retry already used and still denied: a permanent denial (no setAccessLevel
            // support, or a policy that always refuses). This is the expected steady
            // state for those browsers/policies, not a bug — degrade silently like an
            // absent API, same as before this fix, and do not log on every page load.
            callback(defaultWorkList());
            return;
          }
          // Any other lastError is unexpected — surface it so a real storage failure is
          // diagnosable, instead of the previous unconditional swallow.
          console.error('Oculist: chrome.storage.session.get failed.', err);
          callback(defaultWorkList());
          return;
        }
        if (!data || !data[WORK_LIST_KEY]) {
          callback(defaultWorkList());
          return;
        }
        callback(normalizeWorkList(data[WORK_LIST_KEY]));
      });
    } catch (err) {
      if (reachedResultHandler) throw err;
      callback(defaultWorkList());
    }
  }

  function saveWorkList(list) {
    var storageAvailable;
    try {
      storageAvailable = !!(chrome.storage && chrome.storage.session);
    } catch (err) {
      storageAvailable = false;
    }
    // fail silently — a browser without session storage access must not throw here.
    if (!storageAvailable) return;
    var payload = {
      terms: Array.isArray(list && list.terms) ? list.terms : [],
      activeIndex: typeof (list && list.activeIndex) === 'number' ? list.activeIndex : -1
    };
    attemptSaveWorkList(payload, true);
  }

  // Same exactly-once-retry shape as attemptLoadWorkList above, but saveWorkList has no
  // callback of its own to guarantee — the only externally-observable contract is "at
  // most one retry, then stop", which allowRetry=false on the recursive call already
  // forecloses the same way.
  function attemptSaveWorkList(payload, allowRetry) {
    try {
      var setObj = {};
      setObj[WORK_LIST_KEY] = payload;
      var setResult = chrome.storage.session.set(setObj, function () {
        // Read lastError so a rejected/unavailable write doesn't surface as an unchecked
        // runtime error; this is invisible plumbing and must fail silently — but only for
        // the cases that were always meant to be invisible (see below).
        var err = chrome.runtime.lastError;
        if (!err) return;
        if (isSessionAccessDeniedError(err)) {
          if (allowRetry) {
            retryAfterSessionAccessReady(function () {
              attemptSaveWorkList(payload, false);
            });
          }
          // else: permanent denial — same silent no-op as before this fix; see
          // attemptLoadWorkList for why this specific, expected case must not log.
          return;
        }
        // Unexpected failure — surface it, matching background.js's own storage-failure
        // reporting; "invisible plumbing" was only ever meant to cover the no-access case.
        console.error('Oculist: chrome.storage.session.set failed.', err);
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

  // Same test-reachability reasoning as getDebounceTimer above: activeBeacons (declared
  // further down, in the "State" section) is a module-private "have we drawn since the
  // last reset" flag animate() increments and cancelBeacons()/fadeActiveBeacons() reset
  // to 0 — nothing outside this closure can read it otherwise. oculist-5rv's regression
  // test uses this to assert animate() does not increment it on a guard-skipped
  // (zero-width/zero-height rect) run.
  window.__ocTest.getActiveBeacons = function () { return activeBeacons; };

  // Which of animate()'s three motion branches a run will take. Exposed so a test that
  // only means something under one of them can assert it is actually in that branch,
  // instead of silently exercising a different one when its setup does not take
  // (oculist-9t5). Read-only; effectiveMotion() itself is unchanged.
  window.__ocTest.getEffectiveMotion = function () { return effectiveMotion(); };

  // Same test-reachability reasoning as getDebounceTimer above. Both the boot-time
  // coercion (`if (!effectsRegistry[settings.effect]) settings.effect = 'hud'`) and the
  // storage.onChanged guard normalise a genuinely-unknown (never-registered) effect key
  // back to 'hud' before animate() ever runs, so nothing outside this closure can drive
  // settings.effect to a bogus value at animate()-time anymore (oculist-jq6). A
  // pack-disabled key (registered, just not currently available — oculist-tdj) is
  // deliberately NOT normalised by those guards, so this hook writes settings.effect
  // directly, bypassing every guard, to exercise BOTH animate()'s own fallback
  // (availableEffects()[effectKey] || availableEffects().hud, as of oculist-tdj) and the
  // genuinely-unknown case.
  window.__ocTest.setEffectKey = function (key) { settings.effect = key; };

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

    if (palette === 'amber-sky') {
      mc = '#fef08a'; ac = '#0284c7'; bc = '#0284c7';
    } else if (palette === 'amber-indigo') {
      mc = '#fef08a'; ac = '#2563eb'; bc = '#2563eb';
    } else if (palette === 'rose-cyan') {
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
    // oculist-tdj.2: store-review copy constraint — every user-facing string about this
    // feature says "effect pack" or "seasonal effects", and avoids the extension-store
    // vocabulary that would frame this as a separate installable module.
    packsLabel: 'Optional Effect Packs',
    packsDesc: 'Turn on a pack to add its seasonal effects to the list above',
    // oculist-tdj.3: one-time discovery prompt for the packsLabel/packsDesc toggle above —
    // same store-review copy constraint (never "plugin"/"add-on").
    packsNoticeText: 'New seasonal effects are available as an optional effect pack — turn them on in Settings.',
    packsNoticeCta: 'Open Settings',
    packsNoticeDismiss: 'Dismiss',
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
    effectCyberVision: 'Cyber-Vision',

    // Halloween pack (oculist-nq1x)
    effectBoneAssembly: 'Skeleton Trot',
    effectFlappy: 'Flappy',
    effectCheshire: 'Cheshire Cat',
    effectJackOLantern: 'Pumpkin Glow',
    effectHorseman: 'Galloping Throw',
    effectTentacleRise: 'Tentacle Rise',
    effectReanimate: 'Reanimation Jolt',
    effectBatFlight: 'Vampire Bat',
    effectWandCast: 'Fairy Cast',
    effectArrowShot: 'Arrow Shot',
    effectVineSwing: 'Vine Swing',

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

  // oculist-tdj: an entry may carry an optional `pack` field (a string pack id). Absent
  // means core — always available. See availableEffects() just below for the one place
  // `pack` is actually read. oculist-nq1x.5 is the mechanism's first real user: the twelve
  // originals below stay core (unpacked), and boneassembly is the first packed entry.
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
    cybervision: { label: i18n.effectCyberVision, run: animateCyberVision },
    boneassembly: { label: i18n.effectBoneAssembly, run: animateBoneAssembly, pack: 'halloween' },
    flappy: { label: i18n.effectFlappy, run: animateFlappy, pack: 'halloween' },
    cheshire: { label: i18n.effectCheshire, run: animateCheshire, pack: 'halloween' },
    jackolantern: { label: i18n.effectJackOLantern, run: animateJackOLantern, pack: 'halloween' },
    horseman: { label: i18n.effectHorseman, run: animateHorseman, pack: 'halloween' },
    tentaclerise: { label: i18n.effectTentacleRise, run: animateTentacleRise, pack: 'halloween' },
    reanimate: { label: i18n.effectReanimate, run: animateReanimate, pack: 'halloween' },
    batflight: { label: i18n.effectBatFlight, run: animateBatFlight, pack: 'halloween' },
    wandcast: { label: i18n.effectWandCast, run: animateWandCast, pack: 'halloween' },
    arrowshot: { label: i18n.effectArrowShot, run: animateArrowShot, pack: 'halloween' },
    vineswing: { label: i18n.effectVineSwing, run: animateVineSwing, pack: 'halloween' }
  };

  // oculist-tdj: the SINGLE place pack state (settings.enabledPacks) is read. Returns
  // the subset of effectsRegistry that is currently selectable — every entry with no
  // `pack`, plus every entry whose `pack` is in settings.enabledPacks. Every other
  // consumer of effectsRegistry (the settings-panel picker, the storage-change and
  // load-time coercions, and animate()'s run-time resolution) must read through this
  // instead of effectsRegistry directly: filtering some call sites and not others is
  // exactly how a disabled effect ends up hidden from the picker but still firing.
  //
  // Deliberately does NOT mutate `settings.effect` or read/write chrome.storage — pure
  // and side-effect-free, so it's safe to call as often as needed (once per render is
  // fine at this scale: twelve entries today).
  function availableEffects() {
    var out = {};
    // oculist-nq1x.1: guards against settings.enabledPacks being anything other than
    // an array — a stored value from chrome.storage.sync can be a string, a number,
    // null, an object, or whatever a previous version of this extension (or a
    // hand-edited sync profile) left behind. This used to read
    // `settings.enabledPacks || []` on the theory that it was safe by a sequencing
    // coincidence: the Array.isArray coercions below (storage-change and load paths)
    // ran before any registry entry carried a `pack`, so indexOf was never reached
    // against the bad value. That coincidence was never load-bearing and nothing here
    // depends on it anymore — this guard degrades a malformed stored value to
    // core-only on its own, right at the one place `pack` is actually read. The
    // Array.isArray coercions further down (extension/content.js, storage-change and
    // load paths) still stand: they repair the stored value itself for every future
    // writer; this guard only protects this one read.
    var packs = Array.isArray(settings.enabledPacks) ? settings.enabledPacks : [];
    for (var key in effectsRegistry) {
      if (!effectsRegistry.hasOwnProperty(key)) continue;
      var entry = effectsRegistry[key];
      if (!entry.pack || packs.indexOf(entry.pack) !== -1) {
        out[key] = entry;
      }
    }
    return out;
  }

  // Same test-reachability reasoning as window.__ocTest.setEffectKey above:
  // settings.enabledPacks and availableEffects() are both module-private, invisible to
  // anything outside this closure. oculist-nq1x.1's regression test uses this pair to
  // drive availableEffects() directly with a malformed stored value (a string, a
  // number, null, undefined, a plain object) that a real chrome.storage read could
  // plausibly hand back — bypassing the load-path Array.isArray coercions entirely, so
  // the guard above is exercised on its own rather than relying on those coercions
  // having already run.
  window.__ocTest.setEnabledPacksRaw = function (v) { settings.enabledPacks = v; };
  window.__ocTest.getAvailableEffectKeys = function () { return Object.keys(availableEffects()); };

  // oculist-tdj.2: display name for a pack id, for the settings-panel toggle list below.
  // Falls back to a title-cased version of the id rather than the raw id string, so a
  // pack that ships without an entry here still reads as a name, not a slug.
  var PACK_LABELS = {
    halloween: 'Halloween'
  };
  function packLabel(packId) {
    if (PACK_LABELS.hasOwnProperty(packId)) return PACK_LABELS[packId];
    return packId.charAt(0).toUpperCase() + packId.slice(1);
  }

  // oculist-tdj.2: the settings-panel pack toggle list is driven off effectsRegistry
  // itself (every distinct `pack` value actually in use), not a separately maintained
  // list — so a pack with no registry entries yet stays entirely absent from the panel
  // instead of appearing as a checkbox with nothing behind it, and a newly promoted pack
  // needs no companion edit here to become toggleable.
  function knownPacks() {
    var seen = {};
    var out = [];
    for (var key in effectsRegistry) {
      if (!effectsRegistry.hasOwnProperty(key)) continue;
      var p = effectsRegistry[key].pack;
      if (p && !seen[p]) {
        seen[p] = true;
        out.push(p);
      }
    }
    return out;
  }

  // oculist-tdj: the one place the "genuinely unknown" question is answered — is `key`
  // a real effect (registered in effectsRegistry) at all, regardless of pack state?
  // False for a real, registered effect whose pack just happens to be disabled right
  // now (availableEffects() answers "is it offered right now"; this answers "does it
  // exist"). The distinction matters for exactly one decision, at the three coercion
  // sites below and at load time: a pack-disabled key must NOT rewrite settings.effect
  // (the pack may come back), while a genuinely unknown key (never registered, e.g. an
  // effect removed in a past build, or hand-edited storage) still must, same as before
  // oculist-tdj.
  function isGenuinelyUnknownEffect(key) {
    return !effectsRegistry.hasOwnProperty(key);
  }

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
  // Set by every writer that commits a real user action against the working list this
  // mount (add/reactivate a chip, remove a chip, load a saved list) — never inferred from
  // workListTerms.length, because a user who adds then removes a chip before the mount's
  // loadWorkList() callback lands ends up back at length 0, and that emptiness must NOT
  // read as "untouched" (which would let the callback resurrect the old persisted list —
  // oculist-v1jg/oculist-avaa). Reset to false on every fresh mount.
  var workListTouchedThisMount = false;
  // Narrower than workListTouchedThisMount: set ONLY by loadSavedList(), which already
  // fully replaces AND persists the working list outright (with no confirmation step —
  // see its own comment). A late mount-restore landing after that must be dropped
  // wholesale, not merged: merging would prepend a stale carried-over list ahead of a
  // list the user just explicitly chose, which is not "terms added this mount" at all.
  // Reset to false on every fresh mount.
  var workListReplacedThisMount = false;
  var chipRow          = null;
  // Bumped once per buildUI() call (oculist-3z6): loadWorkList()'s async callback there
  // closes over the mount id it was issued for, so a callback that is still in flight when
  // the overlay closes AND reopens (its own chrome.storage.session.get() outrun by the
  // close/reopen cycle under load) can tell it belongs to a torn-down mount even though
  // wrapRoot/chipRow are non-null again (pointing at the NEW mount) by the time it fires.
  // Without this, that stale callback's `if (!wrapRoot || !chipRow) return;` guard alone
  // passes and it overwrites the new mount's just-restored workListTerms/termRanges with
  // its own stale data.
  var mountGeneration  = 0;
  var activeScrollTimeout      = null;
  var activeScrollEndHandler   = null;
  var activeScrollDebounceHandler = null;
  var activeScrollDebounceTimer = null;
  // oculist-44y: the bare 50ms "draw at the fresh rect" timer armed by the
  // instant-scroll-behavior branch and the fully-in-viewport branch, below. Kept
  // deliberately separate from the four handles clearActiveScrollHandles() owns rather
  // than folded into that function: the smooth-scroll branch's own entry calls
  // clearActiveScrollHandles() unconditionally (oculist-rbx), and that call must NOT
  // sweep away an immediate draw armed by the PRECEDING navigation (oculist-rbx's own
  // regression test pins this down — the in-view match's draw must survive a later
  // navigation moving on to a smooth-scrolled one). This handle is instead cleared by
  // __ocDestroy() and by the two branches that arm it themselves, below.
  var activeImmediateDrawTimer = null;
  // oculist-44y: holds an immediate-draw timer the smooth branch has disowned (see
  // disownActiveImmediateDrawTimer() below) because it must be allowed to fire on its
  // own schedule rather than being treated as superseded. "Disowned" must not mean
  // "unreachable", though: __ocDestroy() still has to be able to cancel it, or a
  // close+reopen inside its 50ms window paints a stale border onto the freshly
  // rebuilt overlay — the exact hole a first version of this fix left open (caught by
  // review) by nulling activeImmediateDrawTimer outright instead of moving the id
  // somewhere destroy could still reach it. A plain array, not a single slot: more
  // than one disowned timer can be outstanding at once (e.g. instant nav -> smooth nav
  // disowns it -> a second in-viewport nav arms a fresh one -> a second smooth nav
  // disowns that too), and each fires and self-removes independently.
  var orphanedImmediateDrawTimers = [];

  // Tears down every handle for the in-flight scroll-to-match (timeout,
  // scrollend listener, scroll-debounce listener, and the debounce's own
  // pending timer) and nulls each so a stale one is never mistaken for live.
  function clearActiveScrollHandles() {
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
    if (activeScrollDebounceTimer) {
      clearTimeout(activeScrollDebounceTimer);
      activeScrollDebounceTimer = null;
    }
  }

  // oculist-44y: cancels the CURRENT bare immediate-draw timer (see
  // activeImmediateDrawTimer above). Deliberately its own function, not part of
  // clearActiveScrollHandles() — see the comment on activeImmediateDrawTimer's
  // declaration for why. Does not touch orphanedImmediateDrawTimers — a timer that has
  // already been disowned is no longer "current" and must survive this call (see
  // disownActiveImmediateDrawTimer() below); clearOrphanedImmediateDrawTimers() is the
  // one that reaches those.
  function clearActiveImmediateDrawTimer() {
    if (activeImmediateDrawTimer) {
      clearTimeout(activeImmediateDrawTimer);
      activeImmediateDrawTimer = null;
    }
  }

  // oculist-44y: moves the current immediate-draw timer (if any) out of
  // activeImmediateDrawTimer and into orphanedImmediateDrawTimers, WITHOUT
  // clearTimeout()-ing it. Called from the smooth-scroll branch's entry, which must
  // let a preceding in-viewport/instant navigation's own draw complete on schedule
  // (oculist-rbx's and oculist-7uc's regression tests both require this — the timing-
  // invariance argument being: if that draw had already landed before 50ms elapsed, it
  // would stay on screen through the subsequent scroll same as any other match, so a
  // still-pending one shouldn't be retroactively invalidated just because it hasn't
  // fired yet). "Disowned" only means it stops being treated as the CURRENT draw a
  // later same-kind navigation would cancel — it remains reachable via
  // clearOrphanedImmediateDrawTimers(), which __ocDestroy() calls, so a close+reopen
  // still cancels it instead of leaving it to paint onto a freshly rebuilt overlay.
  function disownActiveImmediateDrawTimer() {
    if (activeImmediateDrawTimer) {
      orphanedImmediateDrawTimers.push(activeImmediateDrawTimer);
      activeImmediateDrawTimer = null;
    }
  }

  // oculist-44y: cancels every timer disownActiveImmediateDrawTimer() has parked.
  // Called by __ocDestroy() alongside clearActiveImmediateDrawTimer() — between the
  // two, every immediate-draw timer this module can have armed, current or disowned,
  // is reachable by teardown.
  function clearOrphanedImmediateDrawTimers() {
    orphanedImmediateDrawTimers.forEach(function (t) { clearTimeout(t); });
    orphanedImmediateDrawTimers.length = 0;
  }

  // oculist-44y: called from inside a fired immediate-draw timer's own callback,
  // before it draws, to remove itself from whichever bookkeeping still names it — the
  // CURRENT slot if never disowned, or the orphan list if the smooth branch disowned
  // it first. Keeps both from ever pointing at (or accumulating) a timer id that has
  // already fired and is no longer cancellable by anything.
  function forgetFiredImmediateDrawTimer(timer) {
    if (activeImmediateDrawTimer === timer) {
      activeImmediateDrawTimer = null;
      return;
    }
    var idx = orphanedImmediateDrawTimers.indexOf(timer);
    if (idx !== -1) orphanedImmediateDrawTimers.splice(idx, 1);
  }

  var domObserver           = null;
  var domObserverTimer      = null;
  var noticeEl              = null;
  // oculist-tdj.3: the pack-discovery notice's own element, separate from noticeEl/
  // dismissedNotices above — those are showNotice()'s session-only banner (cleared by
  // __ocDestroy() on every close), this one's dismissal is a persisted setting instead
  // (settings.packsNoticeDismissed), so it needs its own handle rather than sharing that
  // machinery.
  var packNoticeEl          = null;
  // oculist-3rq: the notice's own rendered height (0 while it isn't showing), folded into
  // #oc-settings-panel's/#oc-lists-panel's max-height cap alongside barChromePx (see its
  // comment in injectHighlightStyles()) — the notice renders between the bar and either
  // panel, so its height is chrome those caps must also subtract. Unlike barChromePx this
  // is not a fixed literal (the text is i18n'd and can wrap at narrow widths), so it is a
  // live getBoundingClientRect() measurement taken right after the notice is appended —
  // safe here (unlike a live read of the bar) because .oc-pack-notice's own CSS is already
  // attached to wrapRoot by the time maybeShowPackDiscoveryNotice() runs (injectHighlightStyles()
  // always runs first in window.__ocToggle()'s build branch), so the measurement reflects the
  // fully-styled element, not an unstyled one. Set back to 0 on dismissal/destroy so the caps
  // regain their space rather than staying permanently shrunk.
  //
  // oculist-3b7: this measurement's safety also depends on WHEN it runs, not just that the CSS
  // is attached. The one call site (window.__ocToggle()'s build branch, right after
  // checkSiteOverride()) fires before any search has run, while .oc-count sits at its 58px
  // min-width floor. Every other child of the `nowrap` .oc-bar is a fixed px width; .oc-count
  // is the only content-sized one (min-width plus nowrap — it is flex-shrink:0 like the rest,
  // so shrink behaviour is not what sets it apart), and with the count empty its min-content
  // equals its max-content. The bar is therefore at its NARROWEST here, which makes the notice
  // its TALLEST, so packNoticeChromePx is an upper bound and the cap can only over-subtract.
  // What actually inverts that: moving this call out of the build branch, so the notice can
  // first be measured while a search is active and the bar already wide. That records a SHORT
  // (unwrapped) notice; when the search is then cleared the bar returns to its floor, the
  // notice wraps taller than the recorded value, and the cap under-subtracts and lets the panel
  // overflow. Localizing i18n's 'of'/'noMatch' does NOT invert it on its own — a longer count
  // widens the bar, which only unwraps the notice shorter (measured 46.594 to 31.188px), so the
  // stale value stays an upper bound and merely gets more conservative. It does widen the swing
  // that scenario 2 would then get wrong. Guarded by the measured-at-floor test in
  // test/pack_discovery_notice.test.js. If the call site ever moves, this needs re-measurement
  // machinery, not just this comment.
  var packNoticeChromePx    = 0;
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
    // oculist-tz6: same hazard oculist-rbx fixed at the smooth-scroll branch entry — the
    // debounce TIMER (as opposed to the listener that schedules it) has no other
    // module-level handle, so a still-pending 80ms timer from a torn-down navigation
    // survives a listener-only teardown and can fire onScrollEnd into a freshly rebuilt overlay
    // (window.__ocToggle() calls buildUI() right after this in the same module instance).
    clearActiveScrollHandles();
    // oculist-44y: same reasoning, for the bare immediate-draw timer armed by the
    // instant-scroll and fully-in-viewport branches — see activeImmediateDrawTimer's
    // declaration for why it is cleared separately from the four handles above. Both
    // calls are needed: the CURRENT timer (if the smooth branch never disowned it) and
    // any DISOWNED ones the smooth branch let keep running past its own supersession
    // (see disownActiveImmediateDrawTimer()) — either can still be pending here, and a
    // close+reopen (window.__ocToggle() calls buildUI() right after this, same module
    // instance) must not let either paint onto the freshly rebuilt overlay.
    clearActiveImmediateDrawTimer();
    clearOrphanedImmediateDrawTimers();

    // oculist-30k: clearAutoScrollFlag() (see its declaration, below in this closure, for
    // the oculist-z8n grace-timer mechanism it tears down) removes the 'scroll'/'scrollend'
    // listeners triggerAutoScrollFlag() arms and clears autoScrollTimer. Without this, on a
    // page that keeps generating 'scroll' events forever (an infinite auto-scroller, a stuck
    // momentum scroll), the still-attached 'scroll' listener keeps re-arming that timer
    // indefinitely after teardown — bounded (a reopen's triggerAutoScrollFlag() removes both
    // listeners by reference before re-adding, so they don't accumulate), but not zero.
    clearAutoScrollFlag();

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
    packNoticeEl = null;
    packNoticeChromePx = 0;
    listsBtn = listsPanel = null;
    lastTerm = ''; activeIndex = -1; searchRanges = []; firstEnter = false; dismissedNotices.clear();
    chipRow = null; workListTerms = []; activeTermIndex = -1; termRanges = []; termStarved = [];
    workListTouchedThisMount = false;
    workListReplacedThisMount = false;
  };

  // ── Beacons ───────────────────────────────────────────────────────────────────

  // WAAPI animations do NOT stop on their own when their target is detached from the
  // document — verified empirically: playState stays 'running' and currentTime keeps
  // advancing on a removed element unless .cancel() is called explicitly. Canvas
  // effects hang their rAF id off __rafId above; DOM/WAAPI effects (e.g.
  // Cyber-Vision) hang their live Animation objects off __waapiAnims instead, so a
  // beacon cancelled mid-flight actually stops animating, not just leaves the DOM.
  function destroyBeacon(b) {
    // Set here as well as at fadeActiveBeacons()'s fade start (oculist-xi4) so the marker
    // means "this run is cancelled" rather than "cancelled via the fade path". Redundant
    // for a caller that only checks isConnected, since remove() below settles that
    // immediately — but a timer callback reading __ocCancelled alone would otherwise miss
    // every cancellation that came through cancelBeacons().
    b.__ocCancelled = true;
    if (b.__rafId) { cancelAnimationFrame(b.__rafId); b.__rafId = null; }
    if (b.__waapiAnims) {
      for (var j = 0; j < b.__waapiAnims.length; j++) {
        try { b.__waapiAnims[j].cancel(); } catch (e) {}
      }
    }
    b.remove();
  }

  // sel defaults to '.oc-beacon' (every transient effect beacon AND the persistent Low Vision
  // overlays drawActiveOverlays() also tags .oc-beacon). oculist-01sj: handleResize()'s own
  // leading-edge cancel passes '.oc-beacon-transient' instead — the same selector
  // fadeActiveBeacons() uses, for the same reason: that cancel has no redraw following it
  // (that's the debounced repositionActiveOverlays(), later) to immediately replace the
  // persistent overlays, which otherwise track scroll AND resize correctly in document
  // coordinates on their own and must survive both.
  function cancelBeacons(sel) {
    var beacons = document.querySelectorAll(sel || '.oc-beacon');
    for (var i = 0; i < beacons.length; i++) {
      destroyBeacon(beacons[i]);
    }
    activeBeacons = 0;
  }

  // Same test-reachability reasoning as window.__ocTest.getDebounceTimer above: a real
  // second search calls cancelBeacons() from inside an animate() that is itself invoked off
  // a scroll-settle handler or a setTimeout (highlightActiveRange()), never synchronously
  // from the keypress that triggered it — a test driving "cancel mid-flight" through
  // simulated keystrokes alone would be racing that latency instead of testing cancellation
  // itself. Exposing the real closure directly removes that race without changing
  // cancelBeacons()'s own behavior at all.
  window.__ocTest.cancelBeacons = cancelBeacons;

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
    laserContainer.className = 'oc-beacon oc-beacon-transient';
    laserContainer.style.cssText = [
      'position:absolute',
      'left:0', 'top:' + targetTop + 'px',
      'width:100%', 'height:' + containerHeight + 'px',
      'pointer-events:none', 'z-index:2147483643',
      'overflow:visible'
    ].join(';');
    laserContainer.style.transform = 'scale(' + scale + ')';
    laserContainer.style.transformOrigin = cx + 'px ' + offsetY + 'px';

    // See cancelBeacons(): every Animation this beacon creates is hung off the
    // container so a mid-flight cancel actually stops it (not just detaches its element).
    var anims = [];

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

    anims.push(sheath.animate([
      { transform: 'scaleY(0)', opacity: 0 },
      { transform: 'scaleY(1.5)', opacity: 0.6, offset: 0.1 },
      { transform: 'scaleY(1)', opacity: 0.4, offset: 0.8 },
      { transform: 'scaleY(0)', opacity: 0 }
    ], {
      duration: getBeaconDuration(2000),
      easing: 'cubic-bezier(0.19, 1, 0.22, 1)',
      fill: 'forwards'
    }));

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

    anims.push(core.animate([
      { transform: 'scaleY(0)', opacity: 0 },
      { transform: 'scaleY(2.2)', opacity: 1, offset: 0.15 },
      { transform: 'scaleY(1.2)', opacity: 0.85, offset: 0.8 },
      { transform: 'scaleY(0)', opacity: 0 }
    ], {
      duration: getBeaconDuration(2000),
      easing: 'cubic-bezier(0.19, 1, 0.22, 1)',
      fill: 'forwards'
    }));

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

    anims.push(flash.animate([
      { transform: 'scale(0.2)', opacity: 0 },
      { transform: 'scale(1.3)', opacity: 1, offset: 0.15 },
      { transform: 'scale(1)', opacity: 0.9, offset: 0.8 },
      { transform: 'scale(1.5) scaleY(0)', opacity: 0 }
    ], {
      duration: getBeaconDuration(2000),
      easing: 'cubic-bezier(0.19, 1, 0.22, 1)',
      fill: 'forwards'
    }));

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

      anims.push(spark.animate([
        { transform: 'translate(-50%, -50%) translate(0, 0) scale(1.5)', opacity: 1 },
        { transform: 'translate(-50%, -50%) translate(' + dx + 'px, ' + dy + 'px) scale(0)', opacity: 0 }
      ], {
        duration: getBeaconDuration(1500 + Math.random() * 500),
        easing: 'cubic-bezier(0.1, 0.8, 0.2, 1)',
        fill: 'forwards'
      }));
    }

    laserContainer.__waapiAnims = anims;

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
    overlay.className = 'oc-beacon oc-beacon-transient';
    overlay.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'bottom:0',
      'pointer-events:none', 'z-index:2147483641',
      'background:radial-gradient(ellipse ' + (w * 2.8) + 'px ' + (h * 2.8) + 'px at ' + cx + 'px ' + cy + 'px, transparent 20%, rgba(0, 0, 0, 0.72) 80%)'
    ].join(';');
    document.documentElement.appendChild(overlay);

    // overlay and ring are each their own top-level .oc-beacon element (no shared
    // container here), so cancelBeacons() reaches them independently — each needs its
    // own __waapiAnims, not a shared array.
    overlay.__waapiAnims = [overlay.animate([
      { opacity: 0 },
      { opacity: 1, offset: 0.15 },
      { opacity: 1, offset: 0.8 },
      { opacity: 0 }
    ], {
      duration: getBeaconDuration(2000),
      easing: 'ease-out',
      fill: 'forwards'
    })];

    var color = getEffectiveColors().beacon || '#38bdf8';

    var ring = document.createElement('div');
    ring.className = 'oc-beacon oc-beacon-transient';
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

    ring.__waapiAnims = [ring.animate([
      { opacity: 0, transform: 'scale(4)' },
      { opacity: 1, transform: 'scale(1)', offset: 0.2 },
      { opacity: 0.85, transform: 'scale(0.95)', offset: 0.8 },
      { opacity: 0, transform: 'scale(0.75)' }
    ], {
      duration: getBeaconDuration(2000),
      easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
      fill: 'forwards'
    })];

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
    leftArrow.className = 'oc-beacon oc-beacon-transient';
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
    rightArrow.className = 'oc-beacon oc-beacon-transient';
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

    // leftArrow and rightArrow are each their own top-level .oc-beacon element (no
    // shared container), so each needs its own __waapiAnims for cancelBeacons() to reach.
    var anim = leftArrow.animate([
      { opacity: 0, transform: 'translateX(-' + (10 * scale) + 'px)' },
      { opacity: 1, transform: 'translateX(0)', offset: 0.15 },
      { opacity: 1, transform: 'translateX(0)', offset: 0.85 },
      { opacity: 0, transform: 'translateX(-' + (5 * scale) + 'px)' }
    ], { duration: duration, fill: 'forwards' });
    leftArrow.__waapiAnims = [anim];

    rightArrow.__waapiAnims = [rightArrow.animate([
      { opacity: 0, transform: 'translateX(' + (10 * scale) + 'px)' },
      { opacity: 1, transform: 'translateX(0)', offset: 0.15 },
      { opacity: 1, transform: 'translateX(0)', offset: 0.85 },
      { opacity: 0, transform: 'translateX(' + (5 * scale) + 'px)' }
    ], { duration: duration, fill: 'forwards' })];

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
    container.className = 'oc-beacon oc-beacon-transient';
    container.style.cssText = [
      'position:absolute',
      'left:' + targetLeft + 'px', 'top:' + targetTop + 'px',
      'width:' + containerWidth + 'px', 'height:' + containerHeight + 'px',
      'pointer-events:none', 'z-index:2147483643',
      'overflow:visible'
    ].join(';');
    container.style.transform = 'scale(' + scale + ')';
    container.style.transformOrigin = offsetX + 'px ' + offsetY + 'px';

    // See cancelBeacons(): every Animation this beacon creates is hung off the
    // container so a mid-flight cancel actually stops it (not just detaches its element).
    var anims = [];

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

      anims.push(ring.animate([
        { transform: 'scale(0.5)', opacity: 0 },
        { transform: 'scale(1)', opacity: 1, offset: 0.1 },
        { transform: 'scale(15)', opacity: 0 }
      ], {
        duration: getBeaconDuration(1600),
        delay: r * getBeaconDuration(150),
        easing: 'cubic-bezier(0.1, 0.8, 0.15, 1)',
        fill: 'forwards'
      }));
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

      anims.push(streak.animate([
        { transform: 'rotate(' + angle + 'rad) translate(10px, 0) scaleX(0.05)', opacity: 0 },
        { transform: 'rotate(' + angle + 'rad) translate(' + (travel * 0.25) + 'px, 0) scaleX(3.5)', opacity: 1, offset: 0.15 },
        { transform: 'rotate(' + angle + 'rad) translate(' + (travel * 0.7) + 'px, 0) scaleX(7.0)', opacity: 1, offset: 0.7 },
        { transform: 'rotate(' + angle + 'rad) translate(' + travel + 'px, 0) scaleX(10.0)', opacity: 0 }
      ], {
        duration: getBeaconDuration(750 + Math.random() * 550),
        delay: getBeaconDuration(startDelay),
        easing: 'cubic-bezier(0.1, 0.8, 0.25, 1)',
        fill: 'forwards'
      }));
    }

    container.__waapiAnims = anims;

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
    container.className = 'oc-beacon oc-beacon-transient';
    container.style.cssText = [
      'position:absolute',
      'left:' + targetLeft + 'px', 'top:' + targetTop + 'px',
      'width:' + containerWidth + 'px', 'height:' + containerHeight + 'px',
      'pointer-events:none', 'z-index:2147483643',
      'overflow:visible'
    ].join(';');
    container.style.transform = 'scale(' + scale + ')';
    container.style.transformOrigin = offsetX + 'px ' + offsetY + 'px';

    // See cancelBeacons(): every Animation this beacon creates is hung off the
    // container so a mid-flight cancel actually stops it (not just detaches its element).
    var anims = [];

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

    anims.push(outline.animate([
      { opacity: 0, transform: 'scale(1.15)' },
      { opacity: 0.9, transform: 'scale(1)', offset: 0.15 },
      { opacity: 0.8, transform: 'scale(1)', offset: 0.85 },
      { opacity: 0, transform: 'scale(0.95)' }
    ], {
      duration: getBeaconDuration(1800),
      easing: 'ease-out',
      fill: 'forwards'
    }));

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

    anims.push(glow.animate([
      { opacity: 0, transform: 'scale(0.8)' },
      { opacity: 1, transform: 'scale(1)', offset: 0.2 },
      { opacity: 0.8, transform: 'scale(1.05)', offset: 0.85 },
      { opacity: 0, transform: 'scale(1.1)' }
    ], {
      duration: getBeaconDuration(1800),
      easing: 'ease-out',
      fill: 'forwards'
    }));

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

      anims.push(p.animate([
        { transform: 'translate(-50%, -50%) translate(0, 0) rotate(' + randomRotate + 'deg) scale(0.2)', opacity: 0 },
        { transform: 'translate(-50%, -50%) translate(' + (swayX * 0.3) + 'px, -' + (riseHeight * 0.3) + 'px) rotate(' + (randomRotate + 45) + 'deg) scale(1.2)', opacity: 0.9, offset: 0.2 },
        { transform: 'translate(-50%, -50%) translate(' + (swayX * 0.7) + 'px, -' + (riseHeight * 0.7) + 'px) rotate(' + (randomRotate + 90) + 'deg) scale(0.8)', opacity: 0.6, offset: 0.7 },
        { transform: 'translate(-50%, -50%) translate(' + swayX + 'px, -' + riseHeight + 'px) rotate(' + (randomRotate + 180) + 'deg) scale(0)', opacity: 0 }
      ], {
        duration: getBeaconDuration(1000 + Math.random() * 600),
        delay: getBeaconDuration(Math.random() * 400),
        easing: 'cubic-bezier(0.21, 0.61, 0.35, 1)',
        fill: 'forwards'
      }));
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

      anims.push(s.animate([
        { transform: 'translate(-50%, -50%) translate(0, 0) scale(0.5)', opacity: 0 },
        { transform: 'translate(-50%, -50%) translate(' + (sSway * 0.4) + 'px, -' + (sRise * 0.4) + 'px) scale(1.2)', opacity: 0.3, offset: 0.3 },
        { transform: 'translate(-50%, -50%) translate(' + sSway + 'px, -' + sRise + 'px) scale(2)', opacity: 0 }
      ], {
        duration: getBeaconDuration(1400 + Math.random() * 600),
        delay: getBeaconDuration(Math.random() * 500),
        easing: 'ease-out',
        fill: 'forwards'
      }));
    }

    container.__waapiAnims = anims;

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
    container.className = 'oc-beacon oc-beacon-transient';
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

    // See cancelBeacons(): every Animation this beacon creates is hung off the
    // container so a mid-flight cancel actually stops it (not just detaches its element).
    var anims = [];

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

      anims.push(ring.animate([
        { transform: 'scale(0.5)', opacity: 0, filter: 'blur(0px)' },
        { transform: 'scale(1)', opacity: 1, filter: 'blur(0px)', offset: 0.1 },
        { transform: 'scale(' + endScale + ')', opacity: 0, filter: 'blur(6px)' }
      ], {
        duration: getBeaconDuration(2100),
        delay: r * getBeaconDuration(110),
        easing: 'cubic-bezier(0.1, 0.8, 0.15, 1)',
        fill: 'forwards'
      }));
    }

    container.__waapiAnims = anims;

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
      lineSvg.setAttribute('class', 'oc-beacon oc-beacon-transient');
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
      // linePath is a child of lineSvg, not itself .oc-beacon — the Animation is hung
      // off lineSvg (the element cancelBeacons() actually selects) instead.
      lineSvg.__waapiAnims = [lineAnim];

      lineAnim.finished.then(function () {
        lineSvg.remove();
      }).catch(function () {
        lineSvg.remove();
      });
    }

    // Arrowhead — mounted at the start point, offset-path expressed relative to it.
    var arrow = document.createElement('div');
    arrow.className = 'oc-beacon oc-beacon-transient oc-trail-arrow';
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
    arrow.__waapiAnims = [anim];

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
    flash.className = 'oc-beacon oc-beacon-transient oc-trail-flash';
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
    flash.__waapiAnims = [flashAnim];

    flashAnim.finished.then(function () {
      flash.remove();
    }).catch(function () {
      flash.remove();
    });
  }

  // oculist-nq1x.5: promotes fxBoneAssembly (artifacts/prototypes/effects-playground.html,
  // the nq1x.4 redraw) into the shipped beacon contract. A scatter of loose bones flies in
  // beside the match, snaps into a small standing skeleton, the skull detaches and rolls
  // ahead while the headless body dashes to catch up, then the whole figure collapses into
  // a heap and fades. The jaw-clack beat and the pointing-arm pose were cut in the
  // playground (oculist-1ta.25/.29's own close reasons record why) and stay cut here.
  function animateBoneAssembly(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;

    var NS = 'http://www.w3.org/2000/svg';
    var vw = window.innerWidth;

    // Ivory/dark bone is this figure's own fixed identity palette, the same license the
    // promotion contract names for the pumpkin's orange -- no neighbouring shipped
    // character effect exists yet to set an accessibility-accent precedent for it.
    // beaconScale still drives the whole figure's on-screen size (figHeight below), and
    // durFactor scales every phase boundary, so Settings > Beacon Size / Animation Speed
    // both apply end to end.
    //
    // Lite Mode: this effect has no glow, box-shadow, or multi-state flicker to begin with
    // -- the collapse itself is the payoff, not decoration -- so settings.performanceMode
    // changes nothing here. Full mode and Lite Mode render and time identically.
    var IVORY = '#f1ead2', DARK = '#2b2116';
    var beaconScale = getBeaconScale();
    var durFactor = getBeaconDuration(1);

    var OUTLINE_PX = 1.8;
    var STROKE_NS = 'stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke;';
    var OUTLINE_LOCAL_ADD = 4.2;
    function darkW(coreW) { return coreW + OUTLINE_LOCAL_ADD; }

    function svgEl(tag, attrs, parent) {
      var el = document.createElementNS(NS, tag);
      for (var k in attrs) el.setAttribute(k, attrs[k]);
      parent.appendChild(el);
      return el;
    }
    function drawBone(p0, p1, coreW, parent, name) {
      svgEl('line', {
        x1: p0[0], y1: p0[1], x2: p1[0], y2: p1[1],
        stroke: DARK, 'stroke-width': darkW(coreW), style: 'stroke-linecap:round;'
      }, parent);
      var ivoryAttrs = {
        x1: p0[0], y1: p0[1], x2: p1[0], y2: p1[1],
        stroke: IVORY, 'stroke-width': coreW, style: 'stroke-linecap:round;'
      };
      if (name) ivoryAttrs['data-ba-part'] = name;
      svgEl('line', ivoryAttrs, parent);
    }
    // A bent limb is two drawBone() segments meeting at a knobbed joint -- an ellipse in
    // the ellipses' own non-scaling-stroke technique, not a third technique of its own.
    function drawBentBone(p0, knee, p1, coreW, knobR, jointName, parent) {
      drawBone(p0, knee, coreW, parent);
      drawBone(knee, p1, coreW, parent);
      svgEl('ellipse', { 'data-ba-part': jointName, cx: knee[0], cy: knee[1], rx: knobR, ry: knobR, fill: IVORY, stroke: DARK, 'stroke-width': OUTLINE_PX, style: STROKE_NS }, parent);
    }

    // Authoring grid: canonical drawing reaches toward local -x (toward the match when
    // landing on its right); mirrored via a figWrap-level scaleX(-1) for a left landing.
    var VB_W = 50, VB_H = 80;
    var ANCHOR_X = VB_W / 2;

    var SKULL = { cx: 25, cy: 12 };
    // The one licensed exception to the ivory/dark two-tone palette: a soft highlight,
    // not a stroke or a filtered glow.
    var GLOSS_COLOR = '#ffffff';
    // A single closed path (start point, then quadratic-Bezier control/end pairs) that
    // narrows to a real waist, with the jaw ellipse overlapping and poking out wider on
    // both sides -- the combined silhouette has a real concave notch where they meet.
    var CRANIUM_PTS = [
      [25, 1], [17.57, 1], [14.48, 6.6], [12, 12.2], [14.48, 17], [16.95, 19.4], [19.43, 19.4],
      [25, 21], [30.57, 19.4], [33.05, 19.4], [35.52, 17], [38, 12.2], [35.52, 6.6], [32.43, 1], [25, 1]
    ];
    function craniumPathD() {
      var d = 'M ' + CRANIUM_PTS[0][0] + ' ' + CRANIUM_PTS[0][1];
      for (var i = 1; i < CRANIUM_PTS.length; i += 2) {
        var c = CRANIUM_PTS[i], e = CRANIUM_PTS[i + 1] || CRANIUM_PTS[0];
        d += ' Q ' + c[0] + ' ' + c[1] + ' ' + e[0] + ' ' + e[1];
      }
      return d + ' Z';
    }
    var JAW_CLOSED = { cx: 25, cy: 22.6, rx: 7.5, ry: 4.4 };
    var EYE_L = { cx: 19, cy: 11.4, rx: 4.3, ry: 4.0 };
    var EYE_R = { cx: 31, cy: 11.4, rx: 4.3, ry: 4.0 };
    // Jaw-clack (oculist-1ta.25) and the raised/pointing-arm pose (oculist-nq1x.4 review,
    // it made the effect read as the removed Foot Tap and Point) were both cut in the
    // playground and stay cut here -- see TIP_REST below, the near arm's only pose.

    var SPINE = { p0: [25, 27], p1: [25, 39], w: 4.0 };
    var SPINE_BEAD_Y = [28.8, 33.0, 37.2];
    var SPINE_BEAD_W = 6.5, SPINE_BEAD_H = 3.2;
    var SPINE_OUTLINE_PX = 2.0;

    // cy is the mean of RIB_TICK_Y, keeping the egg/barrel taper symmetric between the
    // outer and inner rib pairs.
    var RIBCAGE = { cx: 25, cy: 48.75 };
    var RIB_TICK_Y = [39.45, 45.65, 51.85, 58.05];
    var RIB_HALF_SPAN = 10.5;
    var RIB_DIP = 1.0;
    var RIB_CORE_W = 1.8, RIB_OUTLINE_ADD = 1.9;
    function ribDarkW() { return RIB_CORE_W + RIB_OUTLINE_ADD; }
    function ribInset(ty) { return Math.abs(ty - RIBCAGE.cy) * 0.3; }
    function ribEndpoints(ty) {
      var half = RIB_HALF_SPAN - ribInset(ty);
      return [RIBCAGE.cx - half, RIBCAGE.cx + half];
    }
    var STERNUM_X = 23.4, STERNUM_W = 3.2, STERNUM_Y = 39, STERNUM_H = 18, STERNUM_RX = 1.6;
    // Lumbar spine between ribcage and pelvis, drawn and reach-bounded like a limb segment.
    // Mounted inside gRibcage so it stays one of the figure's 8 named pieces.
    var LUMBAR = { p0: [25, 57], p1: [25, 63], w: 3.6 };
    // Self-reach for the ribcage GROUP: each rib pair's own farthest points are its two
    // endpoints plus its dip control point (a quadratic Bezier never leaves the convex
    // hull of its own start/control/end points), each padded by the rib stroke's own half
    // dark-width for the round cap's bulge.
    function ribcageSelfReach() {
      var capR = ribDarkW() / 2, R = 0;
      RIB_TICK_Y.forEach(function (ty) {
        var ends = ribEndpoints(ty);
        [[ends[0], ty], [ends[1], ty], [RIBCAGE.cx, ty + RIB_DIP]].forEach(function (p) {
          var d = Math.hypot(p[0] - RIBCAGE.cx, p[1] - RIBCAGE.cy) + capR;
          if (d > R) R = d;
        });
      });
      [STERNUM_X, STERNUM_X + STERNUM_W].forEach(function (x) {
        [STERNUM_Y, STERNUM_Y + STERNUM_H].forEach(function (y) {
          var d = Math.hypot(x - RIBCAGE.cx, y - RIBCAGE.cy);
          if (d > R) R = d;
        });
      });
      var lumbarCapR = darkW(LUMBAR.w) / 2;
      [LUMBAR.p0, LUMBAR.p1].forEach(function (p) {
        var d = Math.hypot(p[0] - RIBCAGE.cx, p[1] - RIBCAGE.cy) + lumbarCapR;
        if (d > R) R = d;
      });
      return R;
    }
    var R_RIBCAGE_SELF = ribcageSelfReach();

    var PELVIS = { cx: 25, cy: 66 };
    // A true butterfly/two-lobe silhouette: one closed path (start point, then
    // control/end pairs, last pair closing back to the start).
    var PELVIS_PTS = [
      [25, 62.85], [20.1, 59], [15.5, 60.4], [11.4, 62.15], [11.4, 66.7], [11.4, 71.6],
      [17.6, 72.65], [22.1, 73.35], [25, 70.55], [27.9, 73.35], [32.4, 72.65],
      [38.6, 71.6], [38.6, 66.7], [38.6, 62.15], [34.5, 60.4], [29.9, 59]
    ];
    // Bead oculist-nq1x.16 item 2: ry grew 1.4 -> 2.1 (rx unchanged) to
    // clear the prototype checker's tightened pelvis-void background check
    // (see PELVIS_HOLE_L's own comment in effects-playground.html).
    var PELVIS_HOLE_L = { cx: 21, cy: 69.5, rx: 2.2, ry: 2.1 };
    var PELVIS_HOLE_R = { cx: 29, cy: 69.5, rx: 2.2, ry: 2.1 };
    function ellipseHoleSubpath(h) {
      return ' M ' + (h.cx - h.rx) + ' ' + h.cy +
        ' A ' + h.rx + ' ' + h.ry + ' 0 1 0 ' + (h.cx + h.rx) + ' ' + h.cy +
        ' A ' + h.rx + ' ' + h.ry + ' 0 1 0 ' + (h.cx - h.rx) + ' ' + h.cy + ' Z';
    }
    function pelvisPathD() {
      var d = 'M ' + PELVIS_PTS[0][0] + ' ' + PELVIS_PTS[0][1];
      for (var i = 1; i < PELVIS_PTS.length; i += 2) {
        var c = PELVIS_PTS[i], e = PELVIS_PTS[i + 1] || PELVIS_PTS[0];
        d += ' Q ' + c[0] + ' ' + c[1] + ' ' + e[0] + ' ' + e[1];
      }
      d += ' Z';
      // evenodd (set where this path is drawn below) makes each of these two extra closed
      // loops a literal hole in the shell's fill, not a second filled shape.
      d += ellipseHoleSubpath(PELVIS_HOLE_L) + ellipseHoleSubpath(PELVIS_HOLE_R);
      return d;
    }
    // A quadratic Bezier never leaves the convex hull of its own start/control/end points,
    // so the true farthest painted point on the closed path is at most the farthest of
    // PELVIS_PTS from the piece's own rotation center.
    function pelvisSelfReach() {
      var R = 0;
      PELVIS_PTS.forEach(function (p) {
        var d = Math.hypot(p[0] - PELVIS.cx, p[1] - PELVIS.cy);
        if (d > R) R = d;
      });
      return R;
    }
    var R_PELVIS_SELF = pelvisSelfReach();

    var NEAR_HIP = [16, 64], FAR_HIP = [34, 64];
    var NEAR_LEG = { p0: NEAR_HIP, p1: [12, 80], w: 3.4 };
    var FAR_LEG = { p0: FAR_HIP, p1: [38, 80], w: 3.4 };
    // Knee bend points: hip->knee 8 units, knee->foot 8 units.
    var NEAR_KNEE = [12.5, 72], FAR_KNEE = [37.5, 72];
    var KNEE_KNOB_R = 2.6;
    var FOOT_PAD = { rx: 3.0, ry: 1.5 };

    var NEAR_SHOULDER = [13, 41], FAR_SHOULDER = [37, 41];
    var TIP_REST = [7, 60];
    var ARM_W = 4.4;
    var FAR_ARM = { p0: FAR_SHOULDER, p1: [43, 60], w: 4.4 };
    var NEAR_ELBOW = [9, 50], FAR_ELBOW = [41, 50];
    var ELBOW_KNOB_R = 1.9;

    // The run cycle's second leg pose is a hard-cut rotation about the leg's own hip
    // point, not a second drawn shape -- touches only `transform`, so it never adds a new
    // opacity animation (G4 stays structurally 0). KICK_ROT_DEG is a look decision; the
    // reach bound below covers any rotation angle, not just this one.
    var KICK_ROT_DEG = 45;
    // A triangle-inequality chain (distance to the last rigid anchor plus that anchor's
    // own onward segment length plus that segment's half stroke width/knob radius/pad
    // radius) at every joint -- always conservative regardless of the actual angle.
    function legBendPivotReach(hip, knee, foot, coreW, knobR, padRx, padRy) {
      var capR = darkW(coreW) / 2;
      function d(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
      var hipToKnee = d(hip, knee), kneeToFoot = d(knee, foot);
      return Math.max(
        hipToKnee + capR,
        hipToKnee + knobR,
        hipToKnee + kneeToFoot + capR,
        hipToKnee + kneeToFoot + Math.max(padRx, padRy)
      );
    }
    var R_NEAR_LEG_PIVOT = legBendPivotReach(NEAR_HIP, NEAR_KNEE, NEAR_LEG.p1, NEAR_LEG.w, KNEE_KNOB_R, FOOT_PAD.rx, FOOT_PAD.ry);
    var R_FAR_LEG_PIVOT = legBendPivotReach(FAR_HIP, FAR_KNEE, FAR_LEG.p1, FAR_LEG.w, KNEE_KNOB_R, FOOT_PAD.rx, FOOT_PAD.ry);

    // Clearance derivation, DERIVED from the geometry above (rest pose, every scatter-in
    // start point, and the collapse heap), not hand-picked. ellipseReach()/boneReach()-
    // style helpers each return the EXACT local x-extent of a shape under ANY rotation
    // about its own center; sampling just the two endpoints of each piece's own straight
    // WAAPI translate (rest<->scatter-start, rest<->heap) bounds the whole segment.
    var minX = Infinity, maxX = -Infinity;
    function boneReach(p0, p1, coreW) {
      var midX = (p0[0] + p1[0]) / 2;
      var halfLen = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / 2;
      var R = halfLen + darkW(coreW) / 2;
      if (midX - R < minX) minX = midX - R;
      if (midX + R > maxX) maxX = midX + R;
    }
    function selfReachXY(cx, R) {
      if (cx - R < minX) minX = cx - R;
      if (cx + R > maxX) maxX = cx + R;
    }

    // gSkull is a RIGID GROUP (cranium plus both eye sockets and the jaw) that all rotate
    // together about (SKULL.cx, SKULL.cy). For any point P on any sub-shape, the triangle
    // inequality gives |P - rotCenter| <= |subShapeCenter - rotCenter| + subShapeOwnReach,
    // a safe bound on the true swept-circle radius under any rotation angle -- needed for
    // the roll's ~150deg travel, not just the small scatter wobble elsewhere.
    function skullSelfReach() {
      var R = 0;
      CRANIUM_PTS.forEach(function (p) {
        var d = Math.hypot(p[0] - SKULL.cx, p[1] - SKULL.cy);
        if (d > R) R = d;
      });
      [EYE_L, EYE_R, JAW_CLOSED].forEach(function (s) {
        var d = Math.hypot(s.cx - SKULL.cx, s.cy - SKULL.cy);
        var reach = d + Math.max(s.rx, s.ry);
        if (reach > R) R = reach;
      });
      return R;
    }
    var R_SKULL_SELF = skullSelfReach();

    selfReachXY(SKULL.cx, R_SKULL_SELF);
    selfReachXY(RIBCAGE.cx, R_RIBCAGE_SELF);
    selfReachXY(PELVIS.cx, R_PELVIS_SELF);
    boneReach(SPINE.p0, SPINE.p1, SPINE.w);
    boneReach(NEAR_LEG.p0, NEAR_LEG.p1, NEAR_LEG.w);
    boneReach(FAR_LEG.p0, FAR_LEG.p1, FAR_LEG.w);
    boneReach(NEAR_SHOULDER, TIP_REST, ARM_W);
    boneReach(FAR_ARM.p0, FAR_ARM.p1, FAR_ARM.w);

    // Scatter-in: hand-picked (start dx, dy, deg) per moving piece -- no Math.random
    // anywhere, deliberately irregular so the eye reads a gathering rather than a
    // mechanical stagger.
    var SCATTER = {
      skull: { dx: 0, dy: -50, deg: -35 },
      ribcage: { dx: -20, dy: -34, deg: -65 },
      pelvis: { dx: 4, dy: 36, deg: 45 },
      spine: { dx: 22, dy: -24, deg: 60 },
      nearLeg: { dx: -14, dy: 30, deg: -55 },
      farLeg: { dx: 20, dy: 26, deg: 70 },
      nearArm: { dx: -26, dy: -10, deg: -80 },
      farArm: { dx: 22, dy: -16, deg: 75 }
    };
    // Collapse heap: each piece's local-unit drop is sized off its OWN rest y so it lands
    // clustered near the feet baseline.
    var HEAP = {
      ribcage: { dx: 2, dy: 24, deg: -70 },
      pelvis: { dx: 0, dy: 5, deg: 20 },
      spine: { dx: -2, dy: 36, deg: -55 },
      nearLeg: { dx: 5, dy: 6, deg: 65 },
      farLeg: { dx: -5, dy: 6, deg: -60 },
      nearArm: { dx: 6, dy: 22, deg: 70 },
      farArm: { dx: -6, dy: 22, deg: -65 }
    };
    // The skull's roll, hand-authored (no Math.random). It detaches after the snap and
    // rolls along the baseline toward the match (local -x). Rotation is DERIVED from
    // distance covered: ROLL_DEG_PER_UNIT is the exact rolling-without-slipping rate for a
    // wheel of radius ROLL_R_LOCAL, so deg = dx * ROLL_DEG_PER_UNIT keeps rotation and
    // translation in agreement at every instant -- this is what makes it read as rolling
    // rather than skating.
    function craniumBoundingSemiAxes() {
      var minCX = Infinity, maxCX = -Infinity, minCY = Infinity, maxCY = -Infinity;
      CRANIUM_PTS.forEach(function (p) {
        if (p[0] < minCX) minCX = p[0]; if (p[0] > maxCX) maxCX = p[0];
        if (p[1] < minCY) minCY = p[1]; if (p[1] > maxCY) maxCY = p[1];
      });
      return [(maxCX - minCX) / 2, Math.max(SKULL.cy - minCY, maxCY - SKULL.cy)];
    }
    var CRANIUM_SEMI_AXES = craniumBoundingSemiAxes();
    var ROLL_R_LOCAL = (CRANIUM_SEMI_AXES[0] + CRANIUM_SEMI_AXES[1]) / 2;
    var ROLL_DEG_PER_UNIT = (180 / Math.PI) / ROLL_R_LOCAL;
    // The settle keyframe (a multiple of 360, see ROLL_SETTLE_DEG below) lands the skull
    // back upright at the same ground line the feet already rest on: the leg's own dark
    // under-stroke round cap, the true lowest painted point (not the smaller foot-pad
    // ellipse).
    var SKULL_LOWEST_Y = JAW_CLOSED.cy + JAW_CLOSED.ry;
    var FEET_LOWEST_Y = NEAR_LEG.p1[1] + darkW(NEAR_LEG.w) / 2;
    var ROLL_DX_TD = -6;
    var ROLL_DY_TD = FEET_LOWEST_Y - SKULL_LOWEST_Y;
    var ROLL_DEG_TD = ROLL_DX_TD * ROLL_DEG_PER_UNIT;
    var ROLL_DX_TOTAL = -38, ROLL_DY_TOTAL = ROLL_DY_TD;
    var ROLL_DEG_TOTAL = ROLL_DX_TOTAL * ROLL_DEG_PER_UNIT;
    // oculist-1ta.33: the physically-exact end of the roll (-150.15deg) is upside down; at
    // 1x the eye-sockets-above-jaw arrangement is the only thing carrying the skull read.
    // The settle segment below continues the roll's own CCW direction to -360deg (visually
    // identical to 0deg, any multiple of 360 is) rather than reversing back to the nearest
    // multiple -- reversing read as a backward flick, fixed under review round 2.
    var ROLL_SETTLE_DEG = -360;

    var REST_CX = {
      skull: SKULL.cx, ribcage: RIBCAGE.cx, pelvis: PELVIS.cx,
      spine: (SPINE.p0[0] + SPINE.p1[0]) / 2,
      nearLeg: (NEAR_LEG.p0[0] + NEAR_LEG.p1[0]) / 2,
      farLeg: (FAR_LEG.p0[0] + FAR_LEG.p1[0]) / 2,
      nearArm: (NEAR_SHOULDER[0] + TIP_REST[0]) / 2,
      farArm: (FAR_ARM.p0[0] + FAR_ARM.p1[0]) / 2
    };
    var REST_R = {
      skull: R_SKULL_SELF, ribcage: R_RIBCAGE_SELF, pelvis: R_PELVIS_SELF,
      spine: Math.hypot(SPINE.p1[0] - SPINE.p0[0], SPINE.p1[1] - SPINE.p0[1]) / 2 + darkW(SPINE.w) / 2,
      nearLeg: Math.hypot(NEAR_LEG.p1[0] - NEAR_LEG.p0[0], NEAR_LEG.p1[1] - NEAR_LEG.p0[1]) / 2 + darkW(NEAR_LEG.w) / 2,
      farLeg: Math.hypot(FAR_LEG.p1[0] - FAR_LEG.p0[0], FAR_LEG.p1[1] - FAR_LEG.p0[1]) / 2 + darkW(FAR_LEG.w) / 2,
      nearArm: Math.hypot(TIP_REST[0] - NEAR_SHOULDER[0], TIP_REST[1] - NEAR_SHOULDER[1]) / 2 + darkW(ARM_W) / 2,
      farArm: Math.hypot(FAR_ARM.p1[0] - FAR_ARM.p0[0], FAR_ARM.p1[1] - FAR_ARM.p0[1]) / 2 + darkW(FAR_ARM.w) / 2
    };
    Object.keys(REST_CX).forEach(function (k) {
      var cx = REST_CX[k], R = REST_R[k], sc = SCATTER[k], hp = HEAP[k] || { dx: 0 };
      if (cx - R < minX) minX = cx - R;
      if (cx + R > maxX) maxX = cx + R;
      if (cx + sc.dx - R < minX) minX = cx + sc.dx - R;
      if (cx + sc.dx + R > maxX) maxX = cx + sc.dx + R;
      if (cx + hp.dx - R < minX) minX = cx + hp.dx - R;
      if (cx + hp.dx + R > maxX) maxX = cx + hp.dx + R;
    });

    // dx runs 0 -> ROLL_DX_TD -> ROLL_DX_TOTAL monotonically toward the match, so the two
    // roll keyframes below are the path's actual extremes; both are sampled explicitly.
    [ROLL_DX_TD, ROLL_DX_TOTAL].forEach(function (dx) {
      var cx = SKULL.cx + dx;
      if (cx - R_SKULL_SELF < minX) minX = cx - R_SKULL_SELF;
      if (cx + R_SKULL_SELF > maxX) maxX = cx + R_SKULL_SELF;
    });

    // Every OTHER piece is inside gBody, which itself translates DASH_DX_TOTAL local units
    // toward the match while the skull rolls (concurrent, not after) -- every REST_CX/
    // REST_R/HEAP contribution needs the same dash shift folded in. SCATTER positions are
    // the one exception: they finish strictly before gBody starts moving.
    var DASH_DX_TOTAL = -20;
    Object.keys(REST_CX).forEach(function (k) {
      var cx = REST_CX[k], R = REST_R[k], hp = HEAP[k] || { dx: 0 };
      if (cx + DASH_DX_TOTAL - R < minX) minX = cx + DASH_DX_TOTAL - R;
      if (cx + DASH_DX_TOTAL + R > maxX) maxX = cx + DASH_DX_TOTAL + R;
      if (cx + hp.dx + DASH_DX_TOTAL - R < minX) minX = cx + hp.dx + DASH_DX_TOTAL - R;
      if (cx + hp.dx + DASH_DX_TOTAL + R > maxX) maxX = cx + hp.dx + DASH_DX_TOTAL + R;
    });
    // The run cycle's own hip-pivot rotation only ever turns while gBody is dashing, so
    // its reach needs the same shift; R_*_LEG_PIVOT already bounds any rotation angle
    // about the hip, so only the shifted (more negative) end needs adding here.
    [[NEAR_HIP, R_NEAR_LEG_PIVOT], [FAR_HIP, R_FAR_LEG_PIVOT]].forEach(function (pair) {
      var cx = pair[0][0] + DASH_DX_TOTAL, R = pair[1];
      if (cx - R < minX) minX = cx - R;
      if (cx + R > maxX) maxX = cx + R;
    });

    var REACH_INWARD_LOCAL = ANCHOR_X - minX;
    var REACH_OUTWARD_LOCAL = maxX - ANCHOR_X;

    // beaconScale multiplies the match-relative clamp so Settings > Beacon Size still
    // governs this figure's on-screen size, exactly like every other beacon effect's own
    // scale knob.
    var figHeight = Math.max(100, Math.min(110, 2.6 * rect.height)) * beaconScale;
    var figScale = figHeight / VB_H;
    var figWidth = VB_W * figScale;

    // GAP is the bare clearance floor; SCREEN_STROKE_MARGIN folds in half the ellipses'
    // own non-scaling OUTLINE_PX plus a small antialiasing/subpixel slack.
    var GAP = 10;
    var SCREEN_STROKE_MARGIN = OUTLINE_PX / 2 + 1.0;
    var REACH_INWARD = REACH_INWARD_LOCAL * figScale + SCREEN_STROKE_MARGIN;
    var REACH_OUTWARD = REACH_OUTWARD_LOCAL * figScale + SCREEN_STROKE_MARGIN;

    // Side selection: right by default, mirror left only if the right doesn't fit. Fit
    // decisions are made from the PRE-SCROLL viewport rect -- room on screen is a viewport
    // question even though the figure itself mounts in document coordinates below.
    var sideRight = { x: rect.right + GAP + REACH_INWARD, side: 'right' };
    sideRight.fits = sideRight.x + REACH_OUTWARD <= vw - 4;
    var sideLeft = { x: rect.left - GAP - REACH_INWARD, side: 'left' };
    sideLeft.fits = sideLeft.x - REACH_OUTWARD >= 4;
    var landing = sideRight.fits ? sideRight : (sideLeft.fits ? sideLeft : sideRight);
    var mirrored = landing.side !== 'right';
    var pivotX = landing.x;
    var feetBaselineY = rect.bottom;

    var figLeft = pivotX - figWidth / 2;
    var figTop = feetBaselineY - figHeight;

    // Defensive backstop, independent of the arithmetic above: read the box this effect is
    // about to draw and suppress the WHOLE figure -- never just one piece -- if it would
    // still overlap the match (oculist-1ta.24's own lesson: a partial figure can read as
    // the wrong thing entirely). Still viewport space, matching the fit decision above.
    function localXToScreen(lx) {
      return figLeft + (mirrored ? (figWidth - lx * figScale) : (lx * figScale));
    }
    var boxA = localXToScreen(minX), boxB = localXToScreen(maxX);
    var boxLeft = Math.min(boxA, boxB), boxRight = Math.max(boxA, boxB);
    if (boxLeft < rect.right && boxRight > rect.left) return;

    // Document coordinates from here on: figLeft/figTop above are viewport-space
    // placement math, converted to document space only at the point of mounting.
    var docLeft = figLeft + window.scrollX;
    var docTop = figTop + window.scrollY;

    var figWrap = document.createElement('div');
    figWrap.className = 'oc-beacon oc-beacon-transient';
    figWrap.style.cssText = [
      'position:absolute',
      'left:' + docLeft + 'px', 'top:' + docTop + 'px',
      'width:' + figWidth + 'px', 'height:' + figHeight + 'px',
      'pointer-events:none',
      'z-index:2147483642'
    ].join(';') + (mirrored ? ';transform:scaleX(-1)' : '');
    document.documentElement.appendChild(figWrap);

    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', String(figWidth));
    svg.setAttribute('height', String(figHeight));
    svg.setAttribute('viewBox', '0 0 ' + VB_W + ' ' + VB_H);
    svg.style.cssText = 'display:block;overflow:visible;';
    figWrap.appendChild(svg);

    // clickG carries only the snap "click" scale-pulse, kept separate from figWrap's own
    // static mirror transform so animating clickG's transform never has to re-specify it.
    var clickG = document.createElementNS(NS, 'g');
    clickG.style.cssText = 'transform-origin:' + ANCHOR_X + 'px 50px;';
    svg.appendChild(clickG);

    var mirrorG = document.createElementNS(NS, 'g');
    clickG.appendChild(mirrorG);

    function pieceG(parent, name) {
      var g = document.createElementNS(NS, 'g');
      if (name) g.setAttribute('data-ba-piece', name);
      parent.appendChild(g);
      return g;
    }

    // Static art, drawn once at each piece's own assembled/rest local coordinates -- every
    // beat is a CSS transform layered on top via WAAPI, never a redraw.
    var gSkull = pieceG(mirrorG, 'skull');
    gSkull.style.cssText = 'transform-origin:' + SKULL.cx + 'px ' + SKULL.cy + 'px;';
    // Jaw painted before cranium so the cranium's own silhouette covers the part of the
    // jaw that overlaps it, leaving only the jaw's own bulge visible beyond the waist.
    svgEl('ellipse', { 'data-ba-part': 'jaw', cx: JAW_CLOSED.cx, cy: JAW_CLOSED.cy, rx: JAW_CLOSED.rx, ry: JAW_CLOSED.ry, fill: IVORY, stroke: DARK, 'stroke-width': OUTLINE_PX, style: STROKE_NS }, gSkull);
    svgEl('path', { 'data-ba-part': 'cranium', d: craniumPathD(), fill: IVORY, stroke: DARK, 'stroke-width': OUTLINE_PX, style: STROKE_NS }, gSkull);
    svgEl('ellipse', { 'data-ba-part': 'gloss', cx: '19', cy: '6.2', rx: '3.6', ry: '1.5', fill: GLOSS_COLOR, transform: 'rotate(-20 19 6.2)' }, gSkull);
    svgEl('ellipse', { 'data-ba-part': 'eye-left', cx: EYE_L.cx, cy: EYE_L.cy, rx: EYE_L.rx, ry: EYE_L.ry, fill: DARK }, gSkull);
    svgEl('ellipse', { 'data-ba-part': 'eye-right', cx: EYE_R.cx, cy: EYE_R.cy, rx: EYE_R.rx, ry: EYE_R.ry, fill: DARK }, gSkull);
    svgEl('path', { 'data-ba-part': 'nose', d: 'M 25 13.4 L 22.3 16.6 Q 25 17.8 27.7 16.6 Z', fill: DARK }, gSkull);
    svgEl('path', { 'data-ba-part': 'teeth', d: 'M 20 20.6 Q 25 22.6 30 20.6 M 22.5 21.6 L 22.5 22.8 M 25 21.9 L 25 23.2 M 27.5 21.6 L 27.5 22.8', fill: 'none', stroke: DARK, 'stroke-width': '1.1', style: STROKE_NS }, gSkull);

    // Every piece EXCEPT the skull mounts inside gBody, so one translateX on gBody moves
    // the whole body while each piece still plays its own scatter/collapse transform.
    var gBody = pieceG(mirrorG);

    var gRibcage = pieceG(gBody, 'ribcage');
    gRibcage.style.cssText = 'transform-origin:' + RIBCAGE.cx + 'px ' + RIBCAGE.cy + 'px;';
    // An OPEN cage of four rib pairs (the dark-under/ivory-over two-stroke idiom, via
    // <path> so it can curve) plus a vertical sternum -- real voids between rows show
    // whatever is behind the figure.
    RIB_TICK_Y.forEach(function (ty) {
      var ends = ribEndpoints(ty);
      var d = 'M ' + ends[0] + ' ' + ty + ' Q ' + RIBCAGE.cx + ' ' + (ty + RIB_DIP) + ' ' + ends[1] + ' ' + ty;
      svgEl('path', { d: d, fill: 'none', stroke: DARK, 'stroke-width': String(ribDarkW()), style: 'stroke-linecap:round;' }, gRibcage);
      svgEl('path', { 'data-ba-part': 'rib-' + ty, d: d, fill: 'none', stroke: IVORY, 'stroke-width': String(RIB_CORE_W), style: 'stroke-linecap:round;' }, gRibcage);
    });
    svgEl('rect', { 'data-ba-part': 'sternum', x: STERNUM_X, y: STERNUM_Y, width: STERNUM_W, height: STERNUM_H, rx: STERNUM_RX, fill: IVORY, stroke: DARK, 'stroke-width': '1.2', style: STROKE_NS }, gRibcage);
    drawBone(LUMBAR.p0, LUMBAR.p1, LUMBAR.w, gRibcage, 'lumbar');

    var gPelvis = pieceG(gBody, 'pelvis');
    gPelvis.style.cssText = 'transform-origin:' + PELVIS.cx + 'px ' + PELVIS.cy + 'px;';
    // The two voids are cut directly into the shell path's own fill (fill-rule:evenodd),
    // a real hole rather than an opaque dark ellipse laid on top -- the outline traces
    // both the outer silhouette and each hole's own inner boundary.
    svgEl('path', { 'data-ba-part': 'pelvis-shell', d: pelvisPathD(), fill: IVORY, stroke: DARK, 'stroke-width': OUTLINE_PX, style: STROKE_NS + 'fill-rule:evenodd;' }, gPelvis);
    // Position/size record only (fill:none, not painted) -- the actual void is the
    // evenodd cutout above, built from these same two objects so the two can never drift
    // apart.
    svgEl('ellipse', { 'data-ba-part': 'pelvis-hole-left', cx: String(PELVIS_HOLE_L.cx), cy: String(PELVIS_HOLE_L.cy), rx: String(PELVIS_HOLE_L.rx), ry: String(PELVIS_HOLE_L.ry), fill: 'none' }, gPelvis);
    svgEl('ellipse', { 'data-ba-part': 'pelvis-hole-right', cx: String(PELVIS_HOLE_R.cx), cy: String(PELVIS_HOLE_R.cy), rx: String(PELVIS_HOLE_R.rx), ry: String(PELVIS_HOLE_R.ry), fill: 'none' }, gPelvis);

    var gSpine = pieceG(gBody, 'spine');
    gSpine.style.cssText = 'transform-origin:' + REST_CX.spine + 'px ' + ((SPINE.p0[1] + SPINE.p1[1]) / 2) + 'px;';
    SPINE_BEAD_Y.forEach(function (by, i) {
      svgEl('rect', {
        'data-ba-part': 'vertebra-' + i, x: SPINE.p0[0] - SPINE_BEAD_W / 2, y: by - SPINE_BEAD_H / 2,
        width: SPINE_BEAD_W, height: SPINE_BEAD_H, rx: SPINE_BEAD_H / 2,
        fill: IVORY, stroke: DARK, 'stroke-width': String(SPINE_OUTLINE_PX), style: STROKE_NS
      }, gSpine);
    });

    // Legs: the wrapper keeps the scatter/collapse transform; the run cycle rotates an
    // inner pivot group (transform-origin the leg's own hip point) between 0deg and
    // KICK_ROT_DEG by hard cut. Nested inside the wrapper so the two compose.
    var gNearLeg = pieceG(gBody, 'near-leg');
    gNearLeg.style.cssText = 'transform-origin:' + REST_CX.nearLeg + 'px ' + ((NEAR_LEG.p0[1] + NEAR_LEG.p1[1]) / 2) + 'px;';
    var gNearLegPivot = pieceG(gNearLeg);
    gNearLegPivot.style.cssText = 'transform-origin:' + NEAR_HIP[0] + 'px ' + NEAR_HIP[1] + 'px;';
    drawBentBone(NEAR_LEG.p0, NEAR_KNEE, NEAR_LEG.p1, NEAR_LEG.w, KNEE_KNOB_R, 'near-knee', gNearLegPivot);
    svgEl('ellipse', { 'data-ba-part': 'near-foot-pad', cx: NEAR_LEG.p1[0], cy: NEAR_LEG.p1[1], rx: FOOT_PAD.rx, ry: FOOT_PAD.ry, fill: IVORY, stroke: DARK, 'stroke-width': OUTLINE_PX, style: STROKE_NS }, gNearLegPivot);

    var gFarLeg = pieceG(gBody, 'far-leg');
    gFarLeg.style.cssText = 'transform-origin:' + REST_CX.farLeg + 'px ' + ((FAR_LEG.p0[1] + FAR_LEG.p1[1]) / 2) + 'px;';
    var gFarLegPivot = pieceG(gFarLeg);
    gFarLegPivot.style.cssText = 'transform-origin:' + FAR_HIP[0] + 'px ' + FAR_HIP[1] + 'px;';
    drawBentBone(FAR_LEG.p0, FAR_KNEE, FAR_LEG.p1, FAR_LEG.w, KNEE_KNOB_R, 'far-knee', gFarLegPivot);
    svgEl('ellipse', { 'data-ba-part': 'far-foot-pad', cx: FAR_LEG.p1[0], cy: FAR_LEG.p1[1], rx: FOOT_PAD.rx, ry: FOOT_PAD.ry, fill: IVORY, stroke: DARK, 'stroke-width': OUTLINE_PX, style: STROKE_NS }, gFarLegPivot);

    var gFarArm = pieceG(gBody, 'far-arm');
    gFarArm.style.cssText = 'transform-origin:' + REST_CX.farArm + 'px ' + ((FAR_ARM.p0[1] + FAR_ARM.p1[1]) / 2) + 'px;';
    drawBentBone(FAR_ARM.p0, FAR_ELBOW, FAR_ARM.p1, FAR_ARM.w, ELBOW_KNOB_R, 'far-elbow', gFarArm);

    // Near arm: single rest pose only now that the point beat is cut.
    var gNearArm = pieceG(gBody, 'near-arm');
    gNearArm.style.cssText = 'transform-origin:' + REST_CX.nearArm + 'px ' + ((NEAR_SHOULDER[1] + TIP_REST[1]) / 2) + 'px;';
    drawBentBone(NEAR_SHOULDER, NEAR_ELBOW, TIP_REST, ARM_W, ELBOW_KNOB_R, 'near-elbow', gNearArm);

    // oculist-1ta.33: re-append gSkull last so it paints above the whole figure during the
    // roll (SVG paints in document order) -- appendChild() on an attached node re-parents
    // rather than duplicating it.
    mirrorG.appendChild(gSkull);

    var PIECES = {
      skull: gSkull, ribcage: gRibcage, pelvis: gPelvis, spine: gSpine,
      nearLeg: gNearLeg, farLeg: gFarLeg, nearArm: gNearArm, farArm: gFarArm
    };
    // The seven pieces that collapse into the heap -- the skull left earlier, on its own,
    // via the roll, and gets its own dedicated .animate() call instead.
    var COLLAPSE_PIECES = {
      ribcage: gRibcage, pelvis: gPelvis, spine: gSpine,
      nearLeg: gNearLeg, farLeg: gFarLeg, nearArm: gNearArm, farArm: gFarArm
    };

    // Timeline (ms): every literal value below is the playground's own millisecond
    // constant times durFactor, so Settings > Animation Speed scales the whole beat
    // sequence -- including every derived sum -- exactly like animateTrail's own duration.
    var STAGGER = {
      skull: 0, spine: 35 * durFactor, ribcage: 65 * durFactor, farArm: 85 * durFactor,
      farLeg: 100 * durFactor, pelvis: 120 * durFactor, nearLeg: 145 * durFactor, nearArm: 170 * durFactor
    };
    var SNAP_DONE_T = 640 * durFactor;
    var CLICK_DUR = 90 * durFactor;
    // The roll starts the instant the click pulse ends -- no dead air between the snap
    // and the roll.
    var ROLL_START = SNAP_DONE_T + CLICK_DUR;
    var ROLL_TD_MS = 100 * durFactor;
    var ROLL_TRAVEL_MS = 300 * durFactor;
    var ROLL_SETTLE_MS = 300 * durFactor;
    var ROLL_DUR = ROLL_TD_MS + ROLL_TRAVEL_MS + ROLL_SETTLE_MS;
    var ROLL_TD_OFFSET = ROLL_TD_MS / ROLL_DUR;
    var ROLL_SETTLE_OFFSET = (ROLL_TD_MS + ROLL_TRAVEL_MS) / ROLL_DUR;
    var COLLAPSE_START = ROLL_START + ROLL_DUR;
    // The body starts halfway through the skull's actual travel, after its detach/drop
    // and once it has a visible lead -- concurrent with the roll without painting the
    // skull over the legs for the whole run. Still ends at COLLAPSE_START.
    var DASH_START = ROLL_START + ROLL_TD_MS + ROLL_TRAVEL_MS / 2;
    var DASH_DUR = COLLAPSE_START - DASH_START;
    var RUN_PERIOD = 150 * durFactor;
    var COLLAPSE_DUR = 440 * durFactor;
    var HEAP_HOLD = 300 * durFactor;
    var FADE_DUR = 200 * durFactor;

    // Small overshoot alternates sign per piece for an organic settle wobble --
    // rotational only, translation goes straight start->rest.
    var OVERSHOOT_DEG = { skull: -10, spine: 9, ribcage: 11, farArm: -8, farLeg: 10, pelvis: -9, nearLeg: 8, nearArm: -11 };
    // Collapse stagger: each piece's own fall duration is COLLAPSE_DUR minus its own
    // stagger, so all seven independently start falling at different moments but land in
    // the heap at the same absolute instant.
    var COLLAPSE_STAGGER = {
      ribcage: 40 * durFactor, spine: 70 * durFactor, farArm: 95 * durFactor, farLeg: 115 * durFactor,
      pelvis: 140 * durFactor, nearLeg: 160 * durFactor, nearArm: 185 * durFactor
    };

    // Every Animation this beacon creates is collected here and hung off figWrap (the
    // single .oc-beacon-transient element cancelBeacons() selects). Unlike a single-
    // element effect (animateTrail's line/arrow/flash, each its own top-level node with
    // its own independent .finished), this is ONE figure built from many staggered
    // per-piece animations that settle at different times -- the earliest scatter-in
    // piece finishes around 640ms, long before the roll/dash/collapse even start.
    // Attaching .finished.then(remove) to EACH animation individually (as animateTrail's
    // own idiom does) would tear the figure down the instant the FIRST one finishes,
    // hiding the snap/roll/dash/collapse entirely -- measured: present at 500ms, gone by
    // 700ms. track() only collects anims here; the single removal below waits for the
    // LAST one (chronologically the figWrap fade, see its own .animate() call).
    var anims = [];
    function removeFig() { figWrap.remove(); }
    function track(anim) {
      anims.push(anim);
      return anim;
    }

    Object.keys(PIECES).forEach(function (k) {
      var g = PIECES[k], sc = SCATTER[k], stag = STAGGER[k], ov = OVERSHOOT_DEG[k];
      var dur = SNAP_DONE_T - stag;
      track(g.animate([
        { transform: 'translate(' + sc.dx + 'px,' + sc.dy + 'px) rotate(' + sc.deg + 'deg)', offset: 0 },
        { transform: 'translate(0px,0px) rotate(' + ov + 'deg)', offset: 0.85 },
        { transform: 'translate(0px,0px) rotate(0deg)', offset: 1 }
      ], { duration: dur, delay: stag, easing: 'ease-out', fill: 'forwards' }));
    });

    // Click pulse: the whole assembled figure gives a brief scale punch the instant every
    // piece has independently settled.
    track(clickG.animate([
      { transform: 'scale(1)', offset: 0 },
      { transform: 'scale(1.12)', offset: 0.5 },
      { transform: 'scale(1)', offset: 1 }
    ], { duration: CLICK_DUR, delay: SNAP_DONE_T, easing: 'ease-out' }));

    // Skull roll: offset 0->ROLL_TD_OFFSET is the detach-and-drop onto the baseline
    // (mostly vertical, easing in for a falling accelerate); offset ROLL_TD_OFFSET-
    // >ROLL_SETTLE_OFFSET is the actual roll at constant height (translate and rotate
    // change linearly together, the physically exact rolling-without-slipping
    // relationship); offset ROLL_SETTLE_OFFSET->1 holds translate fixed and only eases
    // rotation the rest of the way to ROLL_SETTLE_DEG.
    track(gSkull.animate([
      { transform: 'translate(0px,0px) rotate(0deg)', offset: 0, easing: 'ease-in' },
      { transform: 'translate(' + ROLL_DX_TD + 'px,' + ROLL_DY_TD + 'px) rotate(' + ROLL_DEG_TD + 'deg)', offset: ROLL_TD_OFFSET, easing: 'linear' },
      { transform: 'translate(' + ROLL_DX_TOTAL + 'px,' + ROLL_DY_TOTAL + 'px) rotate(' + ROLL_DEG_TOTAL + 'deg)', offset: ROLL_SETTLE_OFFSET, easing: 'ease-out' },
      { transform: 'translate(' + ROLL_DX_TOTAL + 'px,' + ROLL_DY_TOTAL + 'px) rotate(' + ROLL_SETTLE_DEG + 'deg)', offset: 1 }
    ], { duration: ROLL_DUR, delay: ROLL_START, fill: 'forwards' }));

    // Body dash: gBody -- every piece except the skull -- translates DASH_DX_TOTAL local
    // units toward the match, concurrently with the latter half of the roll above.
    track(gBody.animate([
      { transform: 'translate(0px,0px)', offset: 0 },
      { transform: 'translate(' + DASH_DX_TOTAL + 'px,0px)', offset: 1 }
    ], { duration: DASH_DUR, delay: DASH_START, easing: 'ease-in-out', fill: 'forwards' }));

    // Run cycle: two discrete whole-frame leg poses swapped by hard cut. nearLeg and
    // farLeg run OUT OF PHASE, a scissor rather than one leg twitching alone.
    var runKickFirst = [
      { transform: 'rotate(' + KICK_ROT_DEG + 'deg)', offset: 0 }, { transform: 'rotate(' + KICK_ROT_DEG + 'deg)', offset: 0.49 },
      { transform: 'rotate(0deg)', offset: 0.5 }, { transform: 'rotate(0deg)', offset: 1 }
    ];
    var runRestFirst = [
      { transform: 'rotate(0deg)', offset: 0 }, { transform: 'rotate(0deg)', offset: 0.49 },
      { transform: 'rotate(' + KICK_ROT_DEG + 'deg)', offset: 0.5 }, { transform: 'rotate(' + KICK_ROT_DEG + 'deg)', offset: 1 }
    ];
    var runIter = DASH_DUR / RUN_PERIOD;
    track(gNearLegPivot.animate(runKickFirst, { duration: RUN_PERIOD, delay: DASH_START, iterations: runIter, fill: 'forwards' }));
    track(gFarLegPivot.animate(runRestFirst, { duration: RUN_PERIOD, delay: DASH_START, iterations: runIter, fill: 'forwards' }));
    // Force both pivots back to rotate(0deg) exactly at COLLAPSE_START: the alternation
    // above leaves farLeg at KICK_ROT_DEG, the opposite of what COLLAPSE_PIECES assumes.
    // A duration:1 cut only reaches its end value one ms after its delay, so starting it
    // 1ms early lands it fully switched by COLLAPSE_START, not one frame late.
    track(gNearLegPivot.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(0deg)' }], { duration: 1, delay: COLLAPSE_START - 1, fill: 'forwards' }));
    track(gFarLegPivot.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(0deg)' }], { duration: 1, delay: COLLAPSE_START - 1, fill: 'forwards' }));

    // Collapse: a second .animate() call per piece, explicitly starting from the same
    // translate(0,0) rotate(0deg) the scatter/snap call above settles at. Only the seven
    // COLLAPSE_PIECES -- the skull already left via the roll above.
    Object.keys(COLLAPSE_PIECES).forEach(function (k) {
      var g = COLLAPSE_PIECES[k], hp = HEAP[k], stag = COLLAPSE_STAGGER[k];
      var dur = COLLAPSE_DUR - stag;
      track(g.animate([
        { transform: 'translate(0px,0px) rotate(0deg)', offset: 0 },
        { transform: 'translate(' + hp.dx + 'px,' + hp.dy + 'px) rotate(' + hp.deg + 'deg)', offset: 1 }
      ], { duration: dur, delay: COLLAPSE_START + stag, easing: 'ease-in', fill: 'forwards' }));
    });

    // Heap holds briefly, then fades -- nothing persists.
    track(figWrap.animate([
      { opacity: 1 }, { opacity: 0 }
    ], { duration: FADE_DUR, delay: COLLAPSE_START + COLLAPSE_DUR + HEAP_HOLD, fill: 'forwards' }));

    figWrap.__waapiAnims = anims;

    // Natural completion removes the figure only once EVERY animation has settled --
    // Promise.allSettled resolves once the last of them does, which is the fade above
    // (its own delay+duration sum to the effect's true end). Rule 5's "a cancel still
    // cleans up" is already satisfied a different way here: destroyBeacon() (content.js)
    // removes figWrap synchronously, the instant cancelBeacons() reaches it, regardless of
    // this promise -- .cancel()ing every entry in __waapiAnims (which destroyBeacon()
    // also does) rejects each one's own .finished, so this still resolves shortly after
    // too, but that second removeFig() call is a harmless no-op (Element.remove() on an
    // already-detached node), not a competing or required cleanup path.
    Promise.allSettled(anims.map(function (a) { return a.finished; })).then(removeFig);
  }

  // oculist-e2m.5: promotes fxFlappy (artifacts/prototypes/effects-playground.html,
  // reworked as pixel art across a1011ca and its predecessors) into the shipped beacon
  // contract, the second entry in the Halloween pack. A small bird flies a sawtooth of
  // parabolic arcs from the cursor (or its fallback) to the match, perches on the match's
  // top edge, then the absorption flash animateTrail already uses fires on the match rect.
  //
  // Physics generates the whole flight polyline once at fire time (no rAF loop) and hands
  // it to offset-path/offset-rotate:auto, exactly animateTrail's own idiom -- see the
  // physics/retiming comments inline below, carried over from the playground almost
  // verbatim since they document real, previously-fixed bugs (an off-level landing, a
  // wing that rendered invisibly inside its own body silhouette, a miscounted sprite row)
  // that must not come back.
  //
  // Start point: the promotion contract's own start-point cascade (rule 9) --
  // lastMouseX/lastMouseY if known, else the find bar's own centre, else viewport centre --
  // replaces the playground's nearest-viewport-edge pick entirely; `mirrored` is derived
  // from where that cascade actually lands (start right of the match), not from a fixed
  // edge choice, so the mirrored scaleX(-1) + 180deg offset-rotate branch is reachable
  // through a real cursor position now, not just a prototype debug flag.
  //
  // Palette: 'y' (the body) stays hardcoded to the reference sprite's #ffd801 rather than
  // routed through getEffectiveColors().beacon -- a1011ca's own note ("pixel-exactness was
  // the ask here... that tradeoff is deliberate, not an oversight") plus the promotion
  // contract's own license for a fixed identity palette (the pumpkin's orange, here the
  // bird's reference yellow). The absorption flash still takes the effective beacon color,
  // the same accessibility-accent role animateTrail's own flash plays.
  //
  // Lite Mode: only the absorption flash's glow (box-shadow) is dropped, same degrade
  // animateTrail uses. The bird and its flight are never dropped -- they are the effect.
  function animateFlappy(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;

    var NS = 'http://www.w3.org/2000/svg';
    var mcx = rect.left + rect.width / 2 + window.scrollX;

    var DUR = getBeaconDuration(900);
    var STEP = 16; // ms, fixed integration step
    var SAG_PX = 34; // target vertical sag of each parabolic arc
    var beaconScale = getBeaconScale();

    // Pixel-art sprite: a pixel-exact reproduction of the human's reference (17x12 grid).
    // '.' transparent, 'k' black outline, 'y' yellow body, 'g' darker gold belly band,
    // 'w' white (wing/eye), 'o' orange beak -- one orange only, the reference has no
    // separate darker lower-mandible tone.
    //
    // The wing is split into its own grid (below) so it can be mounted in a <g> and
    // flapped by whole cells. This base grid has the wing's own cells (its white fill and
    // its own black outline, NOT the body outline that happens to run alongside it) filled
    // with 'y' -- the body color that sits behind the wing -- so translating the wing
    // overlay never tears a transparent hole in the silhouette.
    var BIRD_ROWS = [
      '......kkkkkk.....',
      '....kkyyyykwk....',
      '...kyyyyykwwwk...',
      '.yyyyyyyykwwkwk..',
      'kyyyyyyyykwwkwk..',
      'kyyyyyyyyykwwwk..',
      'kyyyyykyyyykkkkk.',
      '.kyyykyyyykoooook',
      '..kkkggggkokkkkk.',
      '....kgggggkooook.',
      '.....kkggggkkkkk.',
      '.......kkkk......'
    ];
    // Wing overlay, painted on top of the base sprite. Local grid (6 cols x 4 rows)
    // anchored at WING_COL/WING_ROW; transparent cells let the base sprite's own
    // body/outline show through unchanged.
    var WING_ROWS = [
      'kkkk..',
      'wwwwk.',
      'wwwwwk',
      '.www..'
    ];
    var WING_COL = 1, WING_ROW = 3;
    var PALETTE = { k: '#000000', y: '#ffd801', g: '#e0a700', w: '#ffffff', o: '#fe6a00' };

    // Integer cell size only -- a non-integer scale is what makes pixel art look mushy.
    // The Beacon Size setting is applied afterward, as a uniform CSS transform on the
    // wrap below, rather than by scaling CELL itself, so the authoring grid always
    // rasterizes crisp regardless of beaconScale.
    var CELL = 4;
    var GRID_W = BIRD_ROWS[0].length, GRID_H = BIRD_ROWS.length;
    var SPRITE_W = GRID_W * CELL, SPRITE_H = GRID_H * CELL;

    // Landing point: the match's top edge, not its centre -- the bird perches above the
    // highlighted text rather than covering it. Document coordinates throughout (rect is
    // the live, current-scroll viewport rect handed in by animate()). offset-anchor:50%
    // 50% (below) tracks the path from birdEl's own CENTRE, but the sprite's visible
    // bottom edge is the wrapper's scaled half-height (SPRITE_H * beaconScale / 2), not
    // its unscaled one, since the Beacon Size transform is centred on that same point --
    // using the unscaled half-height here left the visible bottom edge drifting past the
    // match's top edge at every size other than 1.0 (M), reaching y=374/392 instead of
    // 362 on a 359-377 match at L/XL. Solving centre + SPRITE_H*beaconScale/2 = rect.top
    // + 3 for centre keeps the same 3px overlap at every Beacon Size.
    var endX = mcx, endY = rect.top + window.scrollY - (SPRITE_H * beaconScale) / 2 + 3;

    // Start point cascade -- animateTrail's own, verbatim (see its comment above): cursor
    // if known, else the find bar's centre, else viewport centre. Find-in-page is
    // keyboard-driven, so the cursor is frequently null and that fallback is load-bearing.
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

    var dx = endX - startX, dy = endY - startY;
    if (Math.abs(dx) < 120) {
      // Degenerate case: the cascade's start point is too close horizontally to the
      // match to read as a physics-driven flight (the arcs would bunch up right next to
      // the landing point). Launch from 200px to its left instead, independent of the
      // viewport -- this is a distance clamp, not a viewport-fit check, so it does NOT
      // guarantee the start point itself is on-screen when the match sits within 200px
      // of the page's own left edge (mcx - 200 can go negative). The flight still ends
      // visibly on the match, which is on-screen by construction (this only ever fires
      // on the currently active match), so what a user sees in that case is the bird
      // flying in from just off the left edge rather than a flight with no visible
      // portion at all.
      startX = mcx - 200;
      dx = endX - startX; dy = endY - startY;
    }
    var dist = Math.hypot(dx, dy);
    // Start is to the right of the match -- the mirrored-sprite branch (rule 9).
    var mirrored = dx < 0;

    // Flap count from distance, then solve GRAVITY and FLAP_IMPULSE from the target
    // per-arc sag. With FLAP_IMPULSE chosen as -0.5*GRAVITY*FLAP_PERIOD, each arc is a
    // symmetric parabola: it rises from its flap to a peak at the arc's own midpoint
    // (vy=0 there -- the apex) and falls back to the same starting height by the arc's
    // end. Landing exactly at an arc's end -- as a plain DUR/n period does -- therefore
    // always lands mid-fall: a steep, nose-down tangent under offset-rotate:auto, which
    // reads as the bird crashing into the match instead of perching on it.
    //
    // Fix: retime (not re-derive) the flap schedule so arrival lands on the apex of the
    // final arc instead, where the tangent is level by construction -- solving
    // DUR = (n - 0.5) * FLAP_PERIOD for the period (instead of DUR = n * FLAP_PERIOD).
    var n = Math.max(2, Math.min(6, Math.round(dist / 160)));
    var FLAP_PERIOD = DUR / (n - 0.5);
    var GRAVITY = (8 * SAG_PX) / (FLAP_PERIOD * FLAP_PERIOD); // px/ms^2
    var FLAP_IMPULSE = -0.5 * GRAVITY * FLAP_PERIOD; // px/ms, upward (negative)

    // Integrate once, at fire time, with a fixed step. vy is reset outright (not added
    // to) at each flap -- that reset is what makes this a sawtooth of parabolic arcs
    // rather than a sine wave.
    var steps = Math.max(2, Math.round(DUR / STEP));
    var vy = FLAP_IMPULSE;
    var y = 0;
    var sinceFlap = 0;
    var rawY = [0];
    for (var i = 1; i <= steps; i++) {
      vy += GRAVITY * STEP;
      y += vy * STEP;
      sinceFlap += STEP;
      if (sinceFlap >= FLAP_PERIOD) {
        vy = FLAP_IMPULSE;
        sinceFlap -= FLAP_PERIOD;
      }
      rawY.push(y);
    }

    // Every full arc returns to its own starting height by construction (see above), so
    // rawY oscillates but nets to ~0 over any whole number of periods -- almost all of
    // the real start-to-end height change has to come from this correction term. x
    // advances linearly from start to end the whole way; y gets the same correction,
    // weighted by an ease-out curve (2*frac - frac^2) rather than a flat frac: a flat
    // frac term has a constant per-step slope everywhere, including at frac=1, so it
    // would still be adding a steep, uncancelled downward slope right at the landing
    // point even after the apex-retiming above. The ease-out curve has zero derivative at
    // frac=1, so by the landing point it contributes position (the bird still ends up
    // exactly on target) without contributing velocity -- leaving the apex's near-zero
    // local slope as the only thing offset-rotate:auto sees, which is what actually
    // delivers the level landing.
    var residual = (endY - startY) - rawY[steps];
    var pathPts = [];
    for (var j = 0; j <= steps; j++) {
      var frac = j / steps;
      var ease = 2 * frac - frac * frac; // w(0)=0, w(1)=1, w'(1)=0
      var px = startX + dx * frac;
      var py = startY + rawY[j] + residual * ease;
      pathPts.push([px, py]);
    }
    pathPts[steps] = [endX, endY]; // exact landing, immune to float rounding

    var pathStr = 'M ' + pathPts.map(function (p) { return p[0] + ' ' + p[1]; }).join(' L ');

    var birdEl = document.createElement('div');
    birdEl.className = 'oc-beacon oc-beacon-transient oc-flappy-bird';
    birdEl.style.cssText = [
      'position:absolute',
      'left:0px', 'top:0px',
      'width:' + SPRITE_W + 'px', 'height:' + SPRITE_H + 'px',
      'pointer-events:none',
      'z-index:2147483642',
      "offset-path:path('" + pathStr + "')",
      'offset-anchor:50% 50%',
      'offset-rotate:auto' + (mirrored ? ' 180deg' : ''),
      'opacity:1'
    ].join(';');
    document.documentElement.appendChild(birdEl);

    // Mirroring and the Beacon Size scale are both applied here, as a plain CSS
    // transform on this wrapper, rather than by touching the authoring grid (CELL) or
    // the motion path above -- this wrapper fills 100% of birdEl's own box and never
    // sets its own transform-origin, so the default 50% 50% keeps the scale centred on
    // the same point offset-anchor:50% 50% (set in birdEl's cssText above) tracks along the
    // path, regardless of beaconScale. endY above already accounts for this scaling so
    // the sprite's visible bottom edge lands at the same offset from the match at every
    // Beacon Size.
    var transformParts = [];
    if (mirrored) transformParts.push('scaleX(-1)');
    if (beaconScale !== 1) transformParts.push('scale(' + beaconScale + ')');
    var wrap2 = document.createElement('div');
    wrap2.style.cssText = 'width:100%;height:100%;' + (transformParts.length ? 'transform:' + transformParts.join(' ') + ';' : '');
    birdEl.appendChild(wrap2);

    // Pixel-art sprite: merge each grid row's horizontal runs of the same character into
    // one <rect> (not one rect per cell), so the art stays small and editable.
    // crispEdges keeps cell edges hard under rotation and scaling.
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', String(SPRITE_W));
    svg.setAttribute('height', String(SPRITE_H));
    svg.setAttribute('viewBox', '0 0 ' + SPRITE_W + ' ' + SPRITE_H);
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.style.cssText = 'display:block;overflow:visible;';

    function paintRows(rows, offCol, offRow) {
      // A short row paints nothing past its end rather than erroring, so a miscounted
      // row is invisible in the source and shows up only as a hole in the outline --
      // exactly what shipped once in the playground (row 9 was 15 chars, leaving the
      // beak's bottom-right corner open, fixed in 67adeb2). Fail loudly instead.
      for (var ri = 0; ri < rows.length; ri++) {
        if (rows[ri].length !== rows[0].length) {
          throw new Error('paintRows: row ' + ri + ' is ' + rows[ri].length + ' cells, expected ' + rows[0].length);
        }
      }
      var g = document.createElementNS(NS, 'g');
      for (var ry = 0; ry < rows.length; ry++) {
        var row = rows[ry], cx = 0;
        while (cx < row.length) {
          var ch = row[cx];
          if (ch === '.') { cx++; continue; }
          var runStart = cx;
          while (cx < row.length && row[cx] === ch) cx++;
          var cellRect = document.createElementNS(NS, 'rect');
          cellRect.setAttribute('x', String((offCol + runStart) * CELL));
          cellRect.setAttribute('y', String((offRow + ry) * CELL));
          cellRect.setAttribute('width', String((cx - runStart) * CELL));
          cellRect.setAttribute('height', String(CELL));
          cellRect.setAttribute('fill', PALETTE[ch]);
          g.appendChild(cellRect);
        }
      }
      return g;
    }

    svg.appendChild(paintRows(BIRD_ROWS, 0, 0));

    // The wing is its own <g>, painted on top of the body, so it can be flapped by whole
    // cells independently of the body's silhouette.
    var wingG = paintRows(WING_ROWS, WING_COL, WING_ROW);
    svg.appendChild(wingG);

    wrap2.appendChild(svg);

    var travelAnim = birdEl.animate([
      { offsetDistance: '0%' },
      { offsetDistance: '100%' }
    ], { duration: DUR, easing: 'linear', fill: 'forwards' });

    // Wing beat synced to the arcs by construction: same period, and the same (n - 0.5)
    // count the vertical path runs -- n full flaps would overshoot DUR by half a period
    // since the trajectory retiming above, and the wing would keep beating after the
    // body has already landed. iterations accepts a fractional count, so it just stops
    // mid upstroke at the same instant the body reaches the apex. Pixel-art idiom, not a
    // squash -- the wing group jumps by whole cells (up, home, down, home) with steps()
    // easing so it snaps between positions instead of gliding.
    var wingAnim = wingG.animate([
      { transform: 'translateY(-' + CELL + 'px)' },
      { transform: 'translateY(0px)' },
      { transform: 'translateY(' + CELL + 'px)' },
      { transform: 'translateY(0px)' }
    ], { duration: FLAP_PERIOD, iterations: n - 0.5, easing: 'steps(3, end)' });

    var FADE_DUR = getBeaconDuration(220);
    var fadeAnim = birdEl.animate([
      { opacity: 1 },
      { opacity: 0 }
    ], { duration: FADE_DUR, delay: DUR, fill: 'forwards' });

    // Rule 4: every WAAPI animation touching this beacon -- including the wing's, hung
    // on a child <g> -- is listed here, so cancelBeacons()/destroyBeacon() reaches all
    // three. Rule 5: removal is gated on the whole set settling (Promise.allSettled),
    // not on any single one of them -- the travel animation finishes well before the
    // fade is even supposed to start, so hooking removal to it alone would delete the
    // bird mid-fade. destroyBeacon() already removes birdEl synchronously on cancel;
    // this promise resolving afterward and calling remove() again is a harmless no-op.
    birdEl.__waapiAnims = [travelAnim, wingAnim, fadeAnim];
    function removeBird() { birdEl.remove(); }
    Promise.allSettled([travelAnim.finished, wingAnim.finished, fadeAnim.finished]).then(removeBird);

    // Absorption flash on arrival -- same shape as animateTrail's flash: rect inflated
    // 6px, opacity 0->1->0, scale 1->1.15->1, delayed by DUR so it can never fire before
    // the bird lands. Unlike the bird's own fixed identity palette, the flash takes the
    // effective beacon color -- the same accessibility-accent role animateTrail's own
    // flash plays.
    var flashColor = getEffectiveColors().beacon || '#fbbf24';
    var flashPad = 6;
    var flash = document.createElement('div');
    flash.className = 'oc-beacon oc-beacon-transient oc-flappy-flash';
    var flashCss = [
      'position:absolute',
      'left:' + (rect.left + window.scrollX - flashPad) + 'px',
      'top:' + (rect.top + window.scrollY - flashPad) + 'px',
      'width:' + (rect.width + flashPad * 2) + 'px',
      'height:' + (rect.height + flashPad * 2) + 'px',
      'border-radius:4px',
      'background:' + flashColor,
      'pointer-events:none',
      'z-index:2147483642',
      'opacity:0'
    ];
    if (settings.performanceMode) {
      // Lite Mode: the flash itself stays (it's the payoff), but the blurred glow -- the
      // expensive part -- is dropped for a flat fill, the same degrade animateTrail uses.
      // The bird and its flight are never dropped; they are the effect.
    } else {
      flashCss.push('box-shadow:0 0 ' + (18 * beaconScale) + 'px ' + flashColor + ', 0 0 ' + (6 * beaconScale) + 'px ' + flashColor);
    }
    flash.style.cssText = flashCss.join(';');
    document.documentElement.appendChild(flash);

    var flashDuration = getBeaconDuration(450);
    var flashAnim = flash.animate([
      { opacity: 0, transform: 'scale(1)' },
      { opacity: 1, transform: 'scale(1.15)', offset: 0.35 },
      { opacity: 0, transform: 'scale(1)' }
    ], { duration: flashDuration, delay: DUR, easing: 'ease-out', fill: 'forwards' });
    flash.__waapiAnims = [flashAnim];

    flashAnim.finished.then(function () {
      flash.remove();
    }).catch(function () {
      flash.remove();
    });
  }

  // oculist-e2m.6: promotes fxCheshire (artifacts/prototypes/effects-playground.html,
  // the geometric-dissolve redraw from oculist-e2m.8's character-sheet rebuild and
  // oculist-e2m.9's own disappearance refinement) into the shipped beacon contract, the
  // third entry in the Halloween pack. A hand-drawn cat fades in above the match (or
  // below it when there is no room), its six head/body regions separate and dissolve
  // while its grin settles toward the match, pops, holds, then fades -- the grin
  // outlasts the body, it does not persist. No teeth glow: cut in the playground and
  // stays cut here (oculist-e2m.9's own description names "no teeth glow" as an epic
  // decision to preserve; the epic's own DESIGN CONSTANTS record why -- an animated
  // drop-shadow washed the mouth fill, and a white halo layer cost over a third of the
  // mouth-fill pixels, both at exactly the 120ms the pop is meant to capture attention).
  function animateCheshire(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;

    var NS = 'http://www.w3.org/2000/svg';

    // Fixed identity palette, the same license the promotion contract names for the
    // pumpkin's orange and the skeleton's ivory -- no neighbouring shipped character
    // effect exists yet to set an accessibility-accent precedent for it, and (unlike
    // animateTrail/animateFlappy's own absorption flash) this effect has no separate
    // flash element to carry getEffectiveColors().beacon as an accent.
    var OUTLINE = '#17112B';
    var FUR = '#6D28D9';
    var FUR_SHADOW = '#3B176D';
    var FUR_HIGHLIGHT = '#C084FC';
    var ACCENT = '#EC4899';
    var EYE = '#FDE047';
    var NOSE = '#F472B6';
    var TEETH = '#FFF8DC';
    var HAND_DRAWN = 'stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke;';

    var VB_W = 130, VB_H = 100;
    var ASPECT = VB_W / VB_H;
    var GAP = 8; // px between the cat's bounding box and the match edge

    var beaconScale = getBeaconScale();
    var durFactor = getBeaconDuration(1);

    // Lite Mode (settings.performanceMode): this effect has no glow, box-shadow, or
    // multi-state flicker to begin with -- the fragment dissolve and the grin's
    // settle/pop/fade are all plain opacity and transform, already the cheap path, the
    // same reasoning animateBoneAssembly's own comment gives for its own Lite Mode
    // no-op. Full mode and Lite Mode render and time identically; settings.performanceMode
    // is deliberately never read below.

    // On-screen size: the prototype's own match-relative clamp, then the Beacon Size
    // knob every other beacon effect's own size responds to.
    var catHeight = Math.max(48, Math.min(110, 3.2 * rect.height)) * beaconScale;
    var catWidth = catHeight * ASPECT;

    // Placement fit is a viewport question even though the figure mounts in document
    // space below (rule 9 of the promotion contract, oculist-nq1x): rect here is the
    // live pre-scroll viewport rect animate() hands in, so this comparison -- and every
    // other screenLeft/screenTop value below, until the docLeft/docTop conversion --
    // stays in viewport space, the same split animateBoneAssembly's own side-selection
    // above uses.
    var mcxViewport = rect.left + rect.width / 2;
    var above = rect.top >= catHeight + GAP;
    var screenLeft = mcxViewport - catWidth / 2;
    var screenTop = above ? (rect.top - GAP - catHeight) : (rect.bottom + GAP);

    // #grin's settle drift is toward the match, whatever side it lands on: above the
    // match, the match sits below the cat, so +y (down) is toward it; below the match,
    // the match sits above the cat, so -y (up) is toward it. Re-signing the drift keeps
    // the cat itself upright and identically drawn either way (the prototype's own
    // reasoning, carried over verbatim) -- left unscaled by beaconScale on purpose: this
    // value feeds grinG's own transform inside the svg's viewBox (0 0 VB_W VB_H), i.e.
    // SVG user units, which the viewBox-to-catWidth/catHeight mapping already scales by
    // beaconScale on render. Multiplying here too double-scales it -- at XL that pushed
    // the grin's own rendered bbox past the match's top edge on the above branch.
    var drift = above ? 6 : -6;

    var docLeft = screenLeft + window.scrollX;
    var docTop = screenTop + window.scrollY;

    // The <svg> itself is the single oc-beacon-transient element cancelBeacons()
    // selects -- the #cat and #grin animations below both live on child <g> nodes, so
    // every Animation they produce is hung off this parent svg instead (rule 4 of the
    // promotion contract; animateTrail's lineSvg is the same idiom, an <svg> that is
    // itself the .oc-beacon element rather than a wrapping <div>).
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', String(catWidth));
    svg.setAttribute('height', String(catHeight));
    svg.setAttribute('viewBox', '0 0 ' + VB_W + ' ' + VB_H);
    svg.setAttribute('class', 'oc-beacon oc-beacon-transient');
    svg.style.cssText = [
      'position:absolute',
      'left:' + docLeft + 'px', 'top:' + docTop + 'px',
      'width:' + catWidth + 'px', 'height:' + catHeight + 'px',
      'overflow:visible',
      'pointer-events:none',
      'z-index:2147483642',
      'transform-origin:50% 50%',
      'opacity:0'
    ].join(';');
    document.documentElement.appendChild(svg);

    function addShape(tag, attrs, parent) {
      var el = document.createElementNS(NS, tag);
      for (var k in attrs) el.setAttribute(k, attrs[k]);
      parent.appendChild(el);
      return el;
    }

    var catG = document.createElementNS(NS, 'g');
    catG.setAttribute('data-cheshire-part', 'cat');
    svg.appendChild(catG);

    // Six broad, slightly overlapping regions reconstruct the approved head silhouette
    // (oculist-e2m.8's character-sheet redraw). They read as one cat while assembled,
    // then become the fixed geometric pieces the dissolve below separates.
    var fragments = [
      addShape('path', { d: 'M 17 39 Q 10 24 17 2 L 47 24 L 43 45 Z', fill: FUR_SHADOW, 'data-cheshire-fragment': 'left-ear' }, catG),
      addShape('path', { d: 'M 87 45 L 83 24 L 113 2 Q 120 24 113 39 Z', fill: FUR_SHADOW, 'data-cheshire-fragment': 'right-ear' }, catG),
      addShape('path', { d: 'M 27 35 Q 42 19 65 19 Q 88 19 103 35 L 94 58 L 65 51 L 36 58 Z', fill: FUR, 'data-cheshire-fragment': 'brow' }, catG),
      addShape('path', { d: 'M 16 38 L 39 31 L 66 50 L 59 92 Q 34 96 16 79 L 4 76 L 13 69 L 1 64 L 15 59 L 3 53 L 18 50 Z', fill: FUR_SHADOW, 'data-cheshire-fragment': 'left-cheek' }, catG),
      addShape('path', { d: 'M 114 38 L 91 31 L 64 50 L 71 92 Q 96 96 114 79 L 126 76 L 117 69 L 129 64 L 115 59 L 127 53 L 112 50 Z', fill: FUR_HIGHLIGHT, 'data-cheshire-fragment': 'right-cheek' }, catG),
      addShape('path', { d: 'M 35 51 L 65 46 L 95 51 L 106 75 Q 91 99 65 99 Q 39 99 24 75 Z', fill: FUR, 'data-cheshire-fragment': 'muzzle' }, catG)
    ];

    var detailsG = addShape('g', {}, catG);

    // One strong perimeter keeps the assembled regions reading as a single compact
    // silhouette at 48px; broad flat highlights preserve the sheet's upper-left light
    // without gradients or filters.
    addShape('path', {
      d: 'M 17 39 Q 10 24 17 2 L 48 25 Q 56 18 65 21 Q 74 18 82 25 L 113 2 Q 120 24 113 39 L 112 50 L 127 53 L 115 59 L 129 64 L 117 69 L 126 76 L 112 79 Q 96 99 65 99 Q 34 99 18 79 L 4 76 L 13 69 L 1 64 L 15 59 L 3 53 L 18 50 Z',
      fill: 'none', stroke: OUTLINE, 'stroke-width': '3.5', style: HAND_DRAWN
    }, detailsG);
    addShape('path', { d: 'M 18 5 L 43 27 L 25 20 L 22 35 Q 17 23 18 5 Z', fill: ACCENT }, detailsG);
    addShape('path', { d: 'M 112 5 L 87 27 L 105 20 L 108 35 Q 113 23 112 5 Z', fill: ACCENT }, detailsG);
    addShape('path', { d: 'M 20 40 Q 29 27 43 25 L 35 36 Q 25 39 18 51 Z', fill: FUR_HIGHLIGHT }, detailsG);
    addShape('path', { d: 'M 93 34 Q 103 38 112 51 L 100 46 Z', fill: FUR_SHADOW }, detailsG);

    // Three forehead marks copied from the canonical assembled head.
    addShape('path', { d: 'M 39 25 L 51 31 L 55 48 L 45 38 Z', fill: ACCENT, stroke: OUTLINE, 'stroke-width': '1.4', style: HAND_DRAWN }, detailsG);
    addShape('path', { d: 'M 58 20 L 66 31 L 65 50 L 61 35 Z', fill: ACCENT, stroke: OUTLINE, 'stroke-width': '1.4', style: HAND_DRAWN }, detailsG);
    addShape('path', { d: 'M 76 24 L 71 35 L 70 50 L 81 31 L 91 25 L 83 38 Z', fill: ACCENT, stroke: OUTLINE, 'stroke-width': '1.4', style: HAND_DRAWN }, detailsG);

    // Wide yellow almond eyes with vertical pupils survive at 48px.
    addShape('path', { d: 'M 25 50 Q 38 35 55 48 Q 52 68 35 68 Q 27 63 25 50 Z', fill: EYE, stroke: OUTLINE, 'stroke-width': '3', style: HAND_DRAWN }, detailsG);
    addShape('path', { d: 'M 105 50 Q 92 35 75 48 Q 78 68 95 68 Q 103 63 105 50 Z', fill: EYE, stroke: OUTLINE, 'stroke-width': '3', style: HAND_DRAWN }, detailsG);
    addShape('path', { d: 'M 42 43 Q 47 52 42 65 Q 37 54 42 43 Z', fill: OUTLINE }, detailsG);
    addShape('path', { d: 'M 88 43 Q 93 52 88 65 Q 83 54 88 43 Z', fill: OUTLINE }, detailsG);
    addShape('circle', { cx: '37', cy: '47', r: '2', fill: '#FFFFFF' }, detailsG);
    addShape('circle', { cx: '83', cy: '47', r: '2', fill: '#FFFFFF' }, detailsG);

    addShape('path', { d: 'M 58 64 L 65 59 L 72 64 L 65 70 Z', fill: NOSE, stroke: OUTLINE, 'stroke-width': '2', style: HAND_DRAWN }, detailsG);
    addShape('path', { d: 'M 24 66 L 2 61 M 23 71 L 0 72 M 25 76 L 5 83', fill: 'none', stroke: OUTLINE, 'stroke-width': '2', style: HAND_DRAWN }, detailsG);
    addShape('path', { d: 'M 106 66 L 128 61 M 107 71 L 130 72 M 105 76 L 125 83', fill: 'none', stroke: OUTLINE, 'stroke-width': '2', style: HAND_DRAWN }, detailsG);

    var grinG = document.createElementNS(NS, 'g');
    grinG.setAttribute('data-cheshire-part', 'grin');
    grinG.style.cssText = 'transform-box:fill-box;transform-origin:50% 50%;';
    svg.appendChild(grinG);

    // A single warm-ivory crescent plus five sturdy dividers makes six broad teeth. No
    // glow -- see this function's own header comment.
    addShape('path', {
      d: 'M 20 66 Q 65 80 110 66 Q 103 92 65 95 Q 27 92 20 66 Z',
      fill: TEETH, stroke: OUTLINE, 'stroke-width': '3.5', style: HAND_DRAWN
    }, grinG);
    addShape('path', {
      d: 'M 35 70 L 38 88 M 49 73 L 51 92 M 65 75 L 65 94 M 81 73 L 79 92 M 95 70 L 92 88',
      fill: 'none', stroke: OUTLINE, 'stroke-width': '2', style: HAND_DRAWN
    }, grinG);

    // Every Animation this beacon creates is collected here and hung off svg itself
    // (the element cancelBeacons() actually selects, see the header comment above) --
    // matching animateBoneAssembly's own track()/Promise.allSettled idiom for a figure
    // built from many per-piece animations that settle at different times, rather than
    // animateTrail's per-element .finished.then(remove), which would tear this figure
    // down the instant its first (180ms) animation finished.
    var anims = [];
    function track(anim) { anims.push(anim); return anim; }

    // 0-180ms: whole svg fades/scales in.
    track(svg.animate([
      { opacity: 0, transform: 'scale(0.9)' },
      { opacity: 1, transform: 'scale(1)' }
    ], { duration: 180 * durFactor, easing: 'ease-out', fill: 'forwards' }));

    // 180-780ms: facial details recede, then six deterministic head regions separate
    // along hand-authored vectors. No random/per-frame geometry (rule 11 of the
    // promotion contract).
    track(detailsG.animate([
      { opacity: 1 },
      { opacity: 0 }
    ], { duration: 360 * durFactor, delay: 180 * durFactor, easing: 'ease-in', fill: 'forwards' }));

    var fragmentMotion = [
      [-6, -7, -7], [6, -7, 7], [0, -8, 0],
      [-8, 3, -5], [8, 3, 5], [0, 8, 0]
    ];
    fragments.forEach(function (fragment, index) {
      var motion = fragmentMotion[index];
      fragment.style.cssText = 'transform-box:fill-box;transform-origin:50% 50%;';
      track(fragment.animate([
        { opacity: 1, transform: 'translate(0,0) rotate(0deg)', offset: 0 },
        { opacity: 1, transform: 'translate(0,0) rotate(0deg)', offset: 0.18 + index * 0.035 },
        { opacity: 0, transform: 'translate(' + motion[0] + 'px,' + motion[1] + 'px) rotate(' + motion[2] + 'deg)', offset: 1 }
      ], { duration: 600 * durFactor, delay: 180 * durFactor, easing: 'ease-in', fill: 'forwards' }));
    });

    // 180-900ms on #grin, as one animation so the 780ms pop composes with (rather than
    // overwrites) the translate's held end value: 180-780 settles toward the match,
    // 780-900 is the scale pop.
    track(grinG.animate([
      { transform: 'translate(0,0px) scale(1)', offset: 0, easing: 'ease-out' },
      { transform: 'translate(0,' + drift + 'px) scale(1)', offset: 0.833, easing: 'ease-out' },
      { transform: 'translate(0,' + drift + 'px) scale(1.12)', offset: 0.9167, easing: 'ease-in' },
      { transform: 'translate(0,' + drift + 'px) scale(1)', offset: 1 }
    ], { duration: 720 * durFactor, delay: 180 * durFactor, fill: 'forwards' }));

    // 900-1500ms: #grin holds, then fades -- the grin outlasts the body, it does not
    // persist (a permanent overlay would break the .oc-beacon-transient scroll-fade
    // contract every other beacon effect honors).
    track(grinG.animate([
      { opacity: 1, offset: 0 },
      { opacity: 1, offset: 0.2 },
      { opacity: 0, offset: 1 }
    ], { duration: 600 * durFactor, delay: 900 * durFactor, easing: 'ease-in', fill: 'forwards' }));

    svg.__waapiAnims = anims;

    // Natural completion removes the svg only once EVERY animation has settled, the
    // same Promise.allSettled reasoning animateBoneAssembly's own removeFig() uses.
    // destroyBeacon() (above) still removes svg synchronously on cancel, cancelling
    // every entry in __waapiAnims regardless of this promise.
    function removeSvg() { svg.remove(); }
    Promise.allSettled(anims.map(function (a) { return a.finished; })).then(removeSvg);
  }

  // oculist-4rso: promotes fxJackOLantern (artifacts/prototypes/effects-playground.html,
  // the accepted geometry and placement contract from oculist-xl8f/oculist-9r5k, with the
  // conservative 122-unit bottom extent and the 6px/8px clearance contracts its own close
  // reason records) into the shipped beacon contract, the fourth entry in the Halloween
  // pack. A hand-drawn jack-o'-lantern fades in centred on the match's own mouth cavity
  // when the match is small enough to frame readably (mouth mode), or above the match with
  // an 8px gap when it is not (below-pumpkin mode); if neither fits the physical viewport,
  // the effect is suppressed rather than covering text. Its face-light flickers through
  // three deterministic states (dim, warm, bright) while the shell itself never moves.
  //
  // MOUTH MODE'S DELIBERATE GLYPH TINT: the translucent #E86F1C mouth panel below sits at
  // z-index 2147483642, above the match's own layer, and its 0.18 fill-opacity visibly
  // warms the matched glyphs underneath it for the whole hold -- a human decision recorded
  // on oculist-xl8f's own close comment (2026-09-21) and operationalized by
  // oculist-nq1x.15's close reason (a per-pixel tint ceiling of 64, principled bound
  // 0.18*255=46). This is the ONE place this effect's own "zero glyph pixel change" rule
  // does not hold -- above and suppressed modes keep it exactly, mouth mode does not.
  function animateJackOLantern(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;

    var NS = 'http://www.w3.org/2000/svg';

    // Fixed identity palette, the same license the promotion contract names for the
    // pumpkin's orange -- no neighbouring shipped character effect (Skeleton Trot, Flappy,
    // Cheshire Cat) has set an accessibility-accent precedent that applies here: unlike
    // animateTrail's/animateFlappy's own absorption flash, this effect has no separate
    // flash element to carry getEffectiveColors().beacon as an accent -- same reasoning
    // animateCheshire's own header comment gives for itself.
    var SHELL_FILL = '#E86F1C';
    var SHELL_OUTLINE = '#2A160C';
    var LOBE_DARK = '#A83D14';
    var LOBE_LIGHT = '#FFA23A';
    var LOBE_DARKEST = '#6E2810';
    var STEM_FILL = '#465A28', STEM_OUTLINE = '#18200F';
    var STEM_HIGHLIGHT = '#758344', STEM_SHADOW = '#273619';
    var FACE_DARK = '#2B1108';
    var VECTOR_STROKE = 'stroke-linejoin:round;vector-effect:non-scaling-stroke;';

    var VB_W = 180, VB_H = 126;
    // CAV: the mouth cavity's own box, in viewBox units, the match is centred inside for
    // mouth mode. PAINT: the conservative painted-bounds rectangle (oculist-xl8f's own
    // accepted 122-unit bottom extent, not the raw 121.333, modeled conservatively) used
    // only for the onScreen() fit check below -- never for placement math itself.
    var CAV = { x: 32, y: 73, w: 116, h: 28 };
    var PAINT = { left: 8, top: 2, right: 172, bottom: 122 };
    var CLEAR = 6, ABOVE_GAP = 8, EDGE = 4, STROKE_MARGIN = 2;
    var ENTER_SCALE = 0.96;
    var MIN_SCALE = 72 / VB_H, MAX_FRAME_SCALE = 196 / VB_H;

    var beaconScale = getBeaconScale();
    var durFactor = getBeaconDuration(1);

    // Viewport-fit decisions are made from the PRE-SCROLL viewport rect animate() hands in
    // (rule 2 of the promotion contract, oculist-nq1x) -- cx/cy, onScreen(), and vw/vh all
    // stay in viewport space below, until the docLeft/docTop conversion right before mount.
    var vw = window.innerWidth, vh = window.innerHeight;
    var cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;

    function bounds(left, top, scale) {
      return {
        left: left + PAINT.left * scale - STROKE_MARGIN,
        top: top + PAINT.top * scale - STROKE_MARGIN,
        right: left + PAINT.right * scale + STROKE_MARGIN,
        bottom: top + PAINT.bottom * scale + STROKE_MARGIN
      };
    }
    function onScreen(b) {
      return b.left >= EDGE && b.top >= EDGE && b.right <= vw - EDGE && b.bottom <= vh - EDGE;
    }

    // MOUTH-FRAMING SCALE lives in a different space than below-pumpkin's: it is dictated
    // ENTIRELY by the real match rect (CSS px, from the live DOM) plus the fixed CLEAR
    // margin, because containing the actual glyphs is a hard geometric requirement, not a
    // stylistic one. getBeaconScale() therefore does NOT multiply frameScale -- doing so
    // would either violate the clearance guarantee at Beacon Size S (0.7x shrinks the
    // cavity below rect.width+2*CLEAR, letting effect paint reach the protected mouth
    // rectangle) or waste the "match centred exactly in the cavity" contract at L/XL
    // (growing the cavity past what the match itself needs). Scaled against the smallest
    // entrance cavity (dividing by ENTER_SCALE), not the settled one, so the initial 0.96
    // entrance keyframe retains the full CLEAR margin at every instant, not just once
    // settled.
    var frameScale = Math.max(
      MIN_SCALE,
      (rect.width + CLEAR * 2) / (CAV.w * ENTER_SCALE),
      (rect.height + CLEAR * 2) / (CAV.h * ENTER_SCALE)
    );
    var frameLeft = cx - (CAV.x + CAV.w / 2) * frameScale;
    var frameTop = cy - (CAV.y + CAV.h / 2) * frameScale;
    var frameFits = frameScale <= MAX_FRAME_SCALE && onScreen(bounds(frameLeft, frameTop, frameScale));

    var scale, left, top, mode;
    if (frameFits) {
      scale = frameScale;
      left = frameLeft;
      top = frameTop;
      mode = 'mouth';
    } else {
      // BELOW-PUMPKIN SCALE has no glyph-containment constraint -- the pumpkin merely sits
      // near the match, the same freedom animateCheshire's own cat sizing has -- so
      // getBeaconScale() multiplies the match-relative clamp directly, same pattern as
      // Cheshire Cat's own catHeight. The multiply happens here, before left/top/bounds are
      // computed from it, so the onScreen() fit check below sees the real final rendered
      // size rather than an unscaled one a later CSS transform would have grown past it.
      scale = Math.max(MIN_SCALE, Math.min(1, (rect.height * 2.8) / VB_H)) * beaconScale;
      left = cx - VB_W * scale / 2;
      top = rect.top - ABOVE_GAP - PAINT.bottom * scale - STROKE_MARGIN;
      if (!onScreen(bounds(left, top, scale))) return; // suppress: neither mode fits
      mode = 'above';
    }

    var docLeft = left + window.scrollX, docTop = top + window.scrollY;

    var pumpkinEl = document.createElement('div');
    pumpkinEl.className = 'oc-beacon oc-beacon-transient oc-jackolantern';
    pumpkinEl.setAttribute('data-jol-mode', mode);
    pumpkinEl.style.cssText = [
      'position:absolute',
      'left:' + docLeft + 'px', 'top:' + docTop + 'px',
      'width:' + (VB_W * scale) + 'px', 'height:' + (VB_H * scale) + 'px',
      'pointer-events:none',
      'z-index:2147483642',
      // The shrink point is the cavity's own centre, in this element's own local px box --
      // (CAV.y + CAV.h/2) is a viewBox-unit coordinate, and scale is the single factor
      // this whole function derives everything from, so multiplying it in ONCE here
      // converts it to a local px offset with no double-scaling (the bug class Cheshire Cat's
      // own drift value hit: an SVG-user-unit value re-multiplied by beaconScale when the
      // viewBox mapping had already applied it once).
      'transform-origin:50% ' + ((CAV.y + CAV.h / 2) * scale) + 'px',
      'opacity:0'
    ].join(';');
    document.documentElement.appendChild(pumpkinEl);

    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', String(VB_W * scale));
    svg.setAttribute('height', String(VB_H * scale));
    svg.setAttribute('viewBox', '0 0 ' + VB_W + ' ' + VB_H);
    svg.style.cssText = 'display:block;overflow:visible;';
    pumpkinEl.appendChild(svg);

    function addShape(tag, attrs, parent) {
      var el = document.createElementNS(NS, tag);
      for (var k in attrs) el.setAttribute(k, attrs[k]);
      parent.appendChild(el);
      return el;
    }

    var shellG = addShape('g', { 'data-jol-part': 'shell' }, svg);
    // The base hole leaves the match untouched; the translucent panel below fills it
    // visually without cloning or mutating the page text (see this function's own header
    // comment for the deliberate mouth-mode tint this panel produces).
    addShape('path', {
      d: 'M 90 16 C 125 10 156 22 168 48 C 176 67 171 94 156 108 C 139 122 112 121 90 116 C 68 121 41 122 24 108 C 9 94 8 67 12 49 C 20 22 53 10 90 16 Z M 26 67 H 154 V 107 H 26 Z',
      fill: SHELL_FILL, 'fill-rule': 'evenodd'
    }, shellG);
    addShape('rect', { x: '26', y: '67', width: '128', height: '40', fill: SHELL_FILL, 'fill-opacity': '0.18', 'data-jol-part': 'mouth-panel' }, shellG);
    addShape('path', { d: 'M 90 16 C 125 10 156 22 168 48 C 176 67 171 94 156 108 C 139 122 112 121 90 116 C 68 121 41 122 24 108 C 9 94 8 67 12 49 C 20 22 53 10 90 16 Z', fill: 'none', stroke: SHELL_OUTLINE, 'stroke-width': '3', style: VECTOR_STROKE }, shellG);

    // Five broad lobes, interrupted around the transparent mouth instead of drawing seams
    // through it.
    addShape('path', { d: 'M 31 34 C 18 46 17 58 25 66 L 31 65 C 26 53 27 43 31 34 Z M 24 67 C 16 82 17 99 25 107 L 18 103 C 11 88 12 72 24 67 Z M 31 110 C 44 119 57 121 68 118 L 63 110 Z', fill: LOBE_DARK }, shellG);
    addShape('path', { d: 'M 62 22 C 45 37 43 55 47 65 L 65 65 C 58 48 61 31 74 19 Z M 47 109 C 54 117 68 120 80 117 L 76 109 Z', fill: LOBE_LIGHT }, shellG);
    addShape('path', { d: 'M 111 18 C 126 34 130 52 125 65 L 145 65 C 143 43 132 26 111 18 Z M 104 109 L 100 117 C 115 121 132 116 139 109 Z', fill: LOBE_DARK }, shellG);
    addShape('path', { d: 'M 151 31 C 163 47 166 59 155 66 L 149 65 C 154 52 154 41 151 31 Z M 156 67 C 168 80 166 99 155 107 L 162 103 C 170 88 169 73 156 67 Z M 145 109 L 139 117 C 151 117 160 112 165 104 Z', fill: LOBE_DARKEST }, shellG);
    addShape('path', { d: 'M 78 19 C 70 31 68 49 73 65 H 107 C 112 47 108 28 99 18 Z M 75 109 C 80 118 99 121 106 109 Z', fill: LOBE_LIGHT }, shellG);
    addShape('ellipse', { cx: '48', cy: '40', rx: '13', ry: '7', fill: LOBE_LIGHT, transform: 'rotate(-35 48 40)' }, shellG);
    addShape('ellipse', { cx: '83', cy: '31', rx: '10', ry: '5', fill: LOBE_LIGHT, transform: 'rotate(-45 83 31)' }, shellG);

    // Right-leaning stem and left leaf, both broad enough for the 72px readability floor at
    // Beacon Size M -- MIN_SCALE (72/VB_H) is applied before the below-pumpkin `* beaconScale`
    // multiply above, so the floor itself scales with Beacon Size (e.g. ~50px at S), the same
    // idiom as animateCheshire's own `Math.max(48, ...) * beaconScale`.
    addShape('path', { d: 'M 87 22 C 88 10 96 3 108 2 L 119 10 C 106 17 103 25 102 31 Z', fill: STEM_FILL, stroke: STEM_OUTLINE, 'stroke-width': '2.5', style: VECTOR_STROKE }, shellG);
    addShape('path', { d: 'M 95 21 C 98 12 104 7 111 5 L 115 9 C 105 15 102 21 101 27 Z', fill: STEM_HIGHLIGHT }, shellG);
    addShape('path', { d: 'M 91 22 C 94 13 100 7 108 3 L 101 18 L 98 28 Z', fill: STEM_SHADOW }, shellG);
    addShape('path', { d: 'M 91 25 C 78 26 65 21 61 11 C 74 7 88 11 95 20 Z', fill: STEM_FILL, stroke: STEM_OUTLINE, 'stroke-width': '2.5', style: VECTOR_STROKE }, shellG);
    addShape('path', { d: 'M 65 13 C 76 13 84 17 91 22 C 79 21 71 19 65 13 Z', fill: STEM_HIGHLIGHT }, shellG);
    addShape('path', { d: 'M 66 20 C 77 24 85 24 91 22 C 82 28 72 27 66 20 Z', fill: STEM_SHADOW }, shellG);

    var FACE_GEOMETRY = [
      { role: 'eye-left-dark', d: 'M 47 64 Q 58 42 72 64 Q 59 57 47 64 Z', tone: 'dark' },
      { role: 'eye-right-dark', d: 'M 108 64 Q 122 42 133 64 Q 121 57 108 64 Z', tone: 'dark' },
      { role: 'eye-left-light', d: 'M 52 63 Q 59 51 67 63 Q 59 60 52 63 Z', tone: 'light' },
      { role: 'eye-right-light', d: 'M 113 63 Q 121 51 128 63 Q 121 60 113 63 Z', tone: 'light' },
      { role: 'mouth-top', d: 'M 24 57 Q 45 66 90 65 Q 135 66 156 57 L 154 64 Q 135 67 90 66 Q 45 67 26 64 Z', tone: 'dark' },
      { role: 'nose-dark', d: 'M 84 65 L 90 53 L 96 65 Z', tone: 'dark' },
      { role: 'mouth-left', d: 'M 18 57 Q 19 89 25 107 L 25 67 Z', tone: 'dark' },
      { role: 'mouth-right', d: 'M 162 57 Q 161 89 155 107 L 155 67 Z', tone: 'dark' },
      { role: 'mouth-bottom', d: 'M 26 107 Q 54 120 90 115 Q 126 120 154 107 L 147 116 Q 126 124 90 120 Q 54 124 33 116 Z', tone: 'dark' },
      { role: 'mouth-light', d: 'M 31 109 Q 58 118 90 114 Q 122 118 149 109 L 145 113 Q 122 120 90 117 Q 58 120 35 113 Z', tone: 'light' },
      { role: 'light-core', d: 'M 54 62 Q 59 55 65 62 Z M 115 62 Q 121 55 126 62 Z M 39 111 Q 63 118 90 115 Q 117 118 141 111 Q 116 122 90 119 Q 64 122 39 111 Z', tone: 'core' }
    ];
    var STATE_COLORS = {
      dim: { light: '#A84A16', core: '#A84A16' },
      warm: { light: '#F6A62A', core: '#FFD45A' },
      bright: { light: '#FFD45A', core: '#FFF1A6' }
    };
    function buildFaceGroup(stateName, initialOpacity) {
      var group = addShape('g', { 'data-jol-state': stateName, opacity: String(initialOpacity) }, svg);
      var stateColor = STATE_COLORS[stateName];
      FACE_GEOMETRY.forEach(function (shape) {
        addShape('path', {
          'data-jol-face-part': shape.role,
          d: shape.d,
          fill: shape.tone === 'dark' ? FACE_DARK : stateColor[shape.tone]
        }, group);
      });
      return group;
    }

    var ENTER_DUR = 240, FLICKER_DUR = 2450, FADE_DUR = 300;
    var DUR = FLICKER_DUR + FADE_DUR; // entrance is nested inside the flicker window

    // Every WAAPI animation this beacon creates is collected here and hung off pumpkinEl
    // (the element cancelBeacons() actually selects), matching animateCheshire's own
    // track()/Promise.allSettled idiom for a figure whose animations settle at different
    // times (rule 4/5 of the promotion contract).
    var anims = [];
    function track(a) { anims.push(a); return a; }

    // Whole-figure entrance/hold/exit -- shared verbatim by both Lite and full mode, so
    // Lite Mode's own "monotonic entrance/exit" requirement is met by construction rather
    // than by a second, parallel implementation.
    track(pumpkinEl.animate([
      { transform: 'scale(' + ENTER_SCALE + ')', opacity: 0, offset: 0 },
      { transform: 'scale(1)', opacity: 1, offset: ENTER_DUR / DUR },
      { transform: 'scale(1)', opacity: 1, offset: FLICKER_DUR / DUR },
      { transform: 'scale(1)', opacity: 0, offset: 1 }
    ], { duration: DUR * durFactor, easing: 'ease-out', fill: 'forwards' }));

    if (settings.performanceMode) {
      // Lite Mode (rule 7 of the promotion contract): keep the recognizable shell (built
      // above, unconditionally) and a single warm face -- no dim/bright groups, no
      // flicker. The whole-figure animation above already supplies the monotonic
      // entrance/exit; a static warm face at full opacity needs no animation of its own.
      buildFaceGroup('warm', 1);
    } else {
      var dimGroup = buildFaceGroup('dim', 1);
      var warmGroup = buildFaceGroup('warm', 0);
      var brightGroup = buildFaceGroup('bright', 0);

      // Deterministic irregular flicker (rule 11: no Math.random) -- absolute ms
      // boundaries converted to offsets against the UNSCALED FLICKER_DUR, so durFactor
      // scales every phase boundary proportionally (rule 6) without needing each boundary
      // scaled individually: offset = time/FLICKER_DUR is invariant under a uniform
      // multiply of both time and FLICKER_DUR by durFactor.
      function stateFrames(values) {
        var times = [0, 350, 500, 900, 1000, 1450, 1550, 2050, 2150, FLICKER_DUR];
        return times.map(function (time, i) { return { opacity: values[i], offset: time / FLICKER_DUR }; });
      }
      track(dimGroup.animate(stateFrames([1, 1, 0, 0, 0, 0, 0, 0, 0, 0]), { duration: FLICKER_DUR * durFactor, fill: 'forwards' }));
      track(warmGroup.animate(stateFrames([0, 0, 1, 1, 0, 0, 1, 1, 0, 0]), { duration: FLICKER_DUR * durFactor, fill: 'forwards' }));
      track(brightGroup.animate(stateFrames([0, 0, 0, 0, 1, 1, 0, 0, 1, 1]), { duration: FLICKER_DUR * durFactor, fill: 'forwards' }));
    }

    pumpkinEl.__waapiAnims = anims;

    // Natural completion removes pumpkinEl only once EVERY animation has settled (rule 5).
    // destroyBeacon() still removes pumpkinEl synchronously on cancel, cancelling every
    // entry in __waapiAnims regardless of this promise.
    function removePumpkin() { pumpkinEl.remove(); }
    Promise.allSettled(anims.map(function (a) { return a.finished; })).then(removePumpkin);
  }

  // oculist-nq1x.6: promotes fxHorseman (artifacts/prototypes/effects-playground.html, the
  // accepted design from oculist-1ta.7's user-approved strict-spec redesign and oculist-
  // 1ta.31's pumpkin-as-head refinement) into the shipped beacon contract, the fifth entry
  // in the Halloween pack. A silhouetted rider gallops in, rears, hurls a blazing jack-o'-
  // lantern at the match, and rides off; the pumpkin rides at the rider's collar as its own
  // head through the gallop and rear (oculist-1ta.31's own signature beat) and only becomes
  // a projectile at the throw, leaving the collar empty for the exit. The burst is four
  // amber bands whose inner edges stop exactly at the match's own glyph box (oculist-1ta.7's
  // own accepted redesign), and the exit lifts the whole sprite above the match before
  // crossing it -- both carried forward from the prototype unchanged.
  //
  // Fixed identity palette (the promotion contract's own license, "the pumpkin's orange"):
  // no neighbouring shipped character effect (Skeleton Trot, Flappy, Cheshire Cat, Pumpkin
  // Glow) has established an accessibility-accent precedent that applies here, and (like
  // Pumpkin Glow's own shell and Cheshire Cat's own fur) this effect has no separate flash
  // element to carry getEffectiveColors().beacon as an accent -- the burst bands are the
  // character's own fire, not a UI accent.
  //
  // Lite Mode (rule 7 of the promotion contract): a no-op, the same reasoning
  // animateCheshire's own header comment gives for itself -- this effect has no filter, no
  // box-shadow, and no glow anywhere in its art or its burst; every opacity swap (gallop,
  // rear, throw, exit) is the effect's own defining beat, not a decorative flicker, so
  // there is nothing here that fits the "drop glows/box-shadows/multi-state flicker" cut.
  // settings.performanceMode is deliberately never read below.
  function animateHorseman(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;

    var NS = 'http://www.w3.org/2000/svg';

    var INK = '#18263c';
    var MID = '#243754';
    var COOL = '#3f5d82';
    var COOL_LIGHT = '#7892b5';
    var AMBER = '#c86b2a';

    var beaconScale = getBeaconScale();
    var durFactor = getBeaconDuration(1);

    // ── Local art coordinates (one 240x160 grid, authored facing +x/right; the complete
    // frame is mirrored when staging on the right). SPRITE_H carries getBeaconScale() (rule
    // 6) BEFORE any placement/clearance math below is derived from it -- SCALE, SPRITE_W,
    // GAP_CLEAR, stageNeed, and every downstream position all flow from this one root value,
    // the same "scale before computing placement" discipline animateJackOLantern's own
    // frameScale uses, so nothing downstream can independently forget the multiply (the
    // defect class that hit animateFlappy: a placement offset computed from the UNSCALED
    // sprite height while a separate transform scaled around the centre). There is also no
    // second, independently-scaled coordinate space to double-scale by accident (the defect
    // class that hit animateCheshire): every pixel size below (SPRITE_W/H, HEAD_SIZE,
    // PUMPKIN_SIZE) is multiplied by beaconScale exactly once, at its own declaration. ──
    var VB_W = 240, VB_H = 160;
    var SPRITE_H = 100 * beaconScale;
    var SCALE = SPRITE_H / VB_H;
    var SPRITE_W = VB_W * SCALE;

    function poly(points, parent, fill) {
      var el = document.createElementNS(NS, 'polygon');
      el.setAttribute('points', points);
      el.setAttribute('fill', fill || INK);
      parent.appendChild(el);
      return el;
    }
    function ellipse(cx, cy, rx, ry, parent, fill, detail) {
      var el = document.createElementNS(NS, 'ellipse');
      el.setAttribute('cx', cx); el.setAttribute('cy', cy);
      el.setAttribute('rx', rx); el.setAttribute('ry', ry);
      el.setAttribute('fill', fill || INK);
      if (detail) el.setAttribute('data-horseman-detail', detail);
      parent.appendChild(el);
      return el;
    }
    function path(d, parent, fill, detail) {
      var el = document.createElementNS(NS, 'path');
      el.setAttribute('d', d);
      el.setAttribute('fill', fill || INK);
      if (detail) el.setAttribute('data-horseman-detail', detail);
      parent.appendChild(el);
      return el;
    }
    function group(parent) {
      var g = document.createElementNS(NS, 'g');
      if (parent) parent.appendChild(g);
      return g;
    }

    // Horse and rider common core -- authored once, then cloned for the normal and rear
    // assemblies so both copies are byte-identical. Verbatim from the prototype.
    function addCore(g) {
      path('M104 37 C88 34 78 40 68 43 C52 43 38 37 22 32 C34 45 49 51 67 53 C51 56 35 53 18 47 C34 62 57 66 79 59 C66 67 50 69 34 65 C51 76 78 70 101 57 Z', g, INK, 'cape');
      path('M98 41 C82 39 70 47 57 49 C44 49 35 46 27 43 C40 54 58 59 77 55 C65 62 54 64 45 63 C61 67 78 63 96 54 Z', g, MID);
      path('M92 43 C78 43 68 49 58 51 C47 52 40 50 34 48 C45 55 60 57 75 54 C67 59 61 61 54 62 C69 62 82 57 94 51 Z', g, COOL);

      path('M47 82 C34 71 22 66 8 68 C18 75 29 81 42 85 C28 83 17 87 6 94 C21 94 35 94 49 92 Z', g, INK);
      path('M48 88 C34 86 19 94 6 107 C23 101 37 99 52 95 Z', g, MID);
      path('M44 80 C32 69 21 63 10 62 C22 72 33 78 45 87 Z', g, COOL);

      path('M45 84 C49 74 60 67 75 65 C90 63 105 67 120 68 C141 68 161 73 176 83 C181 89 177 98 168 103 C149 109 127 110 104 107 L84 105 C65 106 50 100 45 92 Z', g, INK);
      path('M49 83 C53 72 65 67 78 67 C68 72 62 80 61 91 C61 97 66 101 73 104 C58 103 49 97 47 91 Z', g, MID, 'haunch');
      path('M56 79 C63 72 72 69 84 68 C72 75 68 84 68 95 C60 91 56 86 56 79 Z', g, COOL);
      path('M77 72 C99 67 126 70 146 74 C130 77 113 80 94 82 C85 81 80 77 77 72 Z', g, MID);
      path('M137 73 C155 74 170 78 177 85 C179 91 175 98 166 102 C166 91 156 82 143 79 Z', g, MID, 'shoulder');
      path('M151 77 C164 78 172 82 175 87 C174 93 171 97 166 99 C165 89 159 82 151 77 Z', g, COOL);
      path('M88 101 C108 104 132 104 151 100 C137 108 104 112 82 105 Z', g, COOL);

      path('M157 90 C164 73 174 57 188 47 C198 40 211 39 222 46 L235 56 C239 61 236 67 231 70 L220 72 C214 71 209 66 205 63 L197 60 C188 70 184 84 178 99 Z', g, INK);
      path('M164 88 C172 68 183 53 198 46 C187 59 181 76 179 94 Z', g, MID);
      path('M170 83 C178 64 187 51 199 47 C190 60 186 72 182 89 Z', g, COOL);
      path('M176 73 C182 58 189 51 198 47 C190 58 187 67 184 78 Z', g, COOL_LIGHT);
      path('M185 55 C179 50 177 45 176 40 C183 43 188 47 190 50 C187 44 188 38 188 34 C194 39 198 43 199 48 C199 41 202 36 204 32 C208 39 210 43 209 48 C211 43 215 40 218 38 C218 44 217 48 214 51 Z', g, MID, 'mane-lock');
      path('M188 52 C185 47 184 43 184 39 C190 43 193 46 194 50 Z', g, COOL);
      path('M202 48 C203 42 206 38 208 35 C211 41 211 45 210 49 Z', g, COOL);
      poly('207,44 212,30 218,45', g, INK);
      poly('217,47 223,35 226,50', g, INK);
      path('M204 55 C211 48 221 48 228 52 L237 58 L234 67 L224 71 L214 67 L209 62 Z', g, MID);
      path('M213 63 C220 66 228 65 235 61 L234 67 L224 71 L216 68 Z', g, COOL, 'jaw');
      path('M230 59 C234 58 237 60 236 63 C233 62 231 62 229 63 Z', g, '#0b1220', 'nostril');
      ellipse(214, 53, 3, 2.2, g, '#f59e0b');
      ellipse(214.4, 52.6, 1.1, 0.8, g, '#fff06a');

      path('M86 72 C98 67 117 66 130 69 L144 78 L136 88 C122 91 104 91 89 87 Z', g, COOL);
      path('M93 76 C106 72 123 72 136 79 L130 86 C118 87 105 86 96 84 Z', g, MID);
      path('M96 64 L94 43 C96 36 101 31 107 28 L119 28 C125 31 130 37 132 44 L132 63 C129 70 124 75 116 77 L104 74 C100 72 98 68 96 64 Z', g, INK);
      path('M98 45 C101 37 105 32 112 30 L108 48 L111 62 L102 65 C99 57 98 50 98 45 Z', g, COOL);
      path('M112 31 L118 42 L111 51 L104 37 Z', g, MID, 'lapel');
      path('M118 31 L128 40 L121 51 L116 42 Z', g, COOL);
      path('M101 35 L108 27 L122 27 L128 34 L122 42 L116 34 L109 42 Z', g, AMBER);
      path('M105 32 L111 27 L120 27 L124 32 L119 34 L111 34 Z', g, '#05070c');
      path('M95 61 L104 68 L103 80 L94 91 C94 82 95 72 95 61 Z', g, INK);
      path('M123 64 L132 70 L132 85 L121 79 Z', g, MID);
      path('M98 64 L104 69 L101 78 L96 83 Z', g, COOL);
      path('M94 53 L100 51 L126 51 L132 54 L130 59 L96 58 Z', g, AMBER);
      path('M110 52 L118 52 L119 58 L111 58 Z', g, '#e8a24a', 'belt-buckle');
      path('M115 72 C123 74 130 80 134 87 L143 99 L137 104 L128 96 L119 86 L110 80 Z', g, INK);
      path('M122 78 C129 83 134 90 138 97 L134 99 C129 92 124 87 117 83 Z', g, COOL);
      path('M136 98 C141 99 145 100 148 103 L144 108 L132 106 C132 102 133 100 136 98 Z', g, MID, 'rider-boot');
      path('M136 100 L145 102 L142 105 L134 104 Z', g, COOL_LIGHT);
    }
    function addLegsExtended(g) {
      path('M78 98 C85 98 91 102 92 108 C84 113 76 119 69 125 L48 141 L35 141 C34 138 35 135 39 132 L59 114 C65 106 70 101 78 98 Z', g, MID);
      path('M63 113 C67 111 72 114 73 118 C68 124 61 132 53 139 L46 138 C51 128 56 119 63 113 Z', g, COOL);
      path('M74 97 C82 98 88 103 89 109 C84 117 78 124 72 131 L63 146 L48 147 C44 145 44 142 48 139 L58 121 C61 111 66 103 74 97 Z', g, INK);
      path('M61 121 C65 117 70 118 73 122 C69 130 65 137 61 144 L54 144 C56 136 58 128 61 121 Z', g, COOL, 'leg-joint');
      path('M47 141 C52 140 59 140 64 143 L61 149 L45 149 C42 147 43 144 47 141 Z', g, COOL_LIGHT, 'hoof-plane');

      path('M142 98 C150 96 157 99 162 104 C168 113 177 121 188 128 L201 136 C202 139 200 142 196 143 L184 139 L170 128 C160 121 151 114 144 108 Z', g, MID);
      path('M158 105 C163 104 167 107 168 112 C174 119 182 126 190 132 L185 137 C176 131 168 124 160 116 Z', g, COOL);
      path('M149 96 C157 97 163 101 167 108 C175 119 184 129 196 137 L220 144 C223 147 220 151 216 152 L201 149 L181 139 C172 133 163 125 155 116 L145 109 Z', g, INK);
      path('M174 120 C179 118 184 121 185 126 C191 134 200 139 208 143 L204 148 C193 144 183 137 176 130 Z', g, COOL, 'leg-joint');
      path('M201 145 C208 143 217 144 222 147 C221 151 218 153 213 153 L200 150 Z', g, COOL_LIGHT, 'hoof-plane');
    }
    function addLegsGathered(g) {
      path('M77 98 C85 98 91 102 92 108 C88 114 85 119 84 123 C89 125 95 128 100 132 C99 136 96 139 91 140 C82 135 75 130 70 124 C67 117 68 105 77 98 Z', g, MID);
      path('M80 113 C84 111 88 113 89 117 C88 122 88 125 91 128 L86 132 C80 127 77 121 80 113 Z', g, COOL, 'leg-joint');
      path('M71 98 C79 98 85 102 87 108 C81 115 75 121 70 126 C72 133 77 139 81 143 C79 147 75 149 69 149 C61 141 57 131 56 123 C59 113 62 104 71 98 Z', g, INK);
      path('M65 121 C69 119 74 121 75 126 C74 133 77 138 80 142 L74 145 C67 138 64 130 65 121 Z', g, COOL);
      path('M68 143 C73 140 80 141 83 145 C80 149 76 151 69 151 C65 149 65 146 68 143 Z', g, COOL_LIGHT, 'hoof-plane');

      path('M144 98 C152 97 159 101 161 107 C158 114 153 119 147 123 L137 133 C132 134 127 131 124 127 C128 121 133 116 139 111 Z', g, MID);
      path('M143 111 C148 109 153 111 154 115 C149 122 144 127 138 131 L133 128 C136 122 139 116 143 111 Z', g, COOL, 'leg-joint');
      path('M151 98 C160 99 166 104 168 111 C172 116 176 121 178 126 C175 135 171 143 164 149 L151 149 C148 146 149 143 153 140 C156 133 158 127 160 122 C155 118 149 114 144 110 Z', g, INK);
      path('M160 119 C165 117 170 120 171 125 C169 133 166 140 162 145 L155 145 C159 136 161 128 160 119 Z', g, COOL);
      path('M151 144 C157 141 165 142 168 146 C166 150 162 152 154 152 C150 150 149 147 151 144 Z', g, COOL_LIGHT, 'hoof-plane');
    }
    function addArmDown(g) {
      path('M102 41 C97 42 93 46 92 51 C95 58 99 64 104 69 L113 64 C109 58 107 51 108 45 Z', g, MID);
      path('M97 49 C99 46 102 45 106 46 C104 52 106 58 110 63 L105 65 C100 60 98 55 97 49 Z', g, COOL);
      path('M121 40 C127 40 132 43 136 48 L147 59 L143 66 C136 63 129 59 123 55 C120 50 119 45 121 40 Z', g, INK);
      path('M138 58 L147 57 L151 62 L144 68 L138 65 Z', g, AMBER, 'cuff');
      path('M146 58 C151 57 155 59 156 63 C153 67 148 68 143 66 Z', g, COOL_LIGHT, 'glove');
    }
    function addArmCocked(g) {
      path('M102 41 C97 42 93 46 92 51 C95 58 99 64 104 69 L113 64 C109 58 107 51 108 45 Z', g, MID);
      path('M121 42 C126 41 131 39 133 35 C130 29 126 23 121 20 L114 22 C111 28 108 35 108 41 L113 47 Z', g, INK);
      path('M117 23 C120 20 124 20 127 23 C129 28 131 32 132 36 L126 39 C123 33 120 28 117 23 Z', g, COOL);
      path('M113 22 L110 16 L115 12 L121 15 L123 22 L119 26 Z', g, AMBER, 'cuff');
      path('M111 16 C111 12 114 9 118 9 C122 11 123 14 121 18 C118 20 114 19 111 16 Z', g, COOL_LIGHT, 'glove');
    }
    function addArmThrow(g) {
      path('M102 41 C97 42 93 46 92 51 C95 58 99 64 104 69 L113 64 C109 58 107 51 108 45 Z', g, MID);
      path('M120 40 C126 38 131 35 137 33 L157 23 C165 20 174 19 181 20 L187 25 C181 30 174 33 165 33 L145 41 L132 52 C126 50 122 46 120 40 Z', g, INK);
      path('M132 37 C142 32 151 27 160 24 C167 22 174 22 179 23 C171 26 164 29 157 31 L138 44 Z', g, COOL);
      path('M176 20 L183 19 L188 24 L183 30 L177 28 Z', g, AMBER, 'cuff');
      path('M183 18 C187 16 190 17 190 20 L187 23 L192 21 L193 24 L188 27 L193 28 L191 31 L184 30 L180 26 Z', g, COOL_LIGHT, 'glove');
    }

    // ── Rear pose: one static SVG rotate() around the hind hoof -- pre-authored, not
    // animated, so "rearing" is free (the usual opacity swap other frames already use). ──
    var PIVOT_X = 55, PIVOT_Y = 140;
    var REAR_ANGLE_DEG = -24;
    var REAR_TRANSFORM = 'rotate(' + REAR_ANGLE_DEG + ' ' + PIVOT_X + ' ' + PIVOT_Y + ')';
    var REAR_RAD = REAR_ANGLE_DEG * Math.PI / 180;
    var cosA = Math.cos(REAR_RAD), sinA = Math.sin(REAR_RAD);
    function rotPt(x, y) {
      var dx = x - PIVOT_X, dy = y - PIVOT_Y;
      return [PIVOT_X + dx * cosA - dy * sinA, PIVOT_Y + dx * sinA + dy * cosA];
    }
    var HAND_THROW_LOCAL = [186, 25]; // matches addArmThrow's release tip
    var HEAD_LOCAL = [114, 19]; // bottom of the head meets the y=33 collar
    var HEAD_SIZE = 18 * beaconScale;

    // ── Viewport-space fit decision + travel geometry (rule 2 of the promotion contract):
    // vw and every value below derived from `rect` (the PRE-SCROLL viewport rect animate()
    // hands in) stay in viewport pixels through this whole block -- direction, GAP_CLEAR/
    // stageNeed, and every travel/rear/exit position, exactly as the prototype computes
    // them. Nothing here is a final CSS position yet: SCROLL_X/SCROLL_Y (below) are added
    // exactly once, at the point each value is actually written into a path string or a
    // left/top -- animateFlappy's own endX/endY precedent for an offset-path effect. ──
    var vw = window.innerWidth;
    var mcx = rect.left + rect.width / 2; // viewport space
    var GAP_CLEAR = SPRITE_W * 0.8;
    var stageNeed = SPRITE_W / 2 + GAP_CLEAR;
    var direction = rect.left >= stageNeed || rect.left >= vw - rect.right ? 1 : -1;
    var startX = direction > 0 ? -SPRITE_W : vw + SPRITE_W; // viewport space
    var endX = direction > 0 ? vw + SPRITE_W : -SPRITE_W; // viewport space
    var CENTER_Y = rect.top + rect.height * 0.3; // viewport space
    var rearX = direction > 0
      ? rect.left - GAP_CLEAR
      : Math.min(rect.right + GAP_CLEAR, vw - SPRITE_W / 2); // viewport space
    var pathLen = Math.abs(endX - startX);
    var pctAtRear = Math.abs(rearX - startX) / pathLen * 100; // dimensionless ratio, no scroll term

    var SCROLL_X = window.scrollX, SCROLL_Y = window.scrollY;
    var pathStr = 'M ' + (startX + SCROLL_X) + ' ' + (CENTER_Y + SCROLL_Y) +
      ' L ' + (endX + SCROLL_X) + ' ' + (CENTER_Y + SCROLL_Y); // document space

    var outer = document.createElement('div');
    outer.className = 'oc-beacon oc-beacon-transient';
    outer.setAttribute('data-horseman-direction', direction > 0 ? 'normal' : 'mirrored');
    outer.style.cssText = [
      'position:absolute',
      'left:0', 'top:0',
      'width:' + SPRITE_W + 'px', 'height:' + SPRITE_H + 'px',
      'pointer-events:none',
      'z-index:2147483642',
      "offset-path:path('" + pathStr + "')", 'offset-anchor:50% 50%', 'offset-rotate:0deg',
      'opacity:1'
    ].join(';');
    document.documentElement.appendChild(outer);

    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', String(SPRITE_W));
    svg.setAttribute('height', String(SPRITE_H));
    svg.setAttribute('viewBox', '0 0 ' + VB_W + ' ' + VB_H);
    svg.setAttribute('data-horseman-role', 'sprite');
    svg.style.cssText = 'display:block;overflow:visible;' + (direction < 0 ? 'transform:scaleX(-1);' : '');
    outer.appendChild(svg);

    var coreTemplate = group();
    coreTemplate.setAttribute('data-horseman-part', 'core');
    addCore(coreTemplate);
    var coreNormal = coreTemplate.cloneNode(true);
    svg.appendChild(coreNormal);
    var legsGallopA = group(svg);
    legsGallopA.setAttribute('data-horseman-part', 'legs-extended');
    addLegsExtended(legsGallopA);
    var legsGallopB = group(svg);
    legsGallopB.setAttribute('data-horseman-part', 'legs-gathered');
    addLegsGathered(legsGallopB);
    var armDown = group(svg);
    armDown.setAttribute('data-horseman-part', 'arm-down');
    addArmDown(armDown);

    var coreRear = group(svg);
    coreRear.setAttribute('transform', REAR_TRANSFORM);
    coreRear.appendChild(coreTemplate.cloneNode(true));
    var legsRear = group(coreRear);
    legsRear.setAttribute('data-horseman-part', 'legs-extended-rear');
    addLegsExtended(legsRear); // exact extended group, rotated with the shared core
    var armCocked = group(svg);
    armCocked.setAttribute('data-horseman-part', 'arm-cocked');
    armCocked.setAttribute('transform', REAR_TRANSFORM);
    addArmCocked(armCocked);
    var armThrow = group(svg);
    armThrow.setAttribute('data-horseman-part', 'arm-throw');
    armThrow.setAttribute('transform', REAR_TRANSFORM);
    addArmThrow(armThrow);

    legsGallopB.style.opacity = '0';
    coreRear.style.opacity = '0';
    armCocked.style.opacity = '0';
    armThrow.style.opacity = '0';

    // ── Timeline (ms), scaled through durFactor (rule 6) at every duration/delay below --
    // every boundary here stays a RAW, unscaled constant, used only for offset RATIOS
    // (offset = time/DUR) and iteration counts, both invariant under a uniform durFactor
    // multiply of both the numerator and denominator -- the same reasoning
    // animateJackOLantern's own stateFrames() comment gives for its own FLICKER_DUR. ──
    var ENTRY_DUR = 850;
    var RISE_START = ENTRY_DUR;
    var REAR_RISE_DUR = 160;
    var RISE_END = RISE_START + REAR_RISE_DUR;
    var REAR_HOLD_DUR = 130;
    var LAUNCH_T = RISE_END + REAR_HOLD_DUR;
    var THROW_DUR = 90;
    var SETTLE_START = LAUNCH_T + THROW_DUR;
    var REAR_SETTLE_DUR = 150;
    var SETTLE_END = SETTLE_START + REAR_SETTLE_DUR;
    var PUMPKIN_FLIGHT_DUR = 420;
    var burstStart = LAUNCH_T + PUMPKIN_FLIGHT_DUR;
    var BURST_DUR = 320;
    var burstEnd = burstStart + BURST_DUR;
    // Exit motion never resumes before the burst has fully finished (not just started) --
    // measured (oculist-1ta.7): resuming translation while the burst was still fading let
    // the horse's own dark silhouette sweep back into the match's rect mid-fade, compounding
    // a second luminance dip on top of the burst's own. Waiting for burstEnd keeps the two
    // events cleanly sequential instead of overlapping.
    var EXIT_RESUME_T = Math.max(SETTLE_END, burstEnd);
    var EXIT_LIFT_DUR = 100;
    var EXIT_TRAVEL_T = EXIT_RESUME_T + EXIT_LIFT_DUR;
    var EXIT_DUR = 850;
    var horseExitEnd = EXIT_TRAVEL_T + EXIT_DUR;
    var DUR = Math.max(horseExitEnd, burstEnd) + 60;

    var PERIOD = 150;
    var entryIter = ENTRY_DUR / PERIOD;
    var exitIter = EXIT_DUR / PERIOD;
    var galA = [
      { opacity: 1, offset: 0 }, { opacity: 1, offset: 0.49 },
      { opacity: 0, offset: 0.5 }, { opacity: 0, offset: 1 }
    ];
    var galB = [
      { opacity: 0, offset: 0 }, { opacity: 0, offset: 0.49 },
      { opacity: 1, offset: 0.5 }, { opacity: 1, offset: 1 }
    ];

    // Every WAAPI animation this beacon creates -- including on the many child <g>/<div>
    // nodes below -- is collected here and hung off `outer` (one of the elements
    // cancelBeacons() actually selects), the same track()/Promise.allSettled idiom
    // animateCheshire's own header comment describes (rule 4/5 of the promotion contract).
    var outerAnims = [];
    function trackOuter(a) { outerAnims.push(a); return a; }

    trackOuter(legsGallopA.animate(galA, { duration: PERIOD * durFactor, iterations: entryIter, fill: 'forwards' }));
    trackOuter(legsGallopB.animate(galB, { duration: PERIOD * durFactor, iterations: entryIter, fill: 'forwards' }));
    // Fade the gallop legs out in the SAME window, on the SAME schedule, as coreNormal
    // below -- they are coreNormal's own legs, not coreRear's (which bakes its own legs
    // into addLegsExtended(coreRear) above, fading in at exactly coreRear's own opacity).
    trackOuter(legsGallopA.animate([{ opacity: 0 }, { opacity: 0 }], { duration: 40 * durFactor, delay: RISE_START * durFactor, fill: 'forwards' }));
    trackOuter(legsGallopB.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 40 * durFactor, delay: RISE_START * durFactor, fill: 'forwards' }));
    // Standing/settled legs: coreRear's rotated legs fade out at SETTLE_START, but the
    // gallop-cycle legs below don't resume until EXIT_RESUME_T (after the throw's flight
    // and burst finish) -- without this the horse stood there legless for that stretch.
    trackOuter(legsGallopB.animate([{ opacity: 1 }, { opacity: 1 }], { duration: 1 * durFactor, delay: SETTLE_START * durFactor, fill: 'forwards' }));
    trackOuter(legsGallopA.animate(galA, { duration: PERIOD * durFactor, delay: EXIT_TRAVEL_T * durFactor, iterations: exitIter, fill: 'forwards' }));
    trackOuter(legsGallopB.animate(galB, { duration: PERIOD * durFactor, delay: EXIT_TRAVEL_T * durFactor, iterations: exitIter, fill: 'forwards' }));

    trackOuter(coreNormal.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 40 * durFactor, delay: RISE_START * durFactor, fill: 'forwards' }));
    trackOuter(armDown.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 40 * durFactor, delay: RISE_START * durFactor, fill: 'forwards' }));
    trackOuter(coreNormal.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 40 * durFactor, delay: SETTLE_START * durFactor, fill: 'forwards' }));
    trackOuter(armDown.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 40 * durFactor, delay: SETTLE_START * durFactor, fill: 'forwards' }));

    trackOuter(coreRear.animate([{ opacity: 0 }, { opacity: 1 }], { duration: REAR_RISE_DUR * durFactor, delay: RISE_START * durFactor, easing: 'ease-out', fill: 'forwards' }));
    trackOuter(coreRear.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 40 * durFactor, delay: SETTLE_START * durFactor, fill: 'forwards' }));

    trackOuter(armCocked.animate([{ opacity: 0 }, { opacity: 1 }], { duration: REAR_RISE_DUR * durFactor, delay: RISE_START * durFactor, easing: 'ease-out', fill: 'forwards' }));
    // The reaching arm cuts to the throw arm at the same instant the head detaches and
    // appears at the release hand.
    trackOuter(armCocked.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 1 * durFactor, delay: (RISE_END - 1) * durFactor, fill: 'forwards' }));
    trackOuter(armThrow.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1 * durFactor, delay: (RISE_END - 1) * durFactor, fill: 'forwards' }));
    trackOuter(armThrow.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 40 * durFactor, delay: SETTLE_START * durFactor, fill: 'forwards' }));

    trackOuter(outer.animate([
      { offsetDistance: '0%', offset: 0 },
      { offsetDistance: pctAtRear + '%', offset: ENTRY_DUR / DUR },
      { offsetDistance: pctAtRear + '%', offset: EXIT_TRAVEL_T / DUR },
      { offsetDistance: '100%', offset: horseExitEnd / DUR },
      { offsetDistance: '100%', offset: 1 }
    ], { duration: DUR * durFactor, easing: 'linear', fill: 'forwards' }));

    // Lift the full sprite box above #match before horizontal exit travel, hold it there
    // until the box clears the far edge, then settle back to baseline -- a pure vertical
    // TRANSLATE DELTA computed entirely from viewport-space distances (rect.top, CENTER_Y,
    // SPRITE_H), so it needs no scroll term of its own: it moves the element relative to
    // wherever the offset-path animation above already placed it.
    var EXIT_CLEARANCE = 8;
    var exitDY = rect.top - EXIT_CLEARANCE - (CENTER_Y + SPRITE_H / 2);
    var exitSpan = Math.abs(endX - rearX);
    var clearCenterX = direction > 0 ? rect.right + SPRITE_W / 2 : rect.left - SPRITE_W / 2;
    var exitClearT = EXIT_TRAVEL_T + Math.abs(clearCenterX - rearX) / exitSpan * EXIT_DUR;
    var exitDropEndT = Math.min(horseExitEnd, exitClearT + EXIT_LIFT_DUR);
    trackOuter(outer.animate([
      { transform: 'translateY(0px)', offset: 0 },
      { transform: 'translateY(0px)', offset: EXIT_RESUME_T / DUR },
      { transform: 'translateY(' + exitDY + 'px)', offset: EXIT_TRAVEL_T / DUR },
      { transform: 'translateY(' + exitDY + 'px)', offset: exitClearT / DUR },
      { transform: 'translateY(0px)', offset: exitDropEndT / DUR },
      { transform: 'translateY(0px)', offset: 1 }
    ], { duration: DUR * durFactor, easing: 'linear', fill: 'forwards' }));

    // ── Pumpkin: normal and rear heads are bound to their matching pose groups (oculist-
    // 1ta.31's own signature beat -- the pumpkin rides as the rider's head until the
    // throw), then the existing projectile takes over at the throw. spriteLeft/spriteTop
    // and everything derived from them below stay in viewport space, like rearX/CENTER_Y
    // above; SCROLL_X/SCROLL_Y are added once, at pumpPath's own construction. ──
    var handRot = rotPt(HAND_THROW_LOCAL[0], HAND_THROW_LOCAL[1]);
    var spriteLeft = rearX - SPRITE_W / 2, spriteTop = CENTER_Y - SPRITE_H / 2; // viewport space
    var pumpStartX = spriteLeft + (direction > 0 ? handRot[0] : VB_W - handRot[0]) * SCALE; // viewport space
    var pumpStartY = spriteTop + handRot[1] * SCALE; // viewport space
    // Pinned so the pumpkin's own bottom edge (offset-anchor 50% 50%, so the box extends
    // PUMPKIN_SIZE/2 = 13*beaconScale below this center point) always lands a constant 5px
    // into the match rect, at every Beacon Size -- not a flat center offset, which let the
    // painted intrusion balloon as PUMPKIN_SIZE grew with beaconScale (oculist-4afn).
    var pumpTargetX = mcx, pumpTargetY = rect.top + 5 - 13 * beaconScale; // viewport space
    var ARC_HEIGHT = 70;
    var pMidX = (pumpStartX + pumpTargetX) / 2, pMidY = (pumpStartY + pumpTargetY) / 2 - ARC_HEIGHT; // viewport space
    var pumpPath = 'M ' + (pumpStartX + SCROLL_X) + ' ' + (pumpStartY + SCROLL_Y) +
      ' Q ' + (pMidX + SCROLL_X) + ' ' + (pMidY + SCROLL_Y) + ' ' +
      (pumpTargetX + SCROLL_X) + ' ' + (pumpTargetY + SCROLL_Y); // document space

    var PUMPKIN_SIZE = 26 * beaconScale;
    var pumpkin = document.createElement('div');
    pumpkin.className = 'oc-beacon oc-beacon-transient';
    pumpkin.style.cssText = [
      'position:absolute',
      'left:0', 'top:0',
      'width:' + PUMPKIN_SIZE + 'px', 'height:' + PUMPKIN_SIZE + 'px',
      'pointer-events:none',
      'z-index:2147483642',
      "offset-path:path('" + pumpPath + "')", 'offset-anchor:50% 50%', 'offset-rotate:0deg',
      'opacity:0'
    ].join(';');
    document.documentElement.appendChild(pumpkin);

    function makePumpkin() {
      var art = document.createElementNS(NS, 'svg');
      art.setAttribute('viewBox', '0 0 30 30');
      art.setAttribute('width', '100%');
      art.setAttribute('height', '100%');
      art.setAttribute('data-horseman-part', 'pumpkin');
      art.style.cssText = 'display:block;overflow:visible;';
      path('M14 6 C13 2 15 0 19 1 C17 2 17 4 18 7 Z', art, '#365314');
      ellipse(15, 17, 12, 11, art, '#b93808');
      ellipse(9, 17, 6, 10, art, '#e85d04');
      ellipse(15, 17, 6, 11, art, '#f97316');
      ellipse(21, 17, 6, 10, art, '#e85d04');
      path('M5 14 L12 9 L11 18 Z M25 14 L18 9 L19 18 Z', art, '#fff06a');
      path('M5 19 L10 21 L14 18 L18 21 L25 18 L22 26 L18 24 L14 28 L10 24 L7 26 Z', art, '#fff06a');
      path('M6 9 C10 5 20 5 24 10 C21 8 18 8 15 8 C12 8 9 8 6 9 Z', art, '#f59e0b');
      return art;
    }
    var pumpkinTemplate = makePumpkin();
    var pumpSpin = document.createElement('div');
    pumpSpin.style.cssText = 'position:relative;width:100%;height:100%;';
    pumpSpin.appendChild(pumpkinTemplate.cloneNode(true));
    pumpkin.appendChild(pumpSpin);

    var headNormal = document.createElement('div');
    headNormal.setAttribute('data-horseman-part', 'head-normal');
    headNormal.style.cssText = 'position:absolute;width:' + HEAD_SIZE + 'px;height:' + HEAD_SIZE + 'px;' +
      'left:' + (HEAD_LOCAL[0] * SCALE - HEAD_SIZE / 2) + 'px;' +
      'top:' + (HEAD_LOCAL[1] * SCALE - HEAD_SIZE / 2) + 'px;';
    headNormal.appendChild(pumpkinTemplate.cloneNode(true));
    var headLayer = document.createElement('div');
    headLayer.setAttribute('data-horseman-part', 'head-layer');
    headLayer.style.cssText = 'position:absolute;inset:0;' + (direction < 0 ? 'transform:scaleX(-1);' : '');
    outer.appendChild(headLayer);
    headLayer.appendChild(headNormal);

    // cloneNode(true) also copies data-horseman-part='head-normal' -- overwritten below so
    // the two heads stay independently selectable.
    var headRear = headNormal.cloneNode(true);
    headRear.setAttribute('data-horseman-part', 'head-rear');
    headRear.style.opacity = '0';
    headRear.style.transform = 'rotate(' + REAR_ANGLE_DEG + 'deg)';
    headRear.style.transformOrigin =
      (PIVOT_X * SCALE - (HEAD_LOCAL[0] * SCALE - HEAD_SIZE / 2)) + 'px ' +
      (PIVOT_Y * SCALE - (HEAD_LOCAL[1] * SCALE - HEAD_SIZE / 2)) + 'px';
    headLayer.appendChild(headRear);

    trackOuter(headNormal.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 40 * durFactor, delay: RISE_START * durFactor, fill: 'forwards' }));
    trackOuter(headRear.animate([{ opacity: 0 }, { opacity: 1 }], { duration: REAR_RISE_DUR * durFactor, delay: RISE_START * durFactor, easing: 'ease-out', fill: 'forwards' }));
    // The head detaches at the exact instant armCocked cuts to armThrow above (RISE_END-1).
    trackOuter(headRear.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 1 * durFactor, delay: (RISE_END - 1) * durFactor, fill: 'forwards' }));

    // Pumpkin's own animations: hung off `pumpkin` itself (rule 4), not `outer` -- it is
    // its own top-level .oc-beacon element, detached from the rider at the throw.
    var pumpkinAnims = [];
    function trackPumpkin(a) { pumpkinAnims.push(a); return a; }

    trackPumpkin(pumpkin.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1 * durFactor, delay: (RISE_END - 1) * durFactor, fill: 'forwards' }));
    trackPumpkin(pumpkin.animate([
      { offsetDistance: '0%' }, { offsetDistance: '100%' }
    ], { duration: PUMPKIN_FLIGHT_DUR * durFactor, delay: LAUNCH_T * durFactor, easing: 'ease-out', fill: 'forwards' }));
    trackPumpkin(pumpSpin.animate([
      { transform: 'rotate(0deg)' }, { transform: 'rotate(900deg)' }
    ], { duration: PUMPKIN_FLIGHT_DUR * durFactor, delay: LAUNCH_T * durFactor, easing: 'linear', fill: 'forwards' }));
    trackPumpkin(pumpkin.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 60 * durFactor, delay: burstStart * durFactor, fill: 'forwards' }));

    outer.__waapiAnims = outerAnims;
    pumpkin.__waapiAnims = pumpkinAnims;

    function removeOuter() { outer.remove(); }
    function removePumpkin2() { pumpkin.remove(); }
    Promise.allSettled(outerAnims.map(function (a) { return a.finished; })).then(removeOuter);
    Promise.allSettled(pumpkinAnims.map(function (a) { return a.finished; })).then(removePumpkin2);

    // ── Burst: four bands pulse OUTSIDE the match rect, inner edges stopping exactly at
    // the glyph box (oculist-1ta.7's own accepted strict-spec redesign -- the word stays
    // byte-for-byte unchanged, rule 10). Each band's width and height come from the match's
    // own real dimensions and burstPad is a flat 10px; neither is multiplied by
    // getBeaconScale(), for the same "hard geometric requirement, not a stylistic one"
    // reasoning animateJackOLantern's own mouth-mode comment gives for its frameScale: the
    // bands frame the word, so they track the word, not the figure. Each band is its own
    // top-level .oc-beacon element (rule 3/4). ──
    var burstPad = 10;
    [
      [rect.left - burstPad, rect.top - burstPad, rect.width + burstPad * 2, burstPad, '50% 100%', 'scale(0.72,0.2)', 'scale(1.08,1.35)', 'polygon(0 100%,18% 15%,32% 72%,50% 0,68% 72%,82% 15%,100% 100%)'],
      [rect.left - burstPad, rect.bottom, rect.width + burstPad * 2, burstPad, '50% 0%', 'scale(0.72,0.2)', 'scale(1.08,1.35)', 'polygon(0 0,18% 85%,32% 28%,50% 100%,68% 28%,82% 85%,100% 0)'],
      [rect.left - burstPad, rect.top, burstPad, rect.height, '100% 50%', 'scale(0.2,0.72)', 'scale(1.35,1.08)', 'polygon(100% 0,15% 18%,72% 32%,0 50%,72% 68%,15% 82%,100% 100%)'],
      [rect.right, rect.top, burstPad, rect.height, '0% 50%', 'scale(0.2,0.72)', 'scale(1.35,1.08)', 'polygon(0 0,85% 18%,28% 32%,100% 50%,28% 68%,85% 82%,0 100%)']
    ].forEach(function (side) {
      var burst = document.createElement('div');
      burst.className = 'oc-beacon oc-beacon-transient';
      burst.style.cssText = [
        'position:absolute',
        'left:' + (side[0] + SCROLL_X) + 'px', 'top:' + (side[1] + SCROLL_Y) + 'px', // document space
        'width:' + side[2] + 'px', 'height:' + side[3] + 'px',
        'pointer-events:none',
        'z-index:2147483642',
        'background:#f59e0b', 'clip-path:' + side[7], 'opacity:0', 'transform-origin:' + side[4]
      ].join(';');
      document.documentElement.appendChild(burst);
      var burstAnim = burst.animate([
        { opacity: 0, transform: side[5] },
        { opacity: 0.9, transform: side[6], offset: 0.4 },
        { opacity: 0, transform: side[5] }
      ], { duration: BURST_DUR * durFactor, delay: burstStart * durFactor, easing: 'ease-out', fill: 'forwards' });
      burst.__waapiAnims = [burstAnim];
      burstAnim.finished.then(function () { burst.remove(); }).catch(function () { burst.remove(); });
    });
  }

  // oculist-nq1x.7: promotes fxTentacleRise (artifacts/prototypes/effects-playground.html,
  // the oculist-ke53 tentacles-v2 redraw integrated by oculist-4k8y) into the shipped
  // beacon contract, the sixth entry in the Halloween pack. Two tentacles rise from a
  // hidden waterline just below the match's own line, curl their tips inward like a pair
  // of brackets around the word, a small dark dome with a pair of chartreuse eyes opens
  // beneath it, blinks once, then everything uncurls and sinks back out of sight.
  //
  // TWO REVIEWER-RETRY FINDINGS FROM THE PROTOTYPE'S OWN HISTORY, carried forward
  // unchanged (oculist-8qrc's amendment to this bead corrects the effect-specific notes
  // that originally miscited them as a "below-fallback"):
  // 1. BOTH-OR-NEITHER TENTACLE PAIRING (oculist-1ta.24, defect 1). planTentacle() computes
  //    each side's clamped position and whether it would overlap #match, purely
  //    analytically, before anything mounts; if EITHER side would overlap, BOTH are
  //    suppressed together -- a lone surviving limb reads as Vine Swing, the exact G6
  //    collision this effect must avoid.
  // 2. VIEWPORT-BOTTOM DOME SUPPRESSION (oculist-1ta.24, defect 2). When #match sits
  //    within DOME_H+DOME_MARGIN of the viewport's bottom edge, the dome and eyes are
  //    suppressed entirely rather than mounted off-screen or half-cropped -- the tentacles'
  //    own rise/curl/sink is unaffected and still plays in full; only the eyes beat drops.
  // The REACH_MIN_X/REACH_MAX_X clearance floor (derived from the tentacles-v2 ribbon/
  // shadow/highlight/sucker geometry, not hand-picked) and the MARGIN/STROKE_BULGE/
  // EDGE_ALLOW constants below are oculist-4k8y's and oculist-tlg2's own values, kept
  // exactly as measured -- see their close reasons for the derivation and the exact
  // 11.4px reproducer oculist-tlg2 hardened against.
  //
  // Fixed identity palette (the promotion contract's own license, "the pumpkin's
  // orange"): no neighbouring shipped character effect has set an accessibility-accent
  // precedent that applies here, and (like Pumpkin Glow's shell and Horseman's ink)
  // this effect has no separate flash/accent element to carry getEffectiveColors().beacon.
  //
  // NO START-POINT CASCADE (rule 9 of the promotion contract). Tentacles rise in place,
  // anchored to the match's own left/right edges -- fxTentacleRise never reads
  // lastMouseX/lastMouseY or the find bar's position anywhere in the prototype. This is
  // not the "travels from somewhere to the match" shape rule 9 describes.
  //
  // Lite Mode (rule 7 of the promotion contract): a no-op, the same reasoning Bone
  // Assembly's/Horseman's own header comments give for themselves -- this effect has no
  // filter, no box-shadow, and no glow anywhere in its art; the one blink is the effect's
  // own defining beat, not a decorative flicker. Full mode and Lite Mode render and time
  // identically. settings.performanceMode is deliberately never read below.
  function animateTentacleRise(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;

    var NS = 'http://www.w3.org/2000/svg';
    var vw = window.innerWidth, vh = window.innerHeight;
    var mcx = rect.left + rect.width / 2;

    var TENT = '#2f4a35', TENT_SHADE = '#17231a', TENT_HI = '#4f7256';
    var SUCKER = '#d8c9a3';
    var DOME_COLOR = '#141d17', DOME_SHADE = '#0a0f0b';
    var EYE_COLOR = '#d7f24a';
    var PUPIL = '#0a0f08';
    var STROKE = 'stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke;';

    var beaconScale = getBeaconScale();
    var durFactor = getBeaconDuration(1);

    function svgEl(tag, attrs, parent) {
      var el = document.createElementNS(NS, tag);
      for (var k in attrs) el.setAttribute(k, attrs[k]);
      parent.appendChild(el);
      return el;
    }

    // ── Tentacle authoring grid, canonical drawing curls toward local +x (i.e.
    // rightward). Used as-is for the LEFT tentacle (curling right == curling toward the
    // word); mirrored via CSS scaleX(-1) on the wrapper for the RIGHT tentacle. Verbatim
    // from fxTentacleRise / the tentacles-v2 redraw (oculist-ke53/oculist-4k8y). ──
    var VB_W = 36, VB_H = 72;
    var SPINE_RISE = [[15, 72], [15, 58], [14, 43], [14.5, 28], [16, 14], [18.5, 3]];
    var SPINE_CURL_HALF = [[15, 72], [15, 58], [15.5, 43], [18, 29], [22, 18], [26, 11], [28, 9.5], [28.5, 12]];
    var SPINE_CURL_FULL = [[15, 72], [15, 58], [16, 43], [19, 29], [23, 18], [26.5, 11], [27.8, 7], [27, 4], [23.5, 3], [21, 5]];
    var BASE_W = 12, TIP_W = 4.5;

    function ribbonPoints(spine, baseW, tipW) {
      var n = spine.length;
      var left = [], right = [];
      for (var i = 0; i < n; i++) {
        var w = baseW + (tipW - baseW) * (i / (n - 1));
        var p = spine[i];
        var prev = spine[Math.max(0, i - 1)];
        var next = spine[Math.min(n - 1, i + 1)];
        var dx = next[0] - prev[0], dy = next[1] - prev[1];
        var len = Math.hypot(dx, dy) || 1;
        var nx = -dy / len;
        var ny = dx / len;
        left.push([p[0] + nx * w / 2, p[1] + ny * w / 2]);
        right.push([p[0] - nx * w / 2, p[1] - ny * w / 2]);
      }
      return left.concat(right.reverse());
    }

    function pointString(points) {
      return points.map(function (p) { return p[0].toFixed(2) + ',' + p[1].toFixed(2); }).join(' ');
    }

    // Flat sheet-derived regions -- the ribbon remains the one shared-width silhouette
    // generator; these closed regions supply the broad shadow and highlight masses that
    // distinguish the creature from Vine Swing.
    var POSE_ART = [
      {
        name: 'rise', spine: SPINE_RISE, suckers: [],
        shadow: [[15, 72], [16.2, 58], [16.1, 43], [16.8, 28], [18.3, 14], [20.3, 4.2], [20.7, 5.4], [19.2, 16], [18.7, 29], [18.6, 43], [19.1, 58], [21, 72]],
        highlight: [[10.2, 69], [10.8, 57], [11, 44], [11.7, 31], [13, 18], [15.7, 7], [17, 6], [15.5, 18], [14.3, 31], [13.8, 44], [13.7, 57], [13.5, 69]]
      },
      {
        name: 'half', spine: SPINE_CURL_HALF,
        suckers: [[25.6, 13, 2.1, 3, -35], [21.7, 19.2, 2.1, 3, -35], [18.7, 27.2, 2.1, 3, -22]],
        shadow: [[15, 72], [16.2, 58], [17, 43], [19.3, 30], [23.4, 20], [27, 14], [29.7, 11.4], [29.1, 14], [26, 16.3], [22.6, 22], [20.4, 31], [19.5, 44], [19.2, 58], [21, 72]],
        highlight: [[10.2, 69], [10.8, 57], [11.4, 44], [13.1, 31], [16, 21], [20.4, 13.8], [24.8, 9.5], [26.1, 9.2], [22, 14.4], [18, 22], [15.4, 32], [14, 45], [13.6, 58], [13.5, 69]]
      },
      {
        name: 'full', spine: SPINE_CURL_FULL,
        suckers: [[27.1, 10.2, 2.1, 3, -55], [23.8, 16.8, 2.1, 3, -42], [20.6, 23.5, 2.1, 3, -30], [18.2, 32, 2.1, 3, -15]],
        shadow: [[15, 72], [16.2, 58], [17.6, 43], [20.5, 30], [24.5, 20], [28.1, 14], [30.4, 9], [30.2, 6.6], [28.9, 4.8], [27.6, 5.2], [28.3, 7.4], [27.1, 11.3], [23.4, 18.4], [21.1, 25], [19.5, 32], [19.3, 44], [19.2, 58], [21, 72]],
        highlight: [[10.2, 69], [10.8, 57], [11.8, 44], [14.1, 31], [17.3, 21], [21.5, 13], [25.4, 7.4], [27.3, 5.4], [27.8, 4.8], [25.3, 5.6], [21.1, 11], [17.3, 19], [14.8, 30], [13.8, 44], [13.6, 58], [13.5, 69]]
      }
    ];

    POSE_ART.forEach(function (art) {
      art.body = ribbonPoints(art.spine, BASE_W, TIP_W);
    });

    var PAINT_X = (function () {
      var xs = [];
      POSE_ART.forEach(function (art) {
        art.body.concat(art.shadow, art.highlight).forEach(function (p) { xs.push(p[0]); });
        art.suckers.forEach(function (s) {
          var a = s[4] * Math.PI / 180;
          var xr = Math.hypot(s[2] * Math.cos(a), s[3] * Math.sin(a));
          xs.push(s[0] - xr, s[0] + xr);
        });
      });
      return { min: Math.min.apply(null, xs), max: Math.max.apply(null, xs) };
    })();
    var REACH_MIN_X = PAINT_X.min;
    var REACH_MAX_X = PAINT_X.max;

    function buildTentacleSvg(figWidth, figHeight) {
      var svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('width', String(figWidth));
      svg.setAttribute('height', String(figHeight));
      svg.setAttribute('viewBox', '0 0 ' + VB_W + ' ' + VB_H);
      svg.setAttribute('data-tr-art', '');
      svg.style.cssText = 'display:block;overflow:visible;';

      function pose(art) {
        var g = document.createElementNS(NS, 'g');
        g.setAttribute('data-tr-pose', art.name);
        svgEl('polygon', {
          points: pointString(art.body), fill: TENT, stroke: DOME_SHADE,
          'stroke-width': '1.4', style: STROKE, 'data-tr-body': ''
        }, g);
        svgEl('polygon', { points: pointString(art.shadow), fill: TENT_SHADE, 'data-tr-layer': 'shadow' }, g);
        svgEl('polygon', { points: pointString(art.highlight), fill: TENT_HI, 'data-tr-layer': 'highlight' }, g);
        art.suckers.forEach(function (s) {
          var sucker = svgEl('g', {
            transform: 'rotate(' + s[4] + ' ' + s[0] + ' ' + s[1] + ')', 'data-tr-sucker': ''
          }, g);
          svgEl('ellipse', {
            cx: s[0], cy: s[1], rx: s[2], ry: s[3], fill: SUCKER,
            stroke: DOME_SHADE, 'stroke-width': '0.5', style: STROKE
          }, sucker);
        });
        svg.appendChild(g);
        return g;
      }

      var poseRise = pose(POSE_ART[0]);
      var poseHalf = pose(POSE_ART[1]);
      var poseFull = pose(POSE_ART[2]);
      poseHalf.style.opacity = '0';
      poseFull.style.opacity = '0';

      return { svg: svg, poseRise: poseRise, poseHalf: poseHalf, poseFull: poseFull };
    }

    // Real screen-space clearance floor between the tentacle's own painted edge (including
    // its 1.4px non-scaling stroke) and #match's own rect -- oculist-4k8y's/oculist-tlg2's
    // own measured values, kept exactly. These stay FIXED screen-px constants, unaffected
    // by beaconScale below: the ribbon's stroke is vector-effect:non-scaling-stroke, a
    // constant on-screen width regardless of the SVG's own internal scale.
    var MARGIN = 2;
    var STROKE_BULGE = 0.7; // half the 1.4px non-scaling ribbon stroke
    var EDGE_ALLOW = 20;
    // beaconScale (rule 6) scales the whole creature's on-screen size -- applied to
    // figHeight, the one root value scale/figWidth/DOME_W/DOME_H all derive from, before
    // any placement math below is computed from it (the same "scale before computing
    // placement" discipline animateHorseman's own SPRITE_H comment describes).
    var figHeight = Math.max(46, Math.min(72, 2.1 * rect.height)) * beaconScale;
    var scale = figHeight / VB_H;
    var figWidth = VB_W * scale;

    // Dome + eyes scale with beaconScale too, so the creature stays proportioned at every
    // Beacon Size; DOME_MARGIN is a fixed screen-px clearance buffer (like MARGIN above),
    // not an art dimension, so it stays unscaled.
    var DOME_W = 34 * beaconScale, DOME_H = 18 * beaconScale;
    var DOME_MARGIN = 4;
    var domeVisible = (rect.bottom + DOME_H + DOME_MARGIN) <= vh;
    var waterlineY = Math.min(rect.bottom + DOME_H, vh);

    // ── Shared static clip: one absolute, full-viewport wrapper anchored at the current
    // viewport's own document-space origin (rule 2 of the promotion contract -- position:
    // absolute + window.scrollX/scrollY, not the prototype's position:fixed), clipped to a
    // plain rectangle from the viewport's top down to the waterline. Every child below is
    // positioned in THIS element's own local coordinate space, which starts at the
    // viewport's top-left exactly like the prototype's fixed-position math did -- so every
    // viewport-space offset below (clampedLeft, wrapTop, domeLeft, rect.bottom) ports
    // unchanged; only this one wrapper's own left/top carry the scroll offset. This also
    // means an EDGE_ALLOW bleed past the physical viewport edge is absorbed by this same
    // clip-path (its own polygon already excludes x<0 or x>vw), exactly as "free real
    // estate" as it was under position:fixed's own viewport clipping.
    var riseWrap = document.createElement('div');
    riseWrap.className = 'oc-beacon oc-beacon-transient';
    riseWrap.setAttribute('data-tentaclerise', '');
    riseWrap.style.cssText = [
      'position:absolute',
      'left:' + window.scrollX + 'px', 'top:' + window.scrollY + 'px',
      'width:' + vw + 'px', 'height:' + vh + 'px',
      'pointer-events:none',
      'z-index:2147483642',
      'clip-path:polygon(0px 0px, ' + vw + 'px 0px, ' + vw + 'px ' + waterlineY + 'px, 0px ' + waterlineY + 'px)'
    ].join(';');
    document.documentElement.appendChild(riseWrap);

    // Every WAAPI animation this beacon creates -- including on the tentacle/dome/eye child
    // nodes below -- is collected here and hung off riseWrap (the element cancelBeacons()
    // actually selects), the same trackOuter()/track() idiom animateHorseman's/
    // animateJackOLantern's own header comments describe (rule 4/5 of the promotion
    // contract).
    var anims = [];
    function track(a) { anims.push(a); return a; }

    // ── Timeline (ms) -- durFactor (rule 6) multiplies every duration/delay directly, so
    // relative timing is preserved exactly; every boundary below is precomputed once,
    // matching animateBoneAssembly's own `raw * durFactor` idiom. ──
    var RISE_DUR = 420 * durFactor;
    var POSE_HOLD = 160 * durFactor;
    var T_POSE_HALF = RISE_DUR;
    var T_POSE_FULL = RISE_DUR + POSE_HOLD;
    var DOME_RISE_START = RISE_DUR;
    var DOME_RISE_DUR = 250 * durFactor;
    var EYES_OPEN_START = DOME_RISE_START + DOME_RISE_DUR;
    var EYES_FADE_DUR = 150 * durFactor;
    var BLINK_START = 980 * durFactor;
    var BLINK_DUR = 260 * durFactor;
    var SINK_START = 1300 * durFactor;
    var SINK_DUR = 380 * durFactor;
    var T_UNCURL_HALF = SINK_START;
    var T_UNCURL_RISE = SINK_START + 140 * durFactor;
    var DOME_SINK_DUR = 300 * durFactor;
    var EYES_CLOSE_DUR = 150 * durFactor;
    var CUT_EPS = 1 * durFactor;

    // Bead reviewer-retry (oculist-1ta.24, defect 1): planTentacle() computes where a limb
    // WOULD land and whether it would overlap #match, without mounting anything -- the
    // caller below builds either both tentacles or neither, only once BOTH plans are known
    // to be safe. "MUST NOT reach past #match" is enforced purely analytically here (near =
    // rect.left - MARGIN / rect.right + MARGIN, exactly, by construction), NOT by the
    // EDGE_ALLOW clamp -- that clamp only trades unpainted off-canvas bleed for on-screen
    // fit, it never narrows the margin below. The overlap check stays as a defensive second
    // line, still real: EDGE_ALLOW is deliberately short of the largest-font edge-placement
    // deficit, so those rows still get clamped past the safe margin and this check is what
    // suppresses them.
    function planTentacle(mirrored) {
      var reachLocal = mirrored ? (VB_W - REACH_MAX_X) : REACH_MAX_X;
      var farLocal = mirrored ? (VB_W - REACH_MIN_X) : REACH_MIN_X;
      var idealLeft = mirrored
        ? (rect.right + MARGIN - reachLocal * scale)
        : (rect.left - MARGIN - reachLocal * scale);
      var clampedLeft = Math.max(-EDGE_ALLOW, Math.min(vw + EDGE_ALLOW - figWidth, idealLeft));
      var near = clampedLeft + Math.min(reachLocal, farLocal) * scale;
      var far = clampedLeft + Math.max(reachLocal, farLocal) * scale;
      return {
        mirrored: mirrored,
        clampedLeft: clampedLeft,
        overlaps: near - STROKE_BULGE < rect.right && far + STROKE_BULGE > rect.left
      };
    }

    function buildTentacle(plan) {
      var mirrored = plan.mirrored, clampedLeft = plan.clampedLeft;
      var wrapTop = waterlineY - figHeight;
      var built = buildTentacleSvg(figWidth, figHeight);
      var wrap = document.createElement('div');
      wrap.setAttribute('data-tr-tentacle', mirrored ? 'right' : 'left');
      var mirrorPrefix = mirrored ? 'scaleX(-1) ' : '';
      wrap.style.cssText = [
        'position:absolute',
        'left:' + clampedLeft + 'px', 'top:' + wrapTop + 'px',
        'width:' + figWidth + 'px', 'height:' + figHeight + 'px',
        'transform:' + mirrorPrefix + 'translateY(' + figHeight + 'px)'
      ].join(';');
      wrap.appendChild(built.svg);
      riseWrap.appendChild(wrap);

      track(wrap.animate([
        { transform: mirrorPrefix + 'translateY(' + figHeight + 'px)' },
        { transform: mirrorPrefix + 'translateY(0px)' }
      ], { duration: RISE_DUR, easing: 'ease-out', fill: 'forwards' }));
      track(wrap.animate([
        { transform: mirrorPrefix + 'translateY(0px)' },
        { transform: mirrorPrefix + 'translateY(' + figHeight + 'px)' }
      ], { duration: SINK_DUR, delay: SINK_START, easing: 'ease-in', fill: 'forwards' }));

      function hardCut(el, toVisible, delay) {
        track(el.animate([{ opacity: toVisible ? 0 : 1 }, { opacity: toVisible ? 1 : 0 }],
          { duration: CUT_EPS, delay: delay, fill: 'forwards' }));
      }
      hardCut(built.poseRise, false, T_POSE_HALF - CUT_EPS);
      hardCut(built.poseHalf, true, T_POSE_HALF - CUT_EPS);
      hardCut(built.poseHalf, false, T_POSE_FULL - CUT_EPS);
      hardCut(built.poseFull, true, T_POSE_FULL - CUT_EPS);
      // Sink beat uncurls back through the same poses in reverse.
      hardCut(built.poseFull, false, T_UNCURL_HALF - CUT_EPS);
      hardCut(built.poseHalf, true, T_UNCURL_HALF - CUT_EPS);
      hardCut(built.poseHalf, false, T_UNCURL_RISE - CUT_EPS);
      hardCut(built.poseRise, true, T_UNCURL_RISE - CUT_EPS);
    }

    // Bead reviewer-retry (defect 1): the bracketing PAIR is what reads as a creature
    // rather than Vine Swing's own single curving stroke -- a lone surviving limb is worse
    // than none. Plan both sides first; only mount either once neither would overlap
    // #match, so it is always both tentacles or neither, never one.
    var planLeft = planTentacle(false);
    var planRight = planTentacle(true);
    if (!planLeft.overlaps && !planRight.overlaps) {
      buildTentacle(planLeft);  // left tentacle, canonical (unmirrored) orientation
      buildTentacle(planRight); // right tentacle, mirrored
    }

    // ── Dome + eyes ──────────────────────────────────────────────────────────────────────
    // Bead reviewer-retry (defect 2): see domeVisible's own comment above -- skipped
    // entirely rather than mounted off-screen/half-cropped when #match sits within
    // DOME_H+DOME_MARGIN of the viewport's bottom edge.
    if (domeVisible) {
      var domeLeft = Math.max(4, Math.min(vw - 4 - DOME_W, mcx - DOME_W / 2));
      var domeWrap = document.createElement('div');
      domeWrap.setAttribute('data-tr-dome-wrap', '');
      domeWrap.style.cssText = [
        'position:absolute',
        'left:' + domeLeft + 'px', 'top:' + rect.bottom + 'px',
        'width:' + DOME_W + 'px', 'height:' + DOME_H + 'px',
        'transform:translateY(' + DOME_H + 'px)'
      ].join(';');
      riseWrap.appendChild(domeWrap);

      var domeSvg = document.createElementNS(NS, 'svg');
      domeSvg.setAttribute('width', String(DOME_W));
      domeSvg.setAttribute('height', String(DOME_H));
      domeSvg.setAttribute('viewBox', '0 0 34 18');
      domeSvg.setAttribute('data-tr-dome', '');
      domeSvg.style.cssText = 'display:block;overflow:visible;';
      domeWrap.appendChild(domeSvg);

      svgEl('path', {
        d: 'M0.7 17.3 Q2.5 3 17 3 Q31.5 3 33.3 17.3 Z', fill: DOME_COLOR,
        stroke: DOME_SHADE, 'stroke-width': '1.4', style: STROKE
      }, domeSvg);
      svgEl('path', { d: 'M17 17.3 Q20 5 31.5 12 Q32.8 14 33.3 17.3 Z', fill: DOME_SHADE }, domeSvg);

      var eyeGroup = document.createElementNS(NS, 'g');
      eyeGroup.setAttribute('data-tr-eyes', '');
      eyeGroup.style.cssText = 'transform-box:fill-box;transform-origin:50% 50%;opacity:0;';
      domeSvg.appendChild(eyeGroup);
      [10, 24].forEach(function (cx) {
        var eye = svgEl('g', { 'data-tr-eye': '' }, eyeGroup);
        svgEl('ellipse', { cx: String(cx), cy: '11', rx: '5.5', ry: '6', fill: EYE_COLOR }, eye);
        svgEl('ellipse', { cx: String(cx), cy: '11', rx: '1.2', ry: '3.2', fill: PUPIL }, eyeGroup);
        svgEl('circle', { cx: String(cx - 2), cy: '8', r: '1.2', fill: '#ffffff' }, eye);
      });

      track(domeWrap.animate([
        { transform: 'translateY(' + DOME_H + 'px)' },
        { transform: 'translateY(0px)' }
      ], { duration: DOME_RISE_DUR, delay: DOME_RISE_START, easing: 'ease-out', fill: 'forwards' }));
      track(domeWrap.animate([
        { transform: 'translateY(0px)' },
        { transform: 'translateY(' + DOME_H + 'px)' }
      ], { duration: DOME_SINK_DUR, delay: SINK_START, easing: 'ease-in', fill: 'forwards' }));

      track(eyeGroup.animate([{ opacity: 0 }, { opacity: 1 }],
        { duration: EYES_FADE_DUR, delay: EYES_OPEN_START, fill: 'forwards' }));
      // One slow blink during the hold -- a squash on the eye group itself (transform
      // only), not a second eyelid shape.
      track(eyeGroup.animate([
        { transform: 'scaleY(1)', offset: 0 },
        { transform: 'scaleY(0.08)', offset: 0.5 },
        { transform: 'scaleY(1)', offset: 1 }
      ], { duration: BLINK_DUR, delay: BLINK_START, easing: 'ease-in-out', fill: 'forwards' }));
      track(eyeGroup.animate([{ opacity: 1 }, { opacity: 0 }],
        { duration: EYES_CLOSE_DUR, delay: SINK_START, fill: 'forwards' }));
    }

    riseWrap.__waapiAnims = anims;

    // Natural completion removes riseWrap only once EVERY animation has settled (rule 5).
    // destroyBeacon() still removes riseWrap synchronously on cancel, cancelling every
    // entry in __waapiAnims regardless of this promise -- same idiom animateJackOLantern's
    // own removePumpkin() uses. If nothing was mounted (both tentacles suppressed and the
    // dome not visible), anims is empty and this resolves immediately.
    function removeRiseWrap() { riseWrap.remove(); }
    Promise.allSettled(anims.map(function (a) { return a.finished; })).then(removeRiseWrap);
  }

  // oculist-nq1x.8: promotes fxReanimate (artifacts/prototypes/effects-playground.html,
  // the geometry rebuilt by oculist-20qz/oculist-4v2u after oculist-1ta.22's own forearm-
  // legibility fix was superseded) into the shipped beacon contract, the seventh entry in
  // the Halloween pack. A stiff-armed figure lies flanked by two conductor posts, is jolted
  // upright by two brief electrode arcs, opens its eyes, holds, then fades.
  //
  // PLACEMENT: right by default, mirrored to the left ONLY if the right side does not fit,
  // and NEVER above/below -- fxReanimate has only right and left landings, with an
  // explicit never-above/below comment in the prototype (oculist-1ta.22's own close reason
  // independently confirms this). The degenerate case -- neither side fits -- falls back to
  // sideRight rather than suppressing (unlike Tentacle Rise's both-or-neither pairing);
  // carried forward unchanged because it is provably safe, not because it was unexamined:
  // sideRight.x is ALWAYS r.right + GAP + REACH_INWARD and sideLeft.x is ALWAYS
  // r.left - GAP - REACH_INWARD, so REACH_INWARD (the figure's own tightest inward bound,
  // sampled across the actual jerk/overshoot sweep) keeps the near edge exactly GAP px
  // clear of #match by construction regardless of whether the FAR edge (REACH_OUTWARD)
  // fits inside the viewport -- "doesn't fit" only ever means the outward side may bleed
  // past the browser window's own edge, never that the inward side moves toward the match.
  // test/reanimate_effect.test.js exercises this exact extreme-narrow-viewport/wide-match
  // scenario directly rather than assuming the above reasoning without proof.
  //
  // NO START-POINT CASCADE (rule 9 of the promotion contract), the same reasoning
  // animateTentacleRise's own header comment gives for itself: the figure rises in place at
  // its own landing position, anchored to #match's own left/right edge -- fxReanimate never
  // reads lastMouseX/lastMouseY or the find bar's position anywhere in the prototype. This
  // is not the "travels from somewhere to the match" shape rule 9 describes. The effect's
  // own mirrored branch (right-landing vs. left-fallback, LIE's sign flip) is real and is
  // exercised for real by a fixture that forces the left fallback, not merely compiled.
  //
  // G4 FLICKER GATE (WCAG 2.3.1, the photosensitive general flash threshold): the jolt is a
  // luminance change, so this is the one gate this effect can fail. There are exactly TWO
  // opacity pulses in the ENTIRE clip (ARC1 and ARC2 below), never more, and durFactor (rule
  // 6) scales ARC1_DELAY/ARC1_DUR/ARC2_DUR directly and ARC2_DELAY by the same factor floored
  // against a fixed 350ms onset-to-onset minimum (oculist-kkwz), so the pulse COUNT never
  // changes at any Animation Speed the user can pick -- only the wall-clock window they fall
  // inside shrinks or grows (never below the 350ms floor). Two flashes total, anywhere in
  // that window, is under the "no more than three flashes in any one-second period"
  // threshold by construction, at every speed setting, without needing a per-window sampling
  // proof.
  //
  // Fixed identity palette (the promotion contract's own license, "the pumpkin's orange"):
  // no neighbouring shipped character effect has set an accessibility-accent precedent that
  // applies here, and (like Horseman's own burst bands) the electrode arc is the character's
  // own electrical prop, not a UI accent tied to landing on the match -- so
  // getEffectiveColors().beacon is never read below.
  //
  // Lite Mode (rule 7 of the promotion contract) drops the electrode arc's own glow layer
  // (arcGlow, the wider cyan under-stroke the prototype's own comment calls a glow) while
  // keeping the recognizable silhouette and the effect's defining beat: the figure's full
  // lie/jerk/overshoot/settle motion and the arc's white core (arcCore), which alone still
  // carries both jolt pulses. This is the only mode-dependent difference; no box-shadow or
  // filter exists anywhere else in this effect's art.
  function animateReanimate(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;

    var NS = 'http://www.w3.org/2000/svg';
    var mcy = rect.top + rect.height / 2;
    var vw = window.innerWidth;

    var beaconScale = getBeaconScale();
    var durFactor = getBeaconDuration(1);

    var GAP = 10; // match-rect clearance floor, a fixed screen-px margin unaffected by beaconScale (the same MARGIN/STROKE_BULGE discipline animateTentacleRise's own header comment describes) -- see fxArrowShot's STRIKE_GAP note on why this can't be trimmed casually.

    var SKIN = '#aeb8aa', SKIN_OUTLINE = '#28302c', SKIN_HI = '#d8dfd3', SKIN_SHADE = '#68756c';
    var HAIR = '#171a19', HAIR_HI = '#303633';
    var COAT = '#292d36', COAT_OUTLINE = '#0d0f14', COAT_HI = '#444a57', COAT_SHADOW = '#181b22';
    var SHIRT = '#4b4d3d', SHIRT_HI = '#686a54', SHIRT_SHADOW = '#303228';
    var PANTS = '#3b3834', PANTS_HI = '#55504a', PANTS_SHADOW = '#25231f';
    var BOOT = '#24262b', BOOT_HI = '#41444a', BOOT_SHADOW = '#111216';
    // Forearms are their own garment part (a cuff), not the coat body. oculist-1ta.22's own
    // fix separated ARM from COAT by an "ARM ramp at or below COAT's own ramp" palette rule,
    // but that rule was superseded along with the geometry: outer-repo commit 2c78974 (oculist-20qz)
    // re-derived both ARM and COAT from the v2 character sheet, and the current values no
    // longer satisfy it (ARM_HI luminance .0837 > COAT_HI .0681) -- separation at the shipped
    // size now comes from geometry (the arm clears the coat silhouette), not a luminance
    // ordering; see this function's own forearm-legibility test.
    var ARM_BASE = '#343944', ARM_HI = '#4b5260', ARM_SHADOW = '#1d2027';
    var ELECTRODE = '#3a3a3f', ELECTRODE_OUTLINE = '#111114', ELECTRODE_TIP = '#8a8a92';
    var ARC_CORE = '#ffffff', ARC_GLOW = '#7fe8ff';
    var STROKE = 'stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke;';

    function svgEl(tag, attrs, parent) {
      var el = document.createElementNS(NS, tag);
      for (var k in attrs) el.setAttribute(k, attrs[k]);
      parent.appendChild(el);
      return el;
    }

    var VB_W = 70, VB_H = 90;
    // figHeight carries beaconScale (rule 6) BEFORE any placement/clearance math below is
    // derived from it -- the same "scale before computing placement" discipline
    // animateTentacleRise's own figHeight comment describes -- so the figure's own SVG
    // viewBox stretch (VB_W x VB_H mapped onto figWidth x figHeight) grows/shrinks the whole
    // body at once, and every electrode dimension below (scaled by the SAME beaconScale
    // factor, directly, since the electrode's own esvg is a separate 1:1-viewBox SVG rather
    // than sharing the figure's VB_W/VB_H grid) grows with it, so the whole creature -- figure
    // and conductor posts together -- scales as one piece at every Beacon Size.
    var figHeight = Math.max(40, Math.min(60, 2.0 * rect.height)) * beaconScale;
    var figWidth = figHeight * (VB_W / VB_H);

    // Electrode geometry, needed here (before the pivot is chosen) purely for the clearance
    // math -- the actual electrode elements are built further down, once figLeft/figTop are
    // known. Every dimension below is a body-part SIZE (scales with beaconScale, directly,
    // matching animateTentacleRise's own DOME_W/DOME_H precedent); their outline/glow
    // stroke-widths stay the prototype's fixed constants (vector-effect:non-scaling-stroke,
    // the same fixed-thin-outline convention as the figure's own body strokes).
    var postW = 7 * beaconScale, postH = 28 * beaconScale, postGap = 9 * beaconScale;
    var postBaseOverhang = 2 * beaconScale, postNeckW = 2 * beaconScale, terminalR = 3 * beaconScale;
    var ARC_CY_FRAC = 0.32; // dimensionless fraction of figHeight, unaffected by beaconScale
    var terminalCy = 11 * beaconScale;
    var elecHalfW = figWidth / 2 + postGap + terminalR * 2 + postNeckW + postW + postBaseOverhang;
    var elecTopY = -figHeight + figHeight * ARC_CY_FRAC - terminalCy;
    var elecBottomY = elecTopY + postH;

    // Rotation magnitudes (unsigned -- LIE/STEP1/OVERSHOOT below apply the per-side sign).
    // Declared up here because the clearance math needs them before the landing side, and
    // therefore the actual signed angles, are chosen.
    var LIE_MAG = 90, STEP1_MAG = 40, OVERSHOOT_MAG = 8;

    // REACH_OUTWARD: isotropic corner-distance bound (generous, viewport-fit check only).
    var outwardCorners = [
      [figWidth / 2, -figHeight], [-figWidth / 2, -figHeight],
      [elecHalfW, elecTopY], [-elecHalfW, elecTopY],
      [elecHalfW, elecBottomY], [-elecHalfW, elecBottomY]
    ];
    var REACH_OUTWARD = 0;
    outwardCorners.forEach(function (c) {
      REACH_OUTWARD = Math.max(REACH_OUTWARD, Math.sqrt(c[0] * c[0] + c[1] * c[1]));
    });
    REACH_OUTWARD += 2;

    // REACH_INWARD: exact bound for the actual swept angle range, computed in the canonical
    // "as if landing on the right" orientation (inward = negative local x); safe to reuse
    // as-is for a left landing too, since that side's motion is this one mirrored exactly
    // (STEP1/OVERSHOOT/LIE are negated together in the timeline below). Only the figure's
    // own two top corners are checked -- its bottom corners (py=0) trace a strictly smaller
    // |x| than the top corners at every angle in this range.
    var sweepMin = -OVERSHOOT_MAG, sweepMax = LIE_MAG; // covers 0 and STEP1_MAG too
    var topCorners = [[figWidth / 2, -figHeight], [-figWidth / 2, -figHeight]];
    var inwardFig = 0;
    for (var deg = sweepMin; deg <= sweepMax; deg += 1) {
      var rad = deg * Math.PI / 180, cosT = Math.cos(rad), sinT = Math.sin(rad);
      topCorners.forEach(function (c) {
        var x = c[0] * cosT - c[1] * sinT;
        if (-x > inwardFig) inwardFig = -x;
      });
    }
    var REACH_INWARD = Math.max(inwardFig, elecHalfW) + 2; // +2 for the 1deg sampling step and rounding

    var sideRight = { x: rect.right + GAP + REACH_INWARD, side: 'right' };
    sideRight.fits = sideRight.x + REACH_OUTWARD <= vw - 4;
    var sideLeft = { x: rect.left - GAP - REACH_INWARD, side: 'left' };
    sideLeft.fits = sideLeft.x - REACH_OUTWARD >= 4;
    // Right by default; mirror left only if the right side doesn't fit -- never above/below
    // (this effect never covers the word from any angle). The degenerate "neither fits"
    // case falls back to sideRight, which stays match-safe by construction -- see this
    // function's own header comment.
    var landing = sideRight.fits ? sideRight : (sideLeft.fits ? sideLeft : sideRight);

    var pivotX = landing.x, pivotY = mcy;
    var onRight = landing.side === 'right';
    var figLeft = pivotX - figWidth / 2, figTop = pivotY - figHeight;

    // ── Shared static wrapper: one absolute, full-viewport-sized element anchored at the
    // current viewport's own document-space origin (rule 2 of the promotion contract --
    // position:absolute + window.scrollX/scrollY, not the prototype's position:fixed).
    // Every child below is positioned in THIS element's own local coordinate space, which
    // starts at the viewport's top-left exactly like the prototype's fixed-position math
    // did -- so every viewport-space offset below (pivotX/pivotY/figLeft/figTop/elecTopY)
    // ports unchanged; only this one wrapper's own left/top carry the scroll offset. Same
    // idiom as animateTentacleRise's own riseWrap. ──
    var vh = window.innerHeight;
    var reanimateWrap = document.createElement('div');
    reanimateWrap.className = 'oc-beacon oc-beacon-transient';
    reanimateWrap.setAttribute('data-reanimate', '');
    reanimateWrap.style.cssText = [
      'position:absolute',
      'left:' + window.scrollX + 'px', 'top:' + window.scrollY + 'px',
      'width:' + vw + 'px', 'height:' + vh + 'px',
      'pointer-events:none',
      'z-index:2147483642',
      // oculist-mjv1: the degenerate placement fallback can land figLeft/elecLeft past
      // vw (REACH_OUTWARD only guarantees the near/inward edge stays clear of #match, never
      // that the far/outward edge fits inside the viewport). Without this, that overflow
      // grows document.scrollWidth for the effect's whole lifetime and briefly gives the
      // page a horizontal scrollbar. reanimateWrap already has an explicit vw x vh box (not
      // 100%), so overflow:hidden clips the excess without the wrapper itself growing --
      // same idiom animateLightning's/animateElectronCloud's own full-viewport container
      // uses.
      'overflow:hidden'
    ].join(';');
    document.documentElement.appendChild(reanimateWrap);

    // Every WAAPI animation this beacon creates -- including on the electrode/figure/eye
    // child nodes below -- is collected here and hung off reanimateWrap (the element
    // cancelBeacons() actually selects), the same trackOuter()/track() idiom
    // animateTentacleRise's own header comment describes (rule 4/5 of the promotion
    // contract).
    var anims = [];
    function track(a) { anims.push(a); return a; }

    // ── Electrode posts + arc (static fixtures; never rotate) ────────────────────────────
    var boxLeft = pivotX - elecHalfW;
    var boxRight = pivotX + elecHalfW;
    var boxW = boxRight - boxLeft;
    var arcCy = figTop + figHeight * ARC_CY_FRAC; // roughly head/shoulder height
    var boxTop = arcCy - terminalCy;
    var boxH = postH;

    var elecWrap = document.createElement('div');
    elecWrap.setAttribute('data-rj-elecwrap', '');
    elecWrap.style.cssText = 'position:absolute;left:' + boxLeft + 'px;top:' + boxTop + 'px;width:' + boxW + 'px;height:' + boxH + 'px;opacity:0;';
    reanimateWrap.appendChild(elecWrap);

    var esvg = document.createElementNS(NS, 'svg');
    esvg.setAttribute('width', String(boxW));
    esvg.setAttribute('height', String(boxH));
    esvg.setAttribute('viewBox', '0 0 ' + boxW + ' ' + boxH);
    esvg.style.cssText = 'display:block;overflow:visible;';
    elecWrap.appendChild(esvg);

    var leftPostX = postBaseOverhang;
    var rightPostX = boxW - postBaseOverhang - postW;
    var leftTerminalX = leftPostX + postW + postNeckW + terminalR;
    var rightTerminalX = rightPostX - postNeckW - terminalR;
    svgEl('path', { 'data-rj-part': 'post-left', d: 'M ' + leftPostX + ' 2 H ' + (leftPostX + postW) + ' V 23 H ' + (leftPostX + postW + postBaseOverhang) + ' V 28 H 0 V 23 H ' + leftPostX + ' Z', fill: ELECTRODE, stroke: ELECTRODE_OUTLINE, 'stroke-width': '1.5', style: STROKE }, esvg);
    svgEl('path', { 'data-rj-part': 'post-right', d: 'M ' + rightPostX + ' 2 H ' + (rightPostX + postW) + ' V 23 H ' + boxW + ' V 28 H ' + (rightPostX - postBaseOverhang) + ' V 23 H ' + rightPostX + ' Z', fill: ELECTRODE, stroke: ELECTRODE_OUTLINE, 'stroke-width': '1.5', style: STROKE }, esvg);
    svgEl('rect', { x: String(leftPostX + postW), y: String(terminalCy - 2), width: String(postNeckW + terminalR), height: '4', fill: ELECTRODE_TIP, stroke: ELECTRODE_OUTLINE, 'stroke-width': '1' }, esvg);
    svgEl('rect', { x: String(rightTerminalX), y: String(terminalCy - 2), width: String(postNeckW + terminalR), height: '4', fill: ELECTRODE_TIP, stroke: ELECTRODE_OUTLINE, 'stroke-width': '1' }, esvg);
    svgEl('circle', { 'data-rj-part': 'terminal-left', cx: String(leftTerminalX), cy: String(terminalCy), r: String(terminalR), fill: ELECTRODE_TIP, stroke: ELECTRODE_OUTLINE, 'stroke-width': '1' }, esvg);
    svgEl('circle', { 'data-rj-part': 'terminal-right', cx: String(rightTerminalX), cy: String(terminalCy), r: String(terminalR), fill: ELECTRODE_TIP, stroke: ELECTRODE_OUTLINE, 'stroke-width': '1' }, esvg);

    // One fixed five-segment path is painted twice and reused by both pulses.
    var tipL = leftTerminalX + terminalR, tipR = rightTerminalX - terminalR, span = tipR - tipL;
    var arcD = 'M ' + tipL + ' ' + terminalCy +
      ' L ' + (tipL + span * 0.2) + ' ' + (terminalCy - 4) +
      ' L ' + (tipL + span * 0.4) + ' ' + (terminalCy + 3) +
      ' L ' + (tipL + span * 0.6) + ' ' + (terminalCy - 3) +
      ' L ' + (tipL + span * 0.8) + ' ' + (terminalCy + 4) +
      ' L ' + tipR + ' ' + terminalCy;
    // Glow via a wider under-stroke plus a thin white core -- both static shapes, only
    // opacity animates, so there is no filter and no forced re-raster (the same reasoning
    // that cut fxCheshire's teeth glow). Lite Mode (rule 7) drops arcGlow entirely, below.
    var arcCore = svgEl('path', { 'data-rj-part': 'arc-core', d: arcD, fill: 'none', stroke: ARC_CORE, 'stroke-width': '1.4', opacity: '0', style: STROKE }, esvg);
    var arcGlow = null;
    if (!settings.performanceMode) {
      arcGlow = svgEl('path', { 'data-rj-part': 'arc-under', d: arcD, fill: 'none', stroke: ARC_GLOW, 'stroke-width': '4', opacity: '0', style: STROKE }, esvg);
      arcGlow.parentNode.insertBefore(arcGlow, arcCore); // under-stroke paints behind the core
    }

    // ── Figure (rotates upright about its own bottom-center pivot) ───────────────────────
    var figWrap = document.createElement('div');
    figWrap.setAttribute('data-rj-figwrap', '');
    figWrap.setAttribute('data-rj-side', landing.side);
    // Lying angle points AWAY from the match (right side lies rotated +90deg, which CSS's
    // clockwise rotate maps to "up" pointing screen-right; left side is the mirror, -90deg,
    // "up" pointing screen-left) -- an aesthetic choice, not a safety requirement, since
    // REACH above already bounds every direction equally.
    var LIE = onRight ? LIE_MAG : -LIE_MAG;
    var STEP1 = onRight ? STEP1_MAG : -STEP1_MAG;
    var OVERSHOOT = onRight ? -OVERSHOOT_MAG : OVERSHOOT_MAG;
    figWrap.style.cssText = 'position:absolute;left:' + figLeft + 'px;top:' + figTop + 'px;width:' + figWidth + 'px;height:' + figHeight + 'px;opacity:0;transform-origin:50% 100%;transform:rotate(' + LIE + 'deg);';
    reanimateWrap.appendChild(figWrap);

    var figSvg = document.createElementNS(NS, 'svg');
    figSvg.setAttribute('width', String(figWidth));
    figSvg.setAttribute('height', String(figHeight));
    figSvg.setAttribute('viewBox', '0 0 ' + VB_W + ' ' + VB_H);
    figSvg.style.cssText = 'display:block;overflow:visible;';
    figWrap.appendChild(figSvg);

    // Broad hard-edged regions survive the 40px figure-height floor: uneven hair,
    // softened-square head, compact coat, short split legs, oversized boots (oculist-20qz's
    // rebuild of the Reanimation-Jolt-v2 character sheet, integrated by oculist-4v2u).
    svgEl('path', { 'data-rj-part': 'face', d: 'M 21 8 L 26 4 L 44 4 L 50 9 L 49 27 L 43 35 L 27 35 L 21 28 Z', fill: SKIN, stroke: SKIN_OUTLINE, 'stroke-width': '2.2', style: STROKE }, figSvg);
    svgEl('path', { d: 'M 22 10 L 27 6 L 31 6 L 28 31 L 23 27 Z', fill: SKIN_HI }, figSvg);
    svgEl('path', { d: 'M 43 6 L 49 10 L 48 27 L 43 33 L 40 29 Z', fill: SKIN_SHADE }, figSvg);
    svgEl('path', { 'data-rj-part': 'hair', d: 'M 19 15 L 20 7 L 25 8 L 28 2 L 32 5 L 37 1 L 40 4 L 46 2 L 45 6 L 51 7 L 49 15 L 44 12 L 40 14 L 35 11 L 30 14 L 25 11 L 22 17 Z', fill: HAIR, stroke: COAT_OUTLINE, 'stroke-width': '1.5', style: STROKE }, figSvg);
    svgEl('path', { d: 'M 24 8 L 29 4 L 31 7 L 27 11 Z', fill: HAIR_HI }, figSvg);

    // Heavy brows, restrained eyes and mouth. Glints remain independent so the one-shot eye
    // beat can target them without a pose swap.
    svgEl('path', { d: 'M 24 19 L 32 18 L 32 21 L 24 21 Z M 38 18 L 46 19 L 46 21 L 38 21 Z', fill: SKIN_OUTLINE }, figSvg);
    svgEl('path', { d: 'M 26 22 L 31 22 L 30 25 L 26 25 Z M 39 22 L 44 22 L 44 25 L 40 25 Z', fill: '#202522' }, figSvg);
    var glintL = svgEl('circle', { 'data-rj-part': 'eye-left', cx: '29.5', cy: '23', r: '2.4', fill: '#eaffff', opacity: '0' }, figSvg);
    var glintR = svgEl('circle', { 'data-rj-part': 'eye-right', cx: '40.5', cy: '23', r: '2.4', fill: '#eaffff', opacity: '0' }, figSvg);
    svgEl('path', { d: 'M 31 30 L 39 30', fill: 'none', stroke: SKIN_OUTLINE, 'stroke-width': '1.5', style: STROKE }, figSvg);

    // Narrow neck leaves page-colored gaps beside it before the shoulders.
    svgEl('path', { d: 'M 30 34 L 40 34 L 42 43 L 28 43 Z', fill: SKIN, stroke: SKIN_OUTLINE, 'stroke-width': '1.8', style: STROKE }, figSvg);

    // Legs and boots paint behind the coat so their separation is explicit.
    svgEl('path', { 'data-rj-part': 'leg-left', d: 'M 22 63 L 33 63 L 32 82 L 20 82 Z', fill: PANTS_HI, stroke: COAT_OUTLINE, 'stroke-width': '2', style: STROKE }, figSvg);
    svgEl('path', { 'data-rj-part': 'leg-right', d: 'M 37 63 L 48 63 L 50 82 L 38 82 Z', fill: PANTS, stroke: COAT_OUTLINE, 'stroke-width': '2', style: STROKE }, figSvg);
    svgEl('path', { d: 'M 43 64 L 48 64 L 50 82 L 44 82 Z', fill: PANTS_SHADOW }, figSvg);
    svgEl('path', { 'data-rj-part': 'boot-left', d: 'M 19 79 L 32 79 L 34 85 L 33 90 L 14 90 L 14 86 Z', fill: BOOT, stroke: COAT_OUTLINE, 'stroke-width': '2', style: STROKE }, figSvg);
    svgEl('path', { d: 'M 16 82 L 29 82 L 30 85 L 15 86 Z', fill: BOOT_HI }, figSvg);
    svgEl('path', { 'data-rj-part': 'boot-right', d: 'M 38 79 L 51 79 L 56 86 L 56 90 L 37 90 L 36 85 Z', fill: BOOT, stroke: COAT_OUTLINE, 'stroke-width': '2', style: STROKE }, figSvg);
    svgEl('path', { d: 'M 40 82 L 50 82 L 54 86 L 38 85 Z', fill: BOOT_HI }, figSvg);
    svgEl('path', { d: 'M 14 87 L 33 87 L 33 90 L 14 90 Z M 37 87 L 56 87 L 56 90 L 37 90 Z', fill: BOOT_SHADOW }, figSvg);

    // Compact coat with a visible shirt wedge and simple lapels.
    var coatD = 'M 17 45 L 27 40 L 43 40 L 53 45 L 52 70 L 44 73 L 40 65 L 30 65 L 26 73 L 18 70 Z';
    svgEl('path', { 'data-rj-part': 'coat', d: coatD, fill: COAT, stroke: COAT_OUTLINE, 'stroke-width': '2.5', style: STROKE }, figSvg);
    svgEl('path', { d: 'M 18 46 L 27 41 L 30 45 L 26 69 L 19 68 Z', fill: COAT_HI }, figSvg);
    svgEl('path', { d: 'M 43 41 L 52 46 L 51 69 L 44 71 L 40 65 Z', fill: COAT_SHADOW }, figSvg);
    svgEl('path', { d: 'M 29 43 L 35 50 L 41 43 L 40 64 L 30 64 Z', fill: SHIRT, stroke: COAT_OUTLINE, 'stroke-width': '1.4', style: STROKE }, figSvg);
    svgEl('path', { d: 'M 30 45 L 34 50 L 32 63 L 30 63 Z', fill: SHIRT_HI }, figSvg);
    svgEl('path', { d: 'M 24 42 L 34 50 L 29 55 Z M 46 42 L 36 50 L 41 55 Z', fill: COAT_HI, stroke: COAT_OUTLINE, 'stroke-width': '1.2', style: STROKE }, figSvg);

    // Stiff sleeve-bars sit outside the coat silhouette with page-colored negative space
    // along most of their length (oculist-1ta.22's geometry lesson, re-confirmed at the
    // shipped 40px floor by oculist-20qz); compact fists cap the tips.
    svgEl('path', { 'data-rj-part': 'forearm-left', d: 'M 18 47 L 13 45 L 4 31 L 9 28 L 22 42 Z', fill: ARM_BASE, stroke: COAT_OUTLINE, 'stroke-width': '2', style: STROKE }, figSvg);
    svgEl('path', { d: 'M 7 31 L 10 30 L 18 42 L 14 43 Z', fill: ARM_HI }, figSvg);
    svgEl('path', { 'data-rj-part': 'forearm-right', d: 'M 52 47 L 57 45 L 66 31 L 61 28 L 48 42 Z', fill: ARM_BASE, stroke: COAT_OUTLINE, 'stroke-width': '2', style: STROKE }, figSvg);
    svgEl('path', { d: 'M 63 31 L 60 30 L 52 42 L 56 43 Z', fill: ARM_SHADOW }, figSvg);
    svgEl('path', { 'data-rj-part': 'fist-left', d: 'M 1 31 L 3 26 L 7 24 L 11 27 L 11 32 L 7 35 L 3 34 Z', fill: SKIN, stroke: SKIN_OUTLINE, 'stroke-width': '1.5', style: STROKE }, figSvg);
    svgEl('path', { d: 'M 3 27 L 6 25 L 8 27 L 5 30 Z', fill: SKIN_HI }, figSvg);
    svgEl('path', { 'data-rj-part': 'fist-right', d: 'M 69 31 L 67 26 L 63 24 L 59 27 L 59 32 L 63 35 L 67 34 Z', fill: SKIN, stroke: SKIN_OUTLINE, 'stroke-width': '1.5', style: STROKE }, figSvg);
    svgEl('path', { d: 'M 67 27 L 64 25 L 62 27 L 65 30 Z', fill: SKIN_HI }, figSvg);

    // ── Timeline (ms) -- durFactor (rule 6) multiplies every duration/delay directly, so
    // relative timing (and the total flash count, see this function's own header comment)
    // is preserved exactly, matching animateTentacleRise's own `raw * durFactor` idiom, with
    // one exception: ARC2_DELAY is also floored against a fixed 350ms onset spacing (see the
    // comment just above it, oculist-kkwz). ──
    var APPEAR_DUR = 180 * durFactor;
    var DIM = 0.55;
    // Two pulses only, spaced >=350ms apart onset-to-onset -- the photosensitive-flicker
    // gate (WCAG 2.3.1) this function's own header comment calls out by number, and the
    // >=350ms floor oculist-4v2u measured at normal speed. durFactor scales the raw 500ms
    // onset spacing directly (rule 6), which is fine at normal (500ms) and slow (875ms) but
    // undercuts the floor at fast (250ms) -- oculist-kkwz. Math.max floors ONLY the spacing
    // that sets ARC2_DELAY; it is a no-op at durFactor >= 0.7 (500 * durFactor >= 350), so
    // normal/slow are byte-for-byte unchanged, and at fast it pushes ARC2_DELAY (and every
    // delay downstream of it: JERK_DELAY/EYES_DELAY/FADE_DELAY/DUR) later by exactly the
    // 100ms the floor requires, rather than rescaling the whole clip.
    var ARC1_DELAY = 400 * durFactor, ARC1_DUR = 140 * durFactor;
    var ARC2_DELAY = ARC1_DELAY + Math.max(500 * durFactor, 350), ARC2_DUR = 140 * durFactor;
    var JERK_DELAY = ARC2_DELAY + ARC2_DUR + 150 * durFactor;
    var JERK_DUR = 320 * durFactor;
    var EYES_DELAY = JERK_DELAY + JERK_DUR - 60 * durFactor;
    var EYES_DUR = 150 * durFactor;
    var HOLD_AFTER = 520 * durFactor;
    var FADE_DELAY = JERK_DELAY + JERK_DUR + HOLD_AFTER;
    var FADE_DUR = 300 * durFactor;
    var DUR = FADE_DELAY + FADE_DUR;

    // Electrodes: fade in with the scene, pulse twice, fade out at the end.
    track(elecWrap.animate([
      { opacity: 0 }, { opacity: 1 }
    ], { duration: APPEAR_DUR, easing: 'ease-out', fill: 'forwards' }));
    [arcCore].concat(arcGlow ? [arcGlow] : []).forEach(function (el) {
      track(el.animate([
        { opacity: 0, offset: 0 },
        { opacity: 1, offset: 0.5 },
        { opacity: 0, offset: 1 }
      ], { duration: ARC1_DUR, delay: ARC1_DELAY, fill: 'forwards' }));
      track(el.animate([
        { opacity: 0, offset: 0 },
        { opacity: 1, offset: 0.5 },
        { opacity: 0, offset: 1 }
      ], { duration: ARC2_DUR, delay: ARC2_DELAY, fill: 'forwards' }));
    });
    track(elecWrap.animate([
      { opacity: 1 }, { opacity: 0 }
    ], { duration: FADE_DUR, delay: FADE_DELAY, easing: 'ease-in', fill: 'forwards' }));

    // Figure: dim appear -> hold lying -> jerks upright (rotation) while brightening -> eyes
    // open -> held settled pose -> fade out.
    track(figWrap.animate([
      { opacity: 0 }, { opacity: DIM }
    ], { duration: APPEAR_DUR, easing: 'ease-out', fill: 'forwards' }));
    track(figWrap.animate([
      { transform: 'rotate(' + LIE + 'deg)', offset: 0 },
      { transform: 'rotate(' + STEP1 + 'deg)', offset: 0.35 },
      { transform: 'rotate(' + OVERSHOOT + 'deg)', offset: 0.65 },
      { transform: 'rotate(0deg)', offset: 1 }
    ], { duration: JERK_DUR, delay: JERK_DELAY, fill: 'forwards' }));
    track(figWrap.animate([
      { opacity: DIM }, { opacity: 1 }
    ], { duration: JERK_DUR, delay: JERK_DELAY, fill: 'forwards' }));
    [glintL, glintR].forEach(function (el) {
      track(el.animate([
        { opacity: 0 }, { opacity: 1 }
      ], { duration: EYES_DUR, delay: EYES_DELAY, fill: 'forwards' }));
    });
    track(figWrap.animate([
      { opacity: 1 }, { opacity: 0 }
    ], { duration: FADE_DUR, delay: FADE_DELAY, easing: 'ease-in', fill: 'forwards' }));

    reanimateWrap.__waapiAnims = anims;

    // Natural completion removes reanimateWrap only once EVERY animation has settled (rule
    // 5). destroyBeacon() still removes reanimateWrap synchronously on cancel, cancelling
    // every entry in __waapiAnims regardless of this promise -- same idiom
    // animateTentacleRise's own removeRiseWrap() uses.
    function removeReanimateWrap() { reanimateWrap.remove(); }
    Promise.allSettled(anims.map(function (a) { return a.finished; })).then(removeReanimateWrap);
  }

  // oculist-nq1x.9: promotes fxBatFlight (artifacts/prototypes/effects-playground.html) into
  // the shipped beacon contract, the eighth entry in the Halloween pack. A bat flies in along
  // an erratic weave, vanishes into a rising mist column, and a cloaked head-and-shoulders
  // figure fades in beside the match (or, when neither side fits, above it, or -- last
  // resort -- below it, never over it). Never a whole body: a full human figure is the
  // tallest thing in this epic, and oculist-1ta.1's own close reason records the same "head
  // with no body" cut the Cheshire cat took for the same reason.
  //
  // RULE 9 EXCEPTION (oculist-i8zu, decided 2026-09-23): the shipped lastMouseX/find-bar/
  // viewport start-point cascade animateTrail uses is deliberately NOT used here. The bat's
  // start point stays pinned to the chosen landing side -- on-screen, 4-40px inside that
  // side's own viewport edge for a left/right landing, or endX with endY +/- 220 for an
  // above/below landing (effects-playground.html:4134-4137, :4150-4152) -- because the
  // flight's whole x-range has to stay on the landing side for the WHOLE flight, not just at
  // arrival (effects-playground.html:3880-3881, :4129-4132): a cursor or find-bar start could
  // put the launch point on the wrong side of the match, or directly above/below it, and walk
  // the flight path across the match mid-transit, which rule 10 forbids. Rule 9's other half
  // -- the mirrored branch must work for real, not just compile -- still applies and is
  // tested below (the left-fallback test).
  //
  // Fixed identity palette (rule 6's own license, "the pumpkin's orange"): BAT_* and the
  // figure's CAPE/SKIN/HAIR/IRIS tones are fixed, like Skeleton Trot's ivory or Galloping
  // Throw's amber -- there is no separate flash/UI-accent element here for
  // getEffectiveColors().beacon to drive (same reasoning animateHorseman's own header gives
  // for itself).
  //
  // Lite Mode (rule 7): a no-op. There is no filter, no box-shadow and no decorative glow
  // layer anywhere in this effect to cut -- the cel-shaded tones ARE the character art
  // (oculist-1ta.10's own redesign; dropping them would reintroduce the "reads as a cut-out"
  // regression it fixed), the mist column IS the transformation (oculist-1ta.1's own
  // "payoff, not decoration"), and the wing flap is the one flicker this effect has, which
  // rule 7 explicitly keeps as "the effect's defining beat". Same reasoning
  // animateHorseman's/animateBoneAssembly's own header comments give for themselves.
  // settings.performanceMode is deliberately never read below.
  //
  // oculist-1ta.8's mist fade-anchor fix (transform-origin flips to 50% 0% ONLY for the
  // 'below' landing, so the fade-out's scaleY(1.25) overshoot grows away from the match
  // instead of tinting it) and oculist-1ta.14's mouth/hair-outline fixes are ported
  // byte-for-byte, not redrawn.
  function animateBatFlight(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;

    var NS = 'http://www.w3.org/2000/svg';
    var vw = window.innerWidth, vh = window.innerHeight;
    var mcx = rect.left + rect.width / 2, mcy = rect.top + rect.height / 2; // viewport space (rule 2)

    var beaconScale = getBeaconScale();
    var durFactor = getBeaconDuration(1);

    // Fixed screen-px clearance margins, unaffected by beaconScale -- same discipline
    // animateReanimate's own GAP comment describes for itself.
    var INSET = 40;
    var GAP = 10;

    var BAT_OUTLINE = '#0a0612';
    var BAT_BASE = '#3a2b52';
    var BAT_SHADOW = '#20172f';
    var BAT_HIGHLIGHT = '#6b5786';
    var BAT_STROKE = 'stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke;';

    var BAT_VB_W = 120, BAT_VB_H = 70;
    var BAT_ASPECT = BAT_VB_W / BAT_VB_H;
    var BAT_W = 90 * beaconScale, BAT_H = BAT_W / BAT_ASPECT;
    var BODY_CX = 60, BODY_CY = 40, BODY_RX = 12, BODY_RY = 10;

    // Wing membrane outlines -- angular, swept-back silhouette (oculist-1ta.10's own retry,
    // ported verbatim: a soft symmetric fan read as a bowtie/moth at production size).
    var WING_OUT_L = 'M 48 34 L 6 20 L 18 30 L 10 38 L 20 42 L 16 48 L 48 46 Z';
    var WING_OUT_R = 'M 72 34 L 114 20 L 102 30 L 110 38 L 100 42 L 104 48 L 72 46 Z';
    var WING_TUCKED_L = 'M 48 36 L 38 30 L 40 36 L 34 40 L 40 44 L 48 44 Z';
    var WING_TUCKED_R = 'M 72 36 L 82 30 L 80 36 L 86 40 L 80 44 L 72 44 Z';

    var EAR_L = '42,32 38,16 50,30', EAR_L_D = 'M 42 32 L 38 16 L 50 30 Z';
    var EAR_R = '78,32 82,16 70,30', EAR_R_D = 'M 78 32 L 82 16 L 70 30 Z';

    var OUT_PATCH = {
      lHi: { cx: 21, cy: 30, rx: 8, ry: 7 }, lSh: { cx: 33, cy: 38, rx: 8, ry: 6 },
      rHi: { cx: 87, cy: 30, rx: 8, ry: 7 }, rSh: { cx: 99, cy: 38, rx: 8, ry: 6 }
    };
    var TUCKED_PATCH = {
      lHi: { cx: 39, cy: 34, rx: 4, ry: 4 }, lSh: { cx: 43, cy: 40, rx: 4, ry: 4 },
      rHi: { cx: 77, cy: 34, rx: 4, ry: 4 }, rSh: { cx: 81, cy: 40, rx: 4, ry: 4 }
    };

    // Fixed id prefix, not per-invocation unique -- animate() always cancels and removes the
    // previous beacon before mounting a new one, so two live copies of this effect's own ids
    // never coexist (same reasoning the prototype's own uid comment gives).
    var uid = 'bf_';

    var batDefs = document.createElementNS(NS, 'defs');
    var bodyClipId = uid + 'body';
    var bodyClip = document.createElementNS(NS, 'clipPath');
    bodyClip.setAttribute('id', bodyClipId);
    var bodyClipShape = document.createElementNS(NS, 'ellipse');
    bodyClipShape.setAttribute('cx', String(BODY_CX));
    bodyClipShape.setAttribute('cy', String(BODY_CY));
    bodyClipShape.setAttribute('rx', String(BODY_RX));
    bodyClipShape.setAttribute('ry', String(BODY_RY));
    bodyClip.appendChild(bodyClipShape);
    batDefs.appendChild(bodyClip);

    // Builds one cel-shaded frame: each wing/ear gets a base tone plus its own highlight AND
    // shadow patch (three discrete tones), then the body. Every shape carries a BAT_OUTLINE
    // stroke darker than its fill (rule: a defining outline on every solid form).
    function buildBatFrame(leftWingD, rightWingD, patch, idSuffix) {
      var g = document.createElementNS(NS, 'g');

      function shape(tag, attrs, parent) {
        var el = document.createElementNS(NS, tag);
        for (var k in attrs) el.setAttribute(k, attrs[k]);
        (parent || g).appendChild(el);
        return el;
      }

      function clipFor(id, d) {
        var clip = document.createElementNS(NS, 'clipPath');
        clip.setAttribute('id', id);
        shape('path', { d: d }, clip);
        batDefs.appendChild(clip);
        return id;
      }

      var leftClipId = clipFor(uid + 'wl' + idSuffix, leftWingD);
      var rightClipId = clipFor(uid + 'wr' + idSuffix, rightWingD);
      var earLClipId = clipFor(uid + 'el' + idSuffix, EAR_L_D);
      var earRClipId = clipFor(uid + 'er' + idSuffix, EAR_R_D);

      shape('path', { d: leftWingD, fill: BAT_BASE, stroke: BAT_OUTLINE, 'stroke-width': '2.5', style: BAT_STROKE });
      shape('path', { d: rightWingD, fill: BAT_BASE, stroke: BAT_OUTLINE, 'stroke-width': '2.5', style: BAT_STROKE });
      shape('ellipse', { cx: patch.lHi.cx, cy: patch.lHi.cy, rx: patch.lHi.rx, ry: patch.lHi.ry, fill: BAT_HIGHLIGHT, 'clip-path': 'url(#' + leftClipId + ')' });
      shape('ellipse', { cx: patch.lSh.cx, cy: patch.lSh.cy, rx: patch.lSh.rx, ry: patch.lSh.ry, fill: BAT_SHADOW, 'clip-path': 'url(#' + leftClipId + ')' });
      shape('ellipse', { cx: patch.rHi.cx, cy: patch.rHi.cy, rx: patch.rHi.rx, ry: patch.rHi.ry, fill: BAT_HIGHLIGHT, 'clip-path': 'url(#' + rightClipId + ')' });
      shape('ellipse', { cx: patch.rSh.cx, cy: patch.rSh.cy, rx: patch.rSh.rx, ry: patch.rSh.ry, fill: BAT_SHADOW, 'clip-path': 'url(#' + rightClipId + ')' });

      shape('polygon', { points: EAR_L, fill: BAT_BASE, stroke: BAT_OUTLINE, 'stroke-width': '2', style: BAT_STROKE });
      shape('polygon', { points: EAR_R, fill: BAT_BASE, stroke: BAT_OUTLINE, 'stroke-width': '2', style: BAT_STROKE });
      shape('ellipse', { cx: '42', cy: '22', rx: '4', ry: '5', fill: BAT_HIGHLIGHT, 'clip-path': 'url(#' + earLClipId + ')' });
      shape('ellipse', { cx: '46', cy: '26', rx: '4', ry: '5', fill: BAT_SHADOW, 'clip-path': 'url(#' + earLClipId + ')' });
      shape('ellipse', { cx: '74', cy: '22', rx: '4', ry: '5', fill: BAT_HIGHLIGHT, 'clip-path': 'url(#' + earRClipId + ')' });
      shape('ellipse', { cx: '78', cy: '26', rx: '4', ry: '5', fill: BAT_SHADOW, 'clip-path': 'url(#' + earRClipId + ')' });

      shape('ellipse', { cx: String(BODY_CX), cy: String(BODY_CY), rx: String(BODY_RX), ry: String(BODY_RY), fill: BAT_BASE, stroke: BAT_OUTLINE, 'stroke-width': '2.5', style: BAT_STROKE });
      shape('ellipse', { cx: '56', cy: '37', rx: '5', ry: '4', fill: BAT_HIGHLIGHT, 'clip-path': 'url(#' + bodyClipId + ')' });
      shape('ellipse', { cx: '64', cy: '43', rx: '6', ry: '4', fill: BAT_SHADOW, 'clip-path': 'url(#' + bodyClipId + ')' });

      shape('circle', { cx: '54', cy: '37', r: '2.2', fill: '#0d0d0f' });
      shape('circle', { cx: '66', cy: '37', r: '2.2', fill: '#0d0d0f' });
      shape('circle', { cx: '53.3', cy: '36.3', r: '1.4', fill: '#ffffff' });
      shape('circle', { cx: '65.3', cy: '36.3', r: '1.4', fill: '#ffffff' });

      return g;
    }

    var FIG_VB_W = 90, FIG_VB_H = 110;
    var FIG_ASPECT = FIG_VB_W / FIG_VB_H;
    var CAPE = '#3b0764', CAPE_OUTLINE = '#150826';
    var CAPE_HI = '#7c3aed', CAPE_SHADE = '#26043f';
    var SKIN = '#e9ded2', SKIN_OUTLINE = '#2b1a12';
    var SKIN_HI = '#fff8ee', SKIN_SHADE = '#a3856a';
    var HAIR = '#0d0d0f';
    var IRIS = '#7c3aed'; // ties the eye color to the cape's own highlight tone
    var NOSE = '#f472b6';

    var figHeight = Math.max(56, Math.min(100, 3.0 * rect.height)) * beaconScale;
    var figWidth = figHeight * FIG_ASPECT;

    // Landing position: beside the match (right, then left), falling back to above it, then
    // (last resort) below -- never over it. Every candidate side is tried UNCLAMPED and only
    // used if its full box (padded by GAP) already fits on screen without touching the match
    // -- a post-hoc clamp is what oculist-1ta.1 fixed (clamping a beside-position back inside
    // the viewport could drag it onto the match itself near an edge).
    var MIST_PAD = 10;
    var CLEAR_HALF_X = Math.max(figWidth / 2 + MIST_PAD, BAT_W / 2);
    var CLEAR_HALF_Y = figHeight / 2 + MIST_PAD;

    var sideRight = { x: rect.right + GAP + CLEAR_HALF_X, y: mcy, side: 'right' };
    sideRight.fits = sideRight.x + CLEAR_HALF_X <= vw - 4;
    var sideLeft = { x: rect.left - GAP - CLEAR_HALF_X, y: mcy, side: 'left' };
    sideLeft.fits = sideLeft.x - CLEAR_HALF_X >= 4;

    var vCenterX = Math.max(CLEAR_HALF_X + 4, Math.min(vw - CLEAR_HALF_X - 4, mcx));
    var above = { x: vCenterX, y: rect.top - GAP - CLEAR_HALF_Y, side: 'above' };
    above.fits = above.y - CLEAR_HALF_Y >= 4;
    var below = { x: vCenterX, y: rect.bottom + GAP + CLEAR_HALF_Y, side: 'below' };
    below.fits = below.y + CLEAR_HALF_Y <= vh - 4;

    var useRight = mcx >= vw / 2;
    var preferredSide = useRight ? sideRight : sideLeft;
    var secondarySide = useRight ? sideLeft : sideRight;
    // above.fits is checked before below.fits: beside-or-above, never over the match; below
    // is a last resort kept only so a landing position always exists.
    var landing = preferredSide.fits ? preferredSide
      : secondarySide.fits ? secondarySide
      : above.fits ? above
      : below;

    var endX = landing.x, endY = landing.y; // viewport space
    var startX, startY, dx, dy; // viewport space

    if (landing.side === 'right' || landing.side === 'left') {
      // Approach from the same side as the landing side, so the bat's x stays on that side
      // of the match for the WHOLE flight (linear interpolation of two same-side values
      // never crosses to the other side) -- not just at the final rest position.
      var onRight = landing.side === 'right';
      startX = onRight
        ? Math.min(vw - 4, Math.max(vw - INSET, rect.right + GAP + BAT_W / 2))
        : Math.max(4, Math.min(INSET, rect.left - GAP - BAT_W / 2));
      startY = Math.max(INSET, mcy - 130);
      dx = endX - startX;
      if (Math.abs(dx) < 80) {
        // Degenerate case: the chosen edge is too close to read as a flight. Push the
        // launch point further out on the same side (away from the match, which only ever
        // increases clearance).
        startX = onRight ? Math.min(vw - 4, endX + 140) : Math.max(4, endX - 140);
        dx = endX - startX;
      }
      dy = endY - startY;
    } else {
      // Above/below fallback: approach vertically, converging on endX so the weave (applied
      // to y below) can't walk the bat sideways into the match while it is still well clear
      // vertically.
      startX = endX;
      var onAbove = landing.side === 'above';
      startY = onAbove ? Math.max(4, endY - 220) : Math.min(vh - 4, endY + 220);
      dy = endY - startY;
      if (Math.abs(dy) < 80) {
        startY = onAbove ? Math.max(4, endY - 140) : Math.min(vh - 4, endY + 140);
        dy = endY - startY;
      }
      dx = endX - startX;
    }

    // Erratic, non-parabolic approach: two summed sine weaves, damped toward 0 near arrival
    // so the landing point itself is exact and the path never overshoots back across the
    // match's edge. Hand-authored constants (rule 11: no Math.random anywhere).
    var FLY_DUR = 900;
    var STEPS = 40;
    var WEAVE_AMP = 22, WEAVE_CYCLES = 3.5, WEAVE_PHASE = 0.6;
    var JITTER_AMP = 8, JITTER_CYCLES = 9, JITTER_PHASE = 1.3;

    // Document coordinates (rule 2): SCROLL_X/SCROLL_Y are added exactly once, at the point
    // each viewport-space value is actually written into this path string or a left/top --
    // animateHorseman's own offset-path precedent.
    var SCROLL_X = window.scrollX, SCROLL_Y = window.scrollY;

    var pathPts = [];
    for (var i = 0; i <= STEPS; i++) {
      var frac = i / STEPS;
      var damp = 1 - frac * 0.85;
      var weave = WEAVE_AMP * Math.sin(frac * WEAVE_CYCLES * 2 * Math.PI + WEAVE_PHASE) * damp;
      var jitter = JITTER_AMP * Math.sin(frac * JITTER_CYCLES * 2 * Math.PI + JITTER_PHASE) * damp;
      var px = startX + dx * frac; // viewport space
      var py = startY + dy * frac + weave + jitter; // viewport space
      pathPts.push([px + SCROLL_X, py + SCROLL_Y]); // document space
    }
    pathPts[STEPS] = [endX + SCROLL_X, endY + SCROLL_Y]; // exact landing, immune to float rounding

    var pathStr = 'M ' + pathPts.map(function (p) { return p[0] + ' ' + p[1]; }).join(' L ');

    // ── Bat ──────────────────────────────────────────────────────────────────────────
    var batAnims = [];
    function trackBat(a) { batAnims.push(a); return a; }

    var batEl = document.createElement('div');
    batEl.className = 'oc-beacon oc-beacon-transient';
    batEl.setAttribute('data-batflight', 'bat');
    batEl.style.cssText = [
      'position:absolute',
      'left:0', 'top:0',
      'width:' + BAT_W + 'px', 'height:' + BAT_H + 'px',
      'pointer-events:none',
      'z-index:2147483642',
      "offset-path:path('" + pathStr + "')", 'offset-anchor:50% 50%', 'offset-rotate:0deg',
      'opacity:1'
    ].join(';');
    document.documentElement.appendChild(batEl);

    var batSvg = document.createElementNS(NS, 'svg');
    batSvg.setAttribute('width', String(BAT_W));
    batSvg.setAttribute('height', String(BAT_H));
    batSvg.setAttribute('viewBox', '0 0 ' + BAT_VB_W + ' ' + BAT_VB_H);
    batSvg.style.cssText = 'display:block;overflow:visible;';
    batSvg.appendChild(batDefs);
    batEl.appendChild(batSvg);

    var frameOutG = buildBatFrame(WING_OUT_L, WING_OUT_R, OUT_PATCH, 'Out');
    frameOutG.setAttribute('data-bf-part', 'wing-out');
    var frameTuckedG = buildBatFrame(WING_TUCKED_L, WING_TUCKED_R, TUCKED_PATCH, 'Tucked');
    frameTuckedG.setAttribute('data-bf-part', 'wing-tucked');
    batSvg.appendChild(frameOutG);
    batSvg.appendChild(frameTuckedG);

    // Discrete swap, not a squash: each frame is fully opaque for its half of the period and
    // fully transparent for the other -- a flip-book, not an interpolation (a sub-part squash
    // rendered invisibly on animateFlappy's first wing pass). Hung on frameOutG/frameTuckedG
    // (child nodes of batSvg) but tracked into batEl's own __waapiAnims below (rule 4).
    var FLAP_PERIOD = 130;
    var FLAP_ITER = Math.ceil(FLY_DUR / FLAP_PERIOD);
    trackBat(frameOutG.animate([
      { opacity: 1, offset: 0 },
      { opacity: 1, offset: 0.49 },
      { opacity: 0, offset: 0.5 },
      { opacity: 0, offset: 1 }
    ], { duration: FLAP_PERIOD * durFactor, iterations: FLAP_ITER, fill: 'forwards' }));
    trackBat(frameTuckedG.animate([
      { opacity: 0, offset: 0 },
      { opacity: 0, offset: 0.49 },
      { opacity: 1, offset: 0.5 },
      { opacity: 1, offset: 1 }
    ], { duration: FLAP_PERIOD * durFactor, iterations: FLAP_ITER, fill: 'forwards' }));

    trackBat(batEl.animate([
      { offsetDistance: '0%' },
      { offsetDistance: '100%' }
    ], { duration: FLY_DUR * durFactor, easing: 'linear', fill: 'forwards' }));

    // ── Mist column ──────────────────────────────────────────────────────────────────
    // Every raw ms constant below stays UNSCALED, used only for offset RATIOS (rule 6:
    // durations/delays are the only thing multiplied by durFactor, at the .animate() call
    // itself) -- animateHorseman's own timeline-comment precedent.
    var MIST_DELAY = FLY_DUR - 180;
    var MIST_GROW_DUR = 260;
    var MIST_HOLD = 150;
    var MIST_FADE_DUR = 320;
    var MIST_TOTAL_DUR = MIST_GROW_DUR + MIST_HOLD + MIST_FADE_DUR; // 730

    // oculist-1ta.8: for the 'below' landing only, the fade-out's overshoot anchor flips to
    // the box's TOP edge so scaleY(1.25)'s extra 0.25*mistH grows downward, away from the
    // match, instead of upward into it. Every other landing keeps the base 50% 100% anchor
    // through both the grow-in and the fade-out, byte-identical to before this special case.
    var mistFadeOrigin = landing.side === 'below' ? '50% 0%' : '50% 100%';

    var mistW = figWidth + MIST_PAD * 2, mistH = figHeight + MIST_PAD * 2;
    var mistEl = document.createElement('div');
    mistEl.className = 'oc-beacon oc-beacon-transient';
    mistEl.setAttribute('data-batflight', 'mist');
    mistEl.style.cssText = [
      'position:absolute',
      'left:' + (endX - mistW / 2 + SCROLL_X) + 'px', 'top:' + (endY - mistH / 2 + SCROLL_Y) + 'px',
      'width:' + mistW + 'px', 'height:' + mistH + 'px',
      'pointer-events:none',
      'z-index:2147483642',
      'background:' +
        'radial-gradient(ellipse 60% 38% at 50% 18%, rgba(148,144,168,0.85), rgba(148,144,168,0) 70%),' +
        'radial-gradient(ellipse 70% 42% at 50% 50%, rgba(120,114,150,0.8), rgba(120,114,150,0) 70%),' +
        'radial-gradient(ellipse 64% 40% at 50% 82%, rgba(96,90,128,0.75), rgba(96,90,128,0) 70%)',
      'transform-origin:50% 100%',
      'opacity:0'
    ].join(';');
    document.documentElement.appendChild(mistEl);

    // Grow-in and fade-out are ONE .animate() call (not two stacked on the same properties)
    // -- oculist-7x3j's own compositing fix, ported as-is: two separate calls keyframing the
    // same properties on one element block compositing.
    var mistAnims = [];
    mistAnims.push(mistEl.animate([
      { offset: 0, opacity: 0, transform: 'scaleY(0.35)', transformOrigin: '50% 100%', easing: 'ease-out' },
      { offset: MIST_GROW_DUR / MIST_TOTAL_DUR, opacity: 0.9, transform: 'scaleY(1)', transformOrigin: '50% 100%', easing: 'linear' },
      { offset: (MIST_GROW_DUR + MIST_HOLD) / MIST_TOTAL_DUR, opacity: 0.9, transform: 'scaleY(1)', transformOrigin: mistFadeOrigin, easing: 'ease-in' },
      { offset: 1, opacity: 0, transform: 'scaleY(1.25)', transformOrigin: mistFadeOrigin }
    ], { duration: MIST_TOTAL_DUR * durFactor, delay: MIST_DELAY * durFactor, fill: 'forwards' }));

    // Bat vanishes into the rising mist rather than cross-fading straight into the figure --
    // a direct cross-fade of two sprites this small reads as a smudge, not a transformation.
    var BAT_FADE_DELAY = MIST_DELAY + 40;
    var BAT_FADE_DUR = 220;
    trackBat(batEl.animate([
      { opacity: 1 },
      { opacity: 0 }
    ], { duration: BAT_FADE_DUR * durFactor, delay: BAT_FADE_DELAY * durFactor, easing: 'ease-in', fill: 'forwards' }));

    batEl.__waapiAnims = batAnims;
    function removeBatEl() { batEl.remove(); }
    Promise.allSettled(batAnims.map(function (a) { return a.finished; })).then(removeBatEl);

    mistEl.__waapiAnims = mistAnims;
    function removeMistEl() { mistEl.remove(); }
    Promise.allSettled(mistAnims.map(function (a) { return a.finished; })).then(removeMistEl);

    // ── Figure ───────────────────────────────────────────────────────────────────────
    var figWrap = document.createElement('div');
    figWrap.className = 'oc-beacon oc-beacon-transient';
    figWrap.setAttribute('data-batflight', 'figure');
    figWrap.setAttribute('data-bf-side', landing.side);
    figWrap.style.cssText = [
      'position:absolute',
      'left:' + (endX - figWidth / 2 + SCROLL_X) + 'px', 'top:' + (endY - figHeight / 2 + SCROLL_Y) + 'px',
      'width:' + figWidth + 'px', 'height:' + figHeight + 'px',
      'pointer-events:none',
      'z-index:2147483642',
      'opacity:0'
    ].join(';');
    document.documentElement.appendChild(figWrap);

    var figSvg = document.createElementNS(NS, 'svg');
    figSvg.setAttribute('width', String(figWidth));
    figSvg.setAttribute('height', String(figHeight));
    figSvg.setAttribute('viewBox', '0 0 ' + FIG_VB_W + ' ' + FIG_VB_H);
    figSvg.style.cssText = 'display:block;overflow:visible;';
    figWrap.appendChild(figSvg);

    function addShape(tag, attrs, parent) {
      var el = document.createElementNS(NS, tag);
      for (var k in attrs) el.setAttribute(k, attrs[k]);
      parent.appendChild(el);
      return el;
    }

    var figDefs = document.createElementNS(NS, 'defs');
    figSvg.appendChild(figDefs);
    function figClip(id, d) {
      var clip = document.createElementNS(NS, 'clipPath');
      clip.setAttribute('id', id);
      addShape('path', { d: d }, clip);
      figDefs.appendChild(clip);
      return id;
    }

    // Collar -- apex y=26, well below the head's top (y=12), and offset in x outside the
    // head's own span, so it reads as a popped collar beside the neck, not a spike above the
    // skull (oculist-1ta.1's own "horned imp" defect).
    var collarLD = 'M 10 64 L 16 26 L 28 56 Z';
    var collarRD = 'M 80 64 L 74 26 L 62 56 Z';
    var collarLClip = figClip(uid + 'collarL', collarLD);
    var collarRClip = figClip(uid + 'collarR', collarRD);
    addShape('polygon', { points: '10,64 16,26 28,56', fill: CAPE, stroke: CAPE_OUTLINE, 'stroke-width': '3' }, figSvg);
    addShape('polygon', { points: '80,64 74,26 62,56', fill: CAPE, stroke: CAPE_OUTLINE, 'stroke-width': '3' }, figSvg);
    addShape('ellipse', { cx: '16', cy: '39', rx: '5', ry: '9', fill: CAPE_HI, 'clip-path': 'url(#' + collarLClip + ')' }, figSvg);
    addShape('ellipse', { cx: '22', cy: '51', rx: '5', ry: '9', fill: CAPE_SHADE, 'clip-path': 'url(#' + collarLClip + ')' }, figSvg);
    addShape('ellipse', { cx: '68', cy: '39', rx: '5', ry: '9', fill: CAPE_HI, 'clip-path': 'url(#' + collarRClip + ')' }, figSvg);
    addShape('ellipse', { cx: '74', cy: '51', rx: '5', ry: '9', fill: CAPE_SHADE, 'clip-path': 'url(#' + collarRClip + ')' }, figSvg);
    var capeBodyD = 'M 14 108 C 16 78 22 60 30 56 L 60 56 C 68 60 74 78 76 108 Z';
    addShape('path', { d: capeBodyD, fill: CAPE, stroke: CAPE_OUTLINE, 'stroke-width': '3' }, figSvg);
    var capeClip = figClip(uid + 'cape', capeBodyD);
    addShape('path', {
      d: 'M 14 108 C 16 78 22 60 30 56 L 40 58 C 32 64 28 80 26 106 Z',
      fill: CAPE_HI, 'clip-path': 'url(#' + capeClip + ')'
    }, figSvg);
    addShape('path', {
      d: 'M 60 56 C 68 60 74 78 76 108 L 64 106 C 66 80 62 62 50 58 Z',
      fill: CAPE_SHADE, 'clip-path': 'url(#' + capeClip + ')'
    }, figSvg);
    // Head -- drawn after the collar/cape so it paints on top, at the viewBox's top edge.
    var headD = 'M 45 33 m -18 0 a 18 21 0 1 0 36 0 a 18 21 0 1 0 -36 0';
    addShape('ellipse', { cx: '45', cy: '33', rx: '18', ry: '21', fill: SKIN, stroke: SKIN_OUTLINE, 'stroke-width': '2.5' }, figSvg);
    var headClip = figClip(uid + 'head', headD);
    addShape('ellipse', { cx: '27', cy: '28', rx: '11', ry: '16', fill: SKIN_HI, 'clip-path': 'url(#' + headClip + ')' }, figSvg);
    addShape('ellipse', { cx: '61', cy: '40', rx: '11', ry: '17', fill: SKIN_SHADE, 'clip-path': 'url(#' + headClip + ')' }, figSvg);
    // oculist-1ta.14: the hair outline was dropped rather than lightened, since HAIR is
    // already near-black and there is no darker shade left to draw a real outline in -- the
    // fill alone already reads as a distinct dark shape against both the page and SKIN.
    addShape('path', {
      d: 'M 27 24 Q 45 8 63 24 Q 63 16 45 12 Q 27 16 27 24 Z',
      fill: HAIR
    }, figSvg);
    addShape('ellipse', { cx: '37', cy: '34', rx: '3.6', ry: '4.4', fill: '#ffffff', stroke: SKIN_OUTLINE, 'stroke-width': '1' }, figSvg);
    addShape('ellipse', { cx: '53', cy: '34', rx: '3.6', ry: '4.4', fill: '#ffffff', stroke: SKIN_OUTLINE, 'stroke-width': '1' }, figSvg);
    addShape('circle', { cx: '37', cy: '35.2', r: '1.8', fill: IRIS }, figSvg);
    addShape('circle', { cx: '53', cy: '35.2', r: '1.8', fill: IRIS }, figSvg);
    addShape('polygon', { points: '43,44 47,44 45,48', fill: NOSE }, figSvg);
    // oculist-1ta.14: the mouth moved up 3 units, clear of the head outline's own stroke
    // band, so it reads as a distinct feature instead of fusing into the chin line.
    addShape('path', { d: 'M 39 48 Q 45 51 51 48', fill: 'none', stroke: HAIR, 'stroke-width': '1.6', style: 'stroke-linecap:round;' }, figSvg);

    // Fade-in and final fade-out are ONE .animate() call, same compositing reasoning as the
    // mist column above (oculist-mu91's own precedent for a figure fade-in/out pair).
    var FIGURE_FADE_DELAY = MIST_DELAY + MIST_GROW_DUR - 60;
    var FIGURE_FADE_DUR = 260;
    var FIGURE_HOLD_AFTER = 600;
    var FIGURE_FINAL_FADE_DELAY = FIGURE_FADE_DELAY + FIGURE_FADE_DUR + FIGURE_HOLD_AFTER;
    var FIGURE_FINAL_FADE_DUR = 300;
    var FIGURE_TOTAL_DUR = FIGURE_FINAL_FADE_DELAY + FIGURE_FINAL_FADE_DUR - FIGURE_FADE_DELAY;

    var figAnim = figWrap.animate([
      { offset: 0, opacity: 0, transform: 'scale(0.85)', easing: 'ease-out' },
      { offset: FIGURE_FADE_DUR / FIGURE_TOTAL_DUR, opacity: 1, transform: 'scale(1)', easing: 'linear' },
      { offset: (FIGURE_FADE_DUR + FIGURE_HOLD_AFTER) / FIGURE_TOTAL_DUR, opacity: 1, transform: 'scale(1)', easing: 'ease-in' },
      { offset: 1, opacity: 0, transform: 'scale(1)' }
    ], { duration: FIGURE_TOTAL_DUR * durFactor, delay: FIGURE_FADE_DELAY * durFactor, fill: 'forwards' });

    figWrap.__waapiAnims = [figAnim];
    function removeFigWrap() { figWrap.remove(); }
    figAnim.finished.then(removeFigWrap).catch(removeFigWrap);
  }

  // oculist-nq1x.10: promotes fxWandCast (artifacts/prototypes/effects-playground.html) into
  // the shipped beacon contract, the ninth entry in the Halloween pack. A sparkling amber
  // fairy lands beside the match (right by default, left if the right side has no room), casts
  // through three wand poses, and launches six sparkles from the wand tip that swirl the match
  // on an orbiting ellipse before fading -- never above/below (see MISSING-REQUIREMENT below).
  //
  // NO ABOVE/BELOW FALLBACK, BY DESIGN (oculist-nq1x.10's own MISSING-REQUIREMENT note): unlike
  // animateBatFlight's beside-then-above-then-below chooser, this effect has no above/below
  // placement at all -- the wand pose art and the sparkle travel bezier both assume the figure
  // sits BESIDE the match (the bezier's control point is keyed off the wand tip's own x and
  // rect.bottom; the orbit's landing-angle bias assumes the wand launches from the same side its
  // sparkles land on). When neither side has full clearance, this does NOT fall back to
  // above/below and does NOT suppress on that alone -- it still tries sideRight, then suppresses
  // (mounts nothing at all) ONLY if the actual clamped painted bounds of the figure genuinely
  // overlap #match (oculist-giy7). A synthetic full-width #match (the standard FORCED-LANDING
  // harness rows) therefore suppresses on every one of those rows unconditionally -- unfalsifiable
  // by construction for this key, the same reclassification Tentacle Rise's own vacuous-green risk
  // needed (oculist-ke53/4k8y); this suite proves real (non-vacuous) placement and real suppression
  // separately via a live element census, not just a clean pixel-diff.
  //
  // NO START-POINT CASCADE, RULE 9 EXCEPTION (oculist-i8zu, DECIDED 2026-09-23, oculist-nq1x.10's
  // own RULE 9 DECIDED note): the shipped lastMouseX/find-bar/viewport start-point cascade
  // animateTrail uses is deliberately NOT used here. Every sparkle launches from the wand tip
  // (wandTipScreen, itself derived from the figure's own placement, which keeps the travel clear
  // of #match per rule 10) -- a cursor or find-bar origin would detach the sparkles from the
  // figure that casts them. Rule 9's other half -- the mirrored branch must work for real, not
  // just compile -- still applies and is tested below.
  //
  // SIX PRIOR OCCLUSION DEFECTS, all closed, ported forward rather than re-derived: oculist-tvqw
  // (the rx floor below is NOT the strictly-derived (rect.width/2 + MARGIN)/cos(30deg) form --
  // deliberately kept as MARGIN/cos(30deg) alone, a measured trade, see the rx comment below),
  // oculist-giy7 (the side-selection fallback suppresses on the ACTUAL clamped painted bounds,
  // never on sideRight.fits/sideLeft.fits alone), oculist-wkfc (a sparkle's launch stays invisible
  // until the sampled travel path first visually clears #match -- revealTravelT below), oculist-73l6
  // (+1px of ORBIT_EDGE_MARGIN for a simultaneous-both-axes corner case), oculist-3dd8 (DOES
  // apply here, corrected after review: scroll goes through fadeActiveBeacons(), an immediate
  // teardown with no stale-clip window, but RESIZE does not -- content.js's own handleResize
  // only reaches cancelBeacons() via repositionActiveOverlays() after a 100ms debounce that a
  // continuous resize drag keeps resetting, so backWrap's static clip-path hole can go stale
  // against a reflowed #match for the whole drag. Ported the prototype's own hard cut: backWrap
  // tears itself down on the FIRST resize event, ahead of the debounced cancelBeacons() -- see
  // backWrap's own comment below), oculist-mbmy (the engagement-threshold framing for when
  // rxViewportCap actually differs from rawRx). A redraw or "cleanup" that restores any of the
  // cut/fixed beats these close reasons describe is a regression, not an improvement.
  //
  // Fixed identity palette (oculist-1ta.30's own accent-amber recolor, rule 6's own license,
  // "the pumpkin's orange"): OUTLINE/AMBER/SPARK_* are fixed literals, like Vampire Bat's BAT_*
  // tones -- there is no separate flash/UI-accent element here for getEffectiveColors().beacon to
  // drive.
  //
  // Lite Mode (rule 7): a no-op, the same reasoning Vampire Bat's/Tentacle Rise's own header
  // comments give for themselves. There is no filter, no box-shadow and no decorative glow layer
  // anywhere in this effect's shipped art -- every "glow" mentioned in the geometry comments below
  // is a historical clearance-margin name, not a rendered CSS effect -- and the wand-pose swap plus
  // the orbiting sparkle swirl ARE the effect's defining beats, not decorative flicker to cut.
  // settings.performanceMode is deliberately never read below.
  function animateWandCast(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;

    var NS = 'http://www.w3.org/2000/svg';
    var mcy = rect.top + rect.height / 2; // viewport space (rule 2)
    var vw = window.innerWidth, vh = window.innerHeight;

    var beaconScale = getBeaconScale();
    var durFactor = getBeaconDuration(1);

    var OUTLINE = '#6f4608';
    var AMBER = '#f59e0b';
    var SPARK_CORE = '#fff6d8';
    var SPARK_MID = '#ffd76a';
    var SPARK_EDGE = '#c98a1c';
    var STROKE = 'stroke-linejoin:round;stroke-linecap:round;';

    function svgEl(tag, attrs, parent) {
      var el = document.createElementNS(NS, tag);
      for (var k in attrs) el.setAttribute(k, attrs[k]);
      parent.appendChild(el);
      return el;
    }

    function shape(d, fill, parent, stroke, width, part) {
      var attrs = { d: d, fill: fill };
      if (stroke) {
        attrs.stroke = stroke;
        attrs['stroke-width'] = String(width);
        attrs.style = STROKE;
      }
      if (part) attrs['data-wc-part'] = part;
      return svgEl('path', attrs, parent);
    }

    // ── Fairy art, local viewBox coordinates. Canonical drawing always reaches with the wand
    // toward local -x -- see toScreen() below for why that one convention covers both landing
    // sides without a second set of coordinates. ──
    var VB_W = 40, VB_H = 52;
    var SHOULDER = [20, 17];
    var TIP_BACK = [16, -10];
    var TIP_MID = [-4, 4];
    var TIP_CAST = [-16, 18];
    var WAND_TIP_LOCAL = TIP_CAST;
    var TIP_RADIUS_LOCAL = 2.5;

    // Furthest local reach toward the match (wand tip at cast) and away from it (the wing's own
    // outer tip) -- the same GAP/REACH_INWARD/REACH_OUTWARD side-selection idiom animateReanimate
    // uses, so the figure never lands close enough to occlude the glyphs and never picks a side
    // it doesn't actually fit on.
    var ANCHOR_X = 20;
    var REACH_INWARD_LOCAL = ANCHOR_X - (WAND_TIP_LOCAL[0] - 1); // 37
    var REACH_OUTWARD_LOCAL = 30; // wing's own rightmost point, see wingUpper below

    // figHeight carries beaconScale (rule 6) BEFORE the placement/clearance math below is
    // derived from it, the same "scale before computing placement" discipline animateReanimate's
    // own figHeight comment describes.
    var figHeight = Math.max(34, Math.min(48, 1.5 * rect.height)) * beaconScale;
    var scale = figHeight / VB_H;
    var figWidth = VB_W * scale;
    var GAP = 14;
    var REACH_INWARD = REACH_INWARD_LOCAL * scale + 3;
    var REACH_OUTWARD = REACH_OUTWARD_LOCAL * scale + 3;

    // ── Side selection: right by default, mirror to the left only if the right doesn't fit,
    // exactly animateReanimate's/animateTentacleRise's own "never above/below" convention. ──
    var sideRight = { x: rect.right + GAP + REACH_INWARD };
    sideRight.fits = sideRight.x + REACH_OUTWARD <= vw - 4;
    var sideLeft = { x: rect.left - GAP - REACH_INWARD };
    sideLeft.fits = sideLeft.x - REACH_OUTWARD >= 4;
    // "Fits" is the full REACH_INWARD/REACH_OUTWARD comfort budget, not mere non-overlap -- when
    // neither side clears it, sideRight is still kept as the fallback landing (oculist-giy7):
    // whether it is actually safe to draw is decided below, from the real painted bounds, not
    // from these two flags alone.
    var landing = sideRight.fits ? sideRight : (sideLeft.fits ? sideLeft : sideRight);
    var onRight = landing === sideRight;
    var mirrored = !onRight;

    // Hard viewport clamp on top of the side-selection math above, so a narrow viewport
    // (320x900/360x900) can never push the fairy off-screen.
    var figLeft = Math.max(4, Math.min(vw - 4 - figWidth, landing.x - ANCHOR_X * scale));
    var figTop = Math.max(4, Math.min(vh - 4 - figHeight, mcy - figHeight / 2));

    // oculist-giy7/wkfc: suppress ONLY if the ACTUAL clamped painted bounds overlap #match --
    // not merely because sideRight.fits/sideLeft.fits above are both false (those flags require
    // the full comfort budget; the clamp above can still land clear of #match even when that
    // budget doesn't fit). This is figure-only, geometry-driven, keyed off the actual local art
    // extrema after scale/mirroring -- not the viewport size or a scenario name. When it fires,
    // the entire flanking figure AND its sparkles are suppressed for this render (no above/below
    // fallback exists for this effect, see this function's own header comment).
    var PAINT_MIN_X = TIP_CAST[0] - TIP_RADIUS_LOCAL;
    var PAINT_MAX_X = 50; // wingUpper's outer point
    var PAINT_MIN_Y = TIP_BACK[1] - TIP_RADIUS_LOCAL;
    var PAINT_MAX_Y = 46; // body's lowest point
    var paintLeft = figLeft + (mirrored ? VB_W - PAINT_MAX_X : PAINT_MIN_X) * scale;
    var paintRight = figLeft + (mirrored ? VB_W - PAINT_MIN_X : PAINT_MAX_X) * scale;
    var paintTop = figTop + PAINT_MIN_Y * scale;
    var paintBottom = figTop + PAINT_MAX_Y * scale;
    if (paintLeft < rect.right && paintRight > rect.left &&
        paintTop < rect.bottom && paintBottom > rect.top) {
      return;
    }

    // Local (lx,ly) -> viewport px. The wrapper div is mirrored with transform:scaleX(-1)
    // (transform-origin defaults to the box's own center), so a mirrored local point reflects
    // across figWidth/2 rather than simply negating -- the one formula every screen-space use of
    // the local art (the wand tip, below) has to go through.
    function toScreen(lx, ly) {
      var ux = mirrored ? (figWidth - lx * scale) : (lx * scale);
      return [figLeft + ux, figTop + ly * scale]; // viewport space
    }

    function visualClearsMatch(px, py, reach) {
      return px + reach <= rect.left || px - reach >= rect.right ||
        py + reach <= rect.top || py - reach >= rect.bottom;
    }

    // Document coordinates (rule 2): SCROLL_X/SCROLL_Y are added exactly once, at the point each
    // viewport-space value is actually written into a left/top or a transform -- animateBatFlight's
    // own offset-path precedent.
    var SCROLL_X = window.scrollX, SCROLL_Y = window.scrollY;

    // ── Figure ───────────────────────────────────────────────────────────────────────────
    var wrapAnims = [];
    function trackWrap(a) { wrapAnims.push(a); return a; }

    var wrap = document.createElement('div');
    wrap.className = 'oc-beacon oc-beacon-transient';
    wrap.setAttribute('data-wandcast', 'figure');
    wrap.setAttribute('data-wc-side', onRight ? 'right' : 'left');
    wrap.style.cssText = [
      'position:absolute',
      'left:' + (figLeft + SCROLL_X) + 'px', 'top:' + (figTop + SCROLL_Y) + 'px',
      'width:' + figWidth + 'px', 'height:' + figHeight + 'px',
      'pointer-events:none',
      'z-index:2147483642',
      'opacity:0',
      mirrored ? 'transform:scaleX(-1);' : ''
    ].join(';');
    document.documentElement.appendChild(wrap);

    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', String(figWidth));
    svg.setAttribute('height', String(figHeight));
    svg.setAttribute('viewBox', '0 0 ' + VB_W + ' ' + VB_H);
    svg.style.cssText = 'display:block;overflow:visible;';
    wrap.appendChild(svg);

    // Core (head/body/wings) is shared across every wand pose -- only the arm+wand group swaps,
    // the same "shared core, swap the limb" idiom animateHorseman uses for its gallop/rear frames.
    var core = svgEl('g', { 'data-wc-core': '' }, svg);
    shape('M25 18 C30 7 42 -3 48 -3 Q52 -2 48 6 Q46 10 43 12 Q47 12 43 16 Q37 20 25 18Z', SPARK_CORE, core, SPARK_EDGE, 2, 'wing-upper');
    shape('M26 21 Q39 19 46 23 Q50 27 43 29 Q44 33 38 32 Q32 30 26 21Z', SPARK_CORE, core, SPARK_EDGE, 2, 'wing-lower');
    shape('M29 22 Q37 22 38 27 Q34 27 29 22Z', SPARK_MID, core);
    shape('M30 29 Q39 32 40 41 Q36 39 31 34Z', AMBER, core, OUTLINE, 2, 'leg-back');
    shape('M24 30 L30 31 Q34 38 35 45 Q30 42 25 36Z', AMBER, core, OUTLINE, 2, 'leg-front');
    shape('M21 16 Q18 17 19 24 Q20 31 23 36 L26 30 L30 32 L30 28 Q34 30 36 28 Q34 24 27 21 L25 16Z', AMBER, core, OUTLINE, 2, 'tunic');
    shape('M21 19 Q20 24 23 30 L24 27 Q22 22 23 19Z', SPARK_MID, core);
    shape('M20 3 Q15 7 17 13 Q18 17 23 17 Q27 16 27 11 L26 4Z', SPARK_MID, core, OUTLINE, 2, 'profile');
    shape('M17 10 Q14 3 20 0 Q24 -2 28 -1 L30 -3 Q31 0 28 1 Q33 1 34 7 Q35 10 38 9 Q36 14 31 12 Q32 16 25 18 Q29 14 26 11 Q21 10 19 5Z', AMBER, core, OUTLINE, 2, 'bob');
    shape('M21 2 Q28 0 31 5 Q27 3 23 4Z', SPARK_MID, core);

    function addArmPose(name, tip, hand, arm) {
      var g = svgEl('g', { 'data-wc-pose': name }, svg);
      var shaft = 'M' + hand.join(' ') + ' L' + tip.join(' ');
      shape(shaft, 'none', g, OUTLINE, 2.8, 'wand');
      shape(shaft, 'none', g, SPARK_MID, 1.2);
      shape('M' + SHOULDER.join(' ') + arm, AMBER, g, OUTLINE, 1.5, 'arm');
      var star = svgEl('g', { transform: 'translate(' + tip.join(' ') + ')', 'data-wc-part': 'tip' }, g);
      shape('M0 -2.5 L.8 -.8 L2.5 0 L.8 .8 L0 2.5 L-.8 .8 L-2.5 0 L-.8 -.8Z', SPARK_EDGE, star);
      shape('M0 -1.7 L.55 -.55 L1.7 0 L.55 .55 L0 1.7 L-.55 .55 L-1.7 0 L-.55 -.55Z', SPARK_CORE, star);
      return g;
    }
    var poseBack = addArmPose('windup', TIP_BACK, [15, 3], ' Q14 15 12 6 Q10 2 13 1 Q16 0 17 4 L16 6 Q17 11 22 13Z');
    var poseMid = addArmPose('diagonal', TIP_MID, [6, 12], ' Q13 17 8 14 Q4 15 4 11 Q4 8 7 10 L9 12 Q15 14 21 13Z');
    var poseCast = addArmPose('cast', TIP_CAST, [1, 18], ' Q10 20 3 20 Q-1 21 -1 18 Q-1 15 2 16 L5 17 L20 14Z');
    poseMid.style.opacity = '0';
    poseCast.style.opacity = '0';

    // ── Timeline (ms) -- durFactor (rule 6) multiplies every duration/delay directly, at the
    // .animate() call itself, so relative timing is preserved exactly, matching animateReanimate's
    // own "raw * durFactor" idiom. ──
    var ENTRY_DUR = 150;
    var POSE_HOLD = 150;
    var T_POSE_MID = ENTRY_DUR + POSE_HOLD;      // 300
    var CAST_START = T_POSE_MID + POSE_HOLD;     // 450, wand reaches the match-facing pose
    var TRAVEL_DUR = 260;
    var ANGULAR_SPEED = 0.5; // deg/ms, constant across every sparkle
    var ORBIT_MIN_SWEEP = 380; // > 360 so every sparkle completes a full lap
    // Hand-authored, irregular on purpose (rule 11: no Math.random anywhere) -- six launches
    // from the wand tip across the wave's final hold.
    var CAST_STAGGER = [0, 55, 95, 150, 185, 230];
    var STAGGER_MAX = 230;
    var ORBIT_STOP_T = CAST_START + STAGGER_MAX + TRAVEL_DUR + ORBIT_MIN_SWEEP / ANGULAR_SPEED; // 1700
    var FADE_DUR = 200;
    var DUR = ORBIT_STOP_T + FADE_DUR + 60;

    trackWrap(poseBack.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 1, delay: (T_POSE_MID - 1) * durFactor, fill: 'forwards' }));
    trackWrap(poseMid.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1, delay: (T_POSE_MID - 1) * durFactor, fill: 'forwards' }));
    trackWrap(poseMid.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 1, delay: (CAST_START - 1) * durFactor, fill: 'forwards' }));
    trackWrap(poseCast.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1, delay: (CAST_START - 1) * durFactor, fill: 'forwards' }));

    // Entry fade-in and the end-of-life fade-out are ONE animation, not two -- a separate fade-in
    // call would still be active (fill:'forwards') when this one starts at the same delay:0, and
    // WAAPI's default 'replace' composite would let the later-added animation win, snapping the
    // fairy to fully opaque at t=0 instead of fading it in (animateBatFlight's own mist/figure
    // precedent for this compositing rule).
    trackWrap(wrap.animate([
      { opacity: 0, offset: 0 },
      { opacity: 1, offset: ENTRY_DUR / DUR },
      { opacity: 1, offset: ORBIT_STOP_T / DUR },
      { opacity: 0, offset: 1 }
    ], { duration: DUR * durFactor, fill: 'forwards', easing: 'linear' }));

    var wandTipScreen = toScreen(WAND_TIP_LOCAL[0], WAND_TIP_LOCAL[1]); // viewport space
    var SPARK_SIZE = 12 * beaconScale;
    var SPARK_HALF = SPARK_SIZE / 2;
    var SPARK_VISUAL_REACH = SPARK_HALF + 4 * beaconScale;

    // ── Orbit ellipse. Centered DOWN_BIAS below the match's own vertical middle so the ellipse's
    // lower (front) extreme clears well past rect.bottom while its upper (back) extreme dips just
    // inside rect.top -- the back arc's own visibility there is handled entirely by backWrap's
    // clip-path, below. padX/DOWN_BIAS/ry ratios cover the front sparkle's own visual extent, not
    // just its center point (measured via occlusion-sweep.js in the prototype). ──
    var mcx = rect.left + rect.width / 2;
    var padX = 22 * beaconScale;
    var rawRx = rect.width / 2 + padX;
    var DOWN_BIAS = 0.32 * rect.height;
    var ry = 0.78 * rect.height;
    var ecx = mcx, ecy = mcy + DOWN_BIAS;

    // oculist-tvqw/oculist-giy7/oculist-mbmy: rx is floored at the match's own half width plus a
    // clearance term (NOT the strictly-derived (rect.width/2 + MARGIN)/cos(30deg) form -- see this
    // function's own header comment; DECISION, keep as-is) and capped so the ellipse's own
    // horizontal extreme still clears the viewport edge at a narrow viewport. ORBIT_EDGE_MARGIN
    // scales with beaconScale (it derives from the sparkle's own half-size); the 320x900/360x900
    // edge-clamp cases these defects were filed against are exercised below.
    var ORBIT_EDGE_MARGIN = 18 * beaconScale; // half of SPARK_SIZE + slack (oculist-73l6: +1px margin for a simultaneous-both-axes corner case, then oculist-1ta.30's SPARK_SIZE=12 re-derivation to 18)
    var LANDING_MIN_DEG_FROM_HORIZONTAL = 30; // must match THETA0_RIGHT's own bound, below
    var rxViewportCap = Math.min(ecx - ORBIT_EDGE_MARGIN, (vw - ORBIT_EDGE_MARGIN) - ecx);
    var matchClearanceFloor = rect.width / 2 +
      ORBIT_EDGE_MARGIN / Math.cos(LANDING_MIN_DEG_FROM_HORIZONTAL * Math.PI / 180);
    var rx = Math.max(matchClearanceFloor, Math.min(rawRx, rxViewportCap));

    function ellipsePoint(deg) {
      var rad = deg * Math.PI / 180;
      return [ecx + rx * Math.cos(rad), ecy + ry * Math.sin(rad)]; // viewport space
    }
    // y = ecy + ry*sin(theta): sin>=0 means the point sits AT OR BELOW the ellipse's own center,
    // i.e. the lower/front arc.
    function isFrontDeg(deg) {
      var rad = ((deg % 360) + 360) % 360 * Math.PI / 180;
      return Math.sin(rad) >= 0;
    }

    // Landing angles are restricted to [30,120] degrees, biased to the fairy's own side (a
    // quadratic bezier is bounded by the convex hull of its control points, not by each point's
    // individual clearance -- a wider range let the hull sweep back across #match even though
    // every control point was individually clear). [30,120] keeps every landing point on the SAME
    // side as the wand tip's own launch.
    var THETA0_RIGHT = [120, 105, 90, 70, 50, 30];
    var THETA0 = onRight ? THETA0_RIGHT : THETA0_RIGHT.map(function (d) { return 180 - d; });

    function buildAngleCheckpoints(theta0, sweep, stepDeg) {
      var end = theta0 + sweep;
      var angles = [theta0];
      var cur = theta0;
      while (cur < end - 1e-6) {
        var next = Math.min(cur + stepDeg, end);
        var k = Math.floor(cur / 180) + 1;
        while (k * 180 < next - 1e-6) {
          if (k * 180 > cur + 1e-6) { angles.push(k * 180); cur = k * 180; }
          k++;
        }
        angles.push(next);
        cur = next;
      }
      return angles;
    }

    // Every point below (wand tip, bezier samples, ellipse points) is the sparkle's intended
    // CENTER in viewport space. frontEl is mounted directly on document.documentElement at
    // left:0;top:0 (document-space origin), so ITS translate needs SCROLL_X/SCROLL_Y added --
    // animateBatFlight's own offset-path precedent, added here exactly once.
    function centerTranslateDoc(px, py) {
      return 'translate(' + (px - SPARK_HALF + SCROLL_X) + 'px,' + (py - SPARK_HALF + SCROLL_Y) + 'px)';
    }
    // backEl (the back-arc ghost) is instead a CHILD of backWrap, whose own box is already
    // anchored at document (SCROLL_X, SCROLL_Y) -- see backWrap's own left/top below -- so
    // backEl's local origin already coincides with the viewport's own top-left. Routing its
    // translate through centerTranslateDoc (as the figure/frontEl do) would add the scroll
    // offset a SECOND time, walking every ghost sparkle scrollY px too far down the document
    // and off the clip-path's own punched hole (review defect 1, measured at scrollY=1668: front
    // sparkles at viewport y~391-404, ghosts at y~2054-2072, one scrollY off). This helper stays
    // in plain viewport space, with no scroll term at all.
    function centerTranslateLocal(px, py) {
      return 'translate(' + (px - SPARK_HALF) + 'px,' + (py - SPARK_HALF) + 'px)';
    }

    function sparkVisual(index) {
      var glyph = document.createElementNS(NS, 'svg');
      glyph.setAttribute('xmlns', NS);
      glyph.setAttribute('width', '12'); glyph.setAttribute('height', '12');
      glyph.setAttribute('viewBox', '0 0 12 12');
      glyph.setAttribute('data-wc-spark', ['star', 'diamond', 'burst'][index % 3]);
      glyph.style.display = 'block';
      var d = [
        'M6 1 L7.8 4.2 L11 6 L7.8 7.8 L6 11 L4.2 7.8 L1 6 L4.2 4.2Z',
        'M6 1 Q7.5 4.5 11 6 Q7.5 7.5 6 11 Q4.5 7.5 1 6 Q4.5 4.5 6 1Z',
        'M5 2 Q5 1 6 1 Q7 1 7 2 L7 4.2 L9.5 2.8 Q11 2 11 3.5 Q11 4 10.5 4.4 L8 6 L10.5 7.6 Q11 8 11 8.5 Q11 10 9.5 9.2 L7 7.8 L7 10 Q7 11 6 11 Q5 11 5 10 L5 7.8 L2.5 9.2 Q1 10 1 8.5 Q1 8 1.5 7.6 L4 6 L1.5 4.4 Q1 4 1 3.5 Q1 2 2.5 2.8 L5 4.2Z'
      ][index % 3];
      shape(d, SPARK_EDGE, glyph);
      var mid = shape(d, SPARK_MID, glyph);
      mid.setAttribute('transform', 'translate(6 6) scale(.75) translate(-6 -6)');
      var coreShape = shape(d, SPARK_CORE, glyph);
      coreShape.setAttribute('transform', 'translate(6 6) scale(.55) translate(-6 -6)');
      return glyph;
    }

    // ── Back-arc clipping wrapper. One absolute, full-viewport-sized element anchored at the
    // current viewport's own document-space origin (rule 2 -- animateReanimate's own
    // reanimateWrap idiom), with a STATIC evenodd clip-path: an outer loop tracing the viewport
    // and an inner loop tracing #match's own rect (viewport-relative, i.e. relative to this div's
    // own local box, which starts at the viewport's top-left), bridged into a single continuous
    // point list -- the standard "keyhole" technique for punching a hole with one polygon. Every
    // back-arc ghost below is a plain DOM child of this wrapper, not its own top-level mounted
    // element -- so its animations are tracked onto backWrap.__waapiAnims (rule 4: "animations on
    // child nodes hang on the parent"), and removing backWrap removes them.
    //
    // oculist-3dd8 DOES apply here (corrected after review). This wrapper's clip-path hole is a
    // STATIC snapshot of the fire-time #match rect. A real user SCROLL is fine -- handleScroll()
    // calls fadeActiveBeacons() synchronously, tearing every transient beacon down immediately,
    // so there is no window where the stale hole could paint through. A RESIZE is not: content.js
    // only reaches cancelBeacons() via handleResize() -> repositionActiveOverlays(), gated behind
    // a 100ms debounce (overlayResizeTimer) that a continuous resize drag keeps resetting on every
    // event, so #match can reflow to a new position (or size) while this hole stays punched at the
    // old one for the whole drag -- the back-arc ghosts then paint straight over the glyphs (or
    // leave a gap over the vacated old position). See hardCutBackWrap() below, the ported
    // equivalent of the prototype's dissolveHardCut: it tears backWrap down on the very first
    // resize event, ahead of the debounced cancelBeacons().
    var CLIP_MARGIN = 2;
    var backWrap = document.createElement('div');
    backWrap.className = 'oc-beacon oc-beacon-transient';
    backWrap.setAttribute('data-wandcast', 'back-clip');
    var clipPts = [
      '0px 0px', vw + 'px 0px', vw + 'px ' + vh + 'px', '0px ' + vh + 'px', '0px 0px',
      (rect.left - CLIP_MARGIN) + 'px ' + (rect.top - CLIP_MARGIN) + 'px', (rect.left - CLIP_MARGIN) + 'px ' + (rect.bottom + CLIP_MARGIN) + 'px',
      (rect.right + CLIP_MARGIN) + 'px ' + (rect.bottom + CLIP_MARGIN) + 'px', (rect.right + CLIP_MARGIN) + 'px ' + (rect.top - CLIP_MARGIN) + 'px', (rect.left - CLIP_MARGIN) + 'px ' + (rect.top - CLIP_MARGIN) + 'px'
    ].join(', ');
    backWrap.style.cssText = [
      'position:absolute',
      'left:' + SCROLL_X + 'px', 'top:' + SCROLL_Y + 'px',
      'width:' + vw + 'px', 'height:' + vh + 'px',
      'pointer-events:none',
      'z-index:2147483642',
      'clip-path:polygon(evenodd, ' + clipPts + ')'
    ].join(';');
    document.documentElement.appendChild(backWrap);
    var backWrapAnims = [];

    for (var i = 0; i < THETA0.length; i++) {
      var theta0 = THETA0[i];
      var castStart = CAST_START + CAST_STAGGER[i];
      var orbitDur = ORBIT_STOP_T - (castStart + TRAVEL_DUR);
      // FADE_DUR is reserved OUT of the orbit motion (not appended after it) -- the orbit's own
      // angle sweep only covers orbitMotionDur, and the fade-out keyframes below start exactly
      // where that motion ends.
      var orbitMotionDur = Math.max(0, orbitDur - FADE_DUR);
      var sweep = ANGULAR_SPEED * orbitMotionDur;
      var duration = TRAVEL_DUR + orbitDur;
      var travelFrac = TRAVEL_DUR / duration;
      var fadeFrac = (TRAVEL_DUR + orbitMotionDur) / duration;

      // Travel: a quadratic bezier from the wand tip, biased to drop below the match before
      // sweeping inward -- the control point shares the wand tip's own x (not the midpoint's),
      // so early in the curve the sparkle is still outside the match's horizontal rect while it
      // loses height, and only turns inward once it has already cleared rect.bottom. 1.3*height
      // keeps every landing angle in THETA0 clear of #match by sampling the actual bezier curve,
      // not just its three control points (a quadratic bezier is bounded by their convex hull).
      var land = ellipsePoint(theta0);
      var ctrl = [wandTipScreen[0], rect.bottom + 1.3 * rect.height];
      var TRAVEL_SAMPLES = 8;
      // Two parallel position-keyframe arrays, same offsets, same underlying px/py samples --
      // only the translate space differs (see centerTranslateDoc/centerTranslateLocal's own
      // comments above). posKFFront drives frontEl (document space); posKFBack drives backEl
      // (viewport space, relative to backWrap's already-scrolled box).
      var posKFFront = [];
      var posKFBack = [];
      // oculist-wkfc: a viewport clamp can leave the wand tip itself clear while a sparkle's
      // larger box+glow still overlaps #match. Keep that launch invisible until the sampled
      // travel path first clears.
      var revealTravelT = visualClearsMatch(wandTipScreen[0], wandTipScreen[1], SPARK_VISUAL_REACH) ? 0 : 1;
      var lastPx = wandTipScreen[0], lastPy = wandTipScreen[1];
      for (var s = 0; s <= TRAVEL_SAMPLES; s++) {
        var t = s / TRAVEL_SAMPLES;
        var it = 1 - t;
        var px = it * it * wandTipScreen[0] + 2 * it * t * ctrl[0] + t * t * land[0];
        var py = it * it * wandTipScreen[1] + 2 * it * t * ctrl[1] + t * t * land[1];
        var travelOffset = t * travelFrac;
        posKFFront.push({ transform: centerTranslateDoc(px, py), offset: travelOffset });
        posKFBack.push({ transform: centerTranslateLocal(px, py), offset: travelOffset });
        if (revealTravelT === 1 && visualClearsMatch(px, py, SPARK_VISUAL_REACH)) revealTravelT = t;
        lastPx = px; lastPy = py;
      }

      var angles = buildAngleCheckpoints(theta0, sweep, 20);
      var revealOffset = revealTravelT * travelFrac;
      var frontKF = [{ opacity: 0, offset: 0 }];
      if (revealOffset > 0) frontKF.push({ opacity: 0, offset: revealOffset });
      frontKF.push(
        { opacity: 1, offset: Math.min(travelFrac, revealOffset + Math.min(0.04, travelFrac * 0.3)) },
        { opacity: 1, offset: travelFrac }
      );
      var backKF = [{ opacity: 0, offset: 0 }, { opacity: 0, offset: travelFrac }];
      var lastFront = 1, lastBack = 0, lastOffset = travelFrac;
      function fracAt(deg) {
        return sweep > 0 ? travelFrac + (deg - theta0) / ANGULAR_SPEED / duration : travelFrac;
      }
      for (var a = 1; a < angles.length; a++) {
        var deg = angles[a];
        var frac = fracAt(deg);
        var pt = ellipsePoint(deg);
        posKFFront.push({ transform: centerTranslateDoc(pt[0], pt[1]), offset: frac });
        posKFBack.push({ transform: centerTranslateLocal(pt[0], pt[1]), offset: frac });
        lastPx = pt[0]; lastPy = pt[1];

        var isBoundary = Math.abs(deg % 180) < 1e-6;
        if (isBoundary) {
          var justBefore = isFrontDeg(deg - 0.01);
          var justAfter = isFrontDeg(deg + 0.01);
          var eps = Math.min(0.002, (frac - fracAt(angles[a - 1])) / 2);
          frontKF.push({ opacity: justBefore ? 1 : 0, offset: frac - eps });
          frontKF.push({ opacity: justAfter ? 1 : 0, offset: frac });
          backKF.push({ opacity: justBefore ? 0 : 1, offset: frac - eps });
          backKF.push({ opacity: justAfter ? 0 : 1, offset: frac });
          lastFront = justAfter ? 1 : 0; lastBack = justAfter ? 0 : 1;
        } else {
          var front = isFrontDeg(deg) ? 1 : 0;
          frontKF.push({ opacity: front, offset: frac });
          backKF.push({ opacity: front ? 0 : 1, offset: frac });
          lastFront = front; lastBack = front ? 0 : 1;
        }
        lastOffset = frac;
      }
      // Math.max guards against float rounding: fadeFrac and the loop's own last `frac` are
      // mathematically the same instant but can differ by a ULP, enough for WAAPI's strict
      // monotonic-offset check to reject a fractional decrease.
      var fadeStart = Math.max(fadeFrac, lastOffset);
      frontKF.push({ opacity: lastFront, offset: fadeStart });
      frontKF.push({ opacity: 0, offset: 1 });
      backKF.push({ opacity: lastBack, offset: fadeStart });
      backKF.push({ opacity: 0, offset: 1 });
      // Explicit hold at offset 1: WAAPI treats offset 1 as an IMPLICIT keyframe equal to the
      // element's underlying (un-animated) value when the last explicit keyframe sits below
      // offset 1, which would drag the sparkle back toward translate(0,0) for the final stretch
      // of the timeline. This one keyframe, repeating the last real position, holds it there.
      posKFFront.push({ transform: centerTranslateDoc(lastPx, lastPy), offset: 1 });
      posKFBack.push({ transform: centerTranslateLocal(lastPx, lastPy), offset: 1 });

      var frontEl = document.createElement('div');
      frontEl.className = 'oc-beacon oc-beacon-transient';
      frontEl.setAttribute('data-wandcast', 'spark-front');
      frontEl.style.cssText = [
        'position:absolute',
        'left:0', 'top:0',
        'width:' + SPARK_SIZE + 'px', 'height:' + SPARK_SIZE + 'px',
        'pointer-events:none',
        'z-index:2147483642',
        'opacity:0'
      ].join(';');
      frontEl.appendChild(sparkVisual(i));
      document.documentElement.appendChild(frontEl);

      // Back-arc ghost: a plain child of backWrap (see its own comment above), not its own
      // mounted top-level element -- no 'oc-beacon' class, no z-index override.
      var backEl = document.createElement('div');
      backEl.style.cssText = [
        'position:absolute',
        'left:0', 'top:0',
        'width:' + SPARK_SIZE + 'px', 'height:' + SPARK_SIZE + 'px',
        'opacity:0'
      ].join(';');
      backEl.appendChild(sparkVisual(i));
      backWrap.appendChild(backEl);

      var frontAnims = [];
      frontAnims.push(frontEl.animate(posKFFront, { duration: duration * durFactor, delay: castStart * durFactor, fill: 'forwards', easing: 'linear' }));
      frontAnims.push(frontEl.animate(frontKF, { duration: duration * durFactor, delay: castStart * durFactor, fill: 'forwards', easing: 'linear' }));
      frontEl.__waapiAnims = frontAnims;
      (function (el, anims) {
        Promise.allSettled(anims.map(function (a) { return a.finished; })).then(function () { el.remove(); });
      })(frontEl, frontAnims);

      backWrapAnims.push(backEl.animate(posKFBack, { duration: duration * durFactor, delay: castStart * durFactor, fill: 'forwards', easing: 'linear' }));
      backWrapAnims.push(backEl.animate(backKF, { duration: duration * durFactor, delay: castStart * durFactor, fill: 'forwards', easing: 'linear' }));
    }

    backWrap.__waapiAnims = backWrapAnims;
    Promise.allSettled(backWrapAnims.map(function (a) { return a.finished; })).then(function () { backWrap.remove(); });

    // oculist-3dd8 (ported): a resize can reflow #match while backWrap's clip-path hole stays
    // punched at the stale fire-time rect for up to the FULL length of a continuous resize drag
    // -- content.js's own cancelBeacons() only reaches backWrap through handleResize()'s 100ms
    // debounce (overlayResizeTimer), which a dragged edge keeps re-arming on every event. Cancel
    // backWrap's own animations and remove it immediately on the first resize, ahead of that
    // debounce, so the ghosts can never paint through a hole that no longer matches #match.
    function hardCutBackWrap() {
      window.removeEventListener('resize', hardCutBackWrap);
      if (!backWrap.isConnected) return;
      backWrap.__waapiAnims.forEach(function (a) { try { a.cancel(); } catch (e) {} });
      backWrap.remove();
    }
    window.addEventListener('resize', hardCutBackWrap, { passive: true, once: true });

    // { once: true } above only removes the listener once a resize actually FIRES -- if no
    // resize ever happens during this beacon's run (the common case, oculist-il11), the listener
    // would otherwise outlive it, leaked on window forever and keeping backWrap reachable after
    // it's already been removed. Explicitly remove it once backWrap has finished on its own
    // (natural completion) or been cancelled (destroyBeacon() calls .cancel() on every
    // __waapiAnims entry, which settles this promise immediately) -- this covers both paths
    // hardCutBackWrap()'s own early removeEventListener does not reach, same technique
    // hardCutArrowShot()/hardCutVineSwing() already use.
    Promise.allSettled(backWrapAnims.map(function (a) { return a.finished; })).then(function () {
      window.removeEventListener('resize', hardCutBackWrap);
    });

    wrap.__waapiAnims = wrapAnims;
    Promise.allSettled(wrapAnims.map(function (a) { return a.finished; })).then(function () { wrap.remove(); });
  }


  // oculist-nq1x.11: promotes fxArrowShot (artifacts/prototypes/effects-playground.html) into
  // the shipped beacon contract, the tenth entry in the Halloween pack. An archer -- a leather
  // bycocket hat with a red feather, Robin Hood's own signature (clean folklore, not one of the
  // epic's three trademarked figures; Chris has explicitly overruled the generic-figure default
  // for this one, label stays 'Arrow Shot') -- dissolves in at a viewport edge, draws and looses
  // an arrow that arcs to the match, and concentric target rings bloom around the impact point
  // as the arrow lands and quivers.
  //
  // RULE 9 EXCEPTION, DECIDED 2026-09-23 (oculist-i8zu, oculist-nq1x.11's own RULE 9 DECIDED
  // note): the shipped lastMouseX/find-bar/viewport start-point cascade animateTrail uses is
  // deliberately NOT used here. The arrow launches from the archer's fixed grip
  // (launchX/launchYTop/launchYBottom below, effects-playground.html:4590-4592) -- the archer's
  // own placement and the impact-plan chooser (oculist-aouc, oculist-q4nl) are what keep the
  // flight and strike clear of the match (rule 10); a cursor or find-bar origin would bypass
  // them entirely. Rule 9's other half -- the mirrored branch (top-left vs bottom-left corner)
  // must work for real, not just compile -- still applies and is tested below.
  //
  // THE IMPACT-PLAN CHOOSER is the most load-bearing, least obvious part of this effect's
  // geometry, and is ported near byte-for-byte rather than re-derived -- every prototype bead
  // that hardened it is closed and its beats must not come back:
  //   - oculist-1ta.11: STRIKE_GAP's rest-point inset caught the quiver rotating the arrowhead's
  //     back corners into the match at some font sizes even under a nominally horizontal plan.
  //   - oculist-1ta.15 / oculist-uxa0: STRIKE_GAP is exactly 8, "one pixel above a cliff" --
  //     7 fails by 1px at font sizes 25-26 at a wide 1280x900 viewport. Never round this.
  //   - oculist-1ta.9: the archer's corner (top-left vs bottom-left) is proven stable across
  //     repeated fires on the same match by a closed-form margin (3.1-6.7px across all 46
  //     left-plan scenarios), not by a runtime guard -- tested below by firing twice.
  //   - oculist-aouc: the FORCED-LANDING fallback (when no plan clears MARGIN on any axis) is
  //     guarded by a real painted-shape overlap oracle (paintShapeClear/paintedArcherClear/
  //     paintedFlightClear below), not a bounding-box guess, with a capped push loop so the
  //     flight can never reverse.
  //   - oculist-q4nl: the fallback additionally computes a BASELINE (main's own fallback) and a
  //     CANDIDATE (a whole-body archer clamp) and only takes the candidate when it is STRICTLY
  //     better for the archer and NO WORSE for the flight, and never turns a forward flight
  //     backward -- see the SELECT block's own comment below for why that guarantees zero
  //     regressions rather than merely measuring zero.
  //   - oculist-1ta.16: the occlusion-sweep harness itself needed the 1280x900 viewport and font
  //     sizes 22-26 added to its own coverage before it could see the oculist-1ta.11/uxa0 defects
  //     at all -- recorded here as a reminder that a narrow re-sweep after any future change can
  //     silently miss this effect's own worst cases.
  // A "cleanup" of any formula, constant or branch in this block is a regression, not an
  // improvement -- re-run the occlusion sweep in artifacts/prototypes/occlusion-sweep.js
  // (arrowshot) after touching any of it, the same instruction fxArrowShot's own STRIKE_GAP
  // comment gives.
  //
  // MEASURED (test/arrowshot_effect.test.js's own 'forced fallback' mutation-proof note):
  // oculist-q4nl's own candidate is independently load-bearing (proven red by mutation) on every
  // forced-fallback fixture this suite could construct; oculist-aouc's own push loop still runs
  // and its result still feeds the BASELINE-vs-CANDIDATE comparison, but no fixture within reach
  // isolated it as the SOLE guard -- moving the archer (the candidate's own fix) also moves the
  // flight's own launch point, which incidentally satisfies the push loop's own gate before it
  // ever needs to run. Recorded here so a future change doesn't read aouc's push as provably dead
  // code and remove it: it is exercised, just redundant with q4nl's later fix in every case
  // measured so far.
  //
  // THE BYCOCKET/FEATHER GEOMETRY (oculist-1ta.17 through .20) is ported exactly as it reads at
  // the 78px floor after four rounds of on-page measurement -- do not redraw it from the
  // reference art or "simplify" the hat/feather path data.
  //
  // FORCED-FALLBACK COVERAGE: test/arrowshot-forced-below.check.js (oculist-c6pk) already proves
  // the PROTOTYPE's own painted silhouette clears the forced-below-1 scenario via the canonical
  // occlusion-sweep sampler; it is not duplicated here. This suite instead proves the SHIPPED
  // port's own fallback geometry directly against the live DOM (see 'forced fallback' below).
  //
  // Fixed identity palette (rule 6's own license, "the pumpkin's orange"): every archer/arrow/
  // target-ring tone below is a fixed literal, like Vampire Bat's BAT_* or Fairy Cast's AMBER --
  // there is no separate flash/UI-accent element here for getEffectiveColors().beacon to drive.
  // getEffectiveColors().beacon is deliberately never read below.
  //
  // Lite Mode (rule 7): a no-op. There is no filter, no box-shadow and no decorative glow layer
  // anywhere in this effect's shipped art -- the cel-shaded tones ARE the character art, the
  // draw-hold-release-flight-strike sequence is the one continuous beat this effect has (nothing
  // to thin out without cutting the effect itself), and the target rings are a single scale/
  // opacity entrance with no per-ring flicker. Same reasoning Vampire Bat's/Fairy Cast's own header
  // comments give for themselves. settings.performanceMode is deliberately never read below.
  //
  // RESIZE (measured, not assumed): fxArrowShot's own prototype has no resize listener and no
  // clip-path keyhole to port (unlike Fairy Cast's oculist-3dd8) -- but every element here is
  // positioned once, at fire time, from the pre-resize rect, and the target rings in particular
  // stand only STRIKE_GAP/padIn clear of #match's own fire-time edges. Measured directly, not
  // assumed clean by analogy to Vampire Bat's own looser-clearance figure: test/arrowshot_
  // effect.test.js's own 'resize mid-flight' test (a #resizeTarget fixture that reflows #match
  // ~8px horizontally on a 16px viewport-width change, frozen mid-quiver) showed a real nonzero
  // painted-pixel delta before the hard cut below existed -- content.js's own handleResize() only
  // reaches cancelBeacons() via repositionActiveOverlays() after a 100ms debounce a continuous
  // resize drag keeps resetting, the same window oculist-3dd8 closed for Fairy Cast. Ported the
  // same technique here (hardCutArrowShot below), applied to all three top-level elements instead
  // of one clip mask, and the resize test now passes clean.
  function animateArrowShot(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;

    var NS = 'http://www.w3.org/2000/svg';
    var r = rect; // viewport space (rule 2) -- kept as `r` to match the ported geometry below
    var vw = window.innerWidth, vh = window.innerHeight;
    var mcx = r.left + r.width / 2, mcy = r.top + r.height / 2;

    var beaconScale = getBeaconScale();
    var durFactor = getBeaconDuration(1);
    var SCROLL_X = window.scrollX, SCROLL_Y = window.scrollY;

    var INSET = 40;
    // See the header comment above (oculist-1ta.15/uxa0): exactly 8, do not round.
    var STRIKE_GAP = 8;
    // Fixed local-unit viewBox for the flight arrow (unchanged from the prototype); ARROW_LEN/
    // ARROW_H below are the PHYSICAL rendered footprint (rule 6: size through getBeaconScale()),
    // arrowScale is the local-unit-to-physical-px ratio the painted-shape oracle needs.
    var ARROW_VB_W = 58, ARROW_VB_H = 26;
    var arrowScale = beaconScale;
    var ARROW_LEN = ARROW_VB_W * arrowScale, ARROW_H = ARROW_VB_H * arrowScale;
    var VB_W = 108, VB_H = 114;

    // Archer sizing is corner-independent (a function of the match's own height only), computed
    // here because the plan chooser below needs the grip's real screen offset before any corner
    // is picked.
    var archerH = Math.max(78, Math.min(112, 3.2 * r.height)) * beaconScale;
    var archerW = archerH * (VB_W / VB_H);
    var GRIP_LOCAL = { x: 100, y: 54 };
    var scaleX = archerW / VB_W, scaleY = archerH / VB_H;
    // Both left-side corners share x:INSET, so the launch point's x is identical either way;
    // only y depends on which corner is picked.
    var launchX = INSET + GRIP_LOCAL.x * scaleX;
    var launchYTop = INSET + GRIP_LOCAL.y * scaleY;
    var launchYBottom = (vh - INSET - archerH) + GRIP_LOCAL.y * scaleY;

    // ── Impact-plan chooser (oculist-aouc, oculist-q4nl) ────────────────────────────────────
    var MARGIN = ARROW_LEN + 8;
    var FEATHER_OVERFLOW_LOCAL = 36.63 + 1.5;

    function flightBoxGapAtT(t, lx, ly, ex, ey) {
      var fdist = Math.hypot(ex - lx, ey - ly);
      var fMidX = (lx + ex) / 2, fMidY = (ly + ey) / 2;
      var fArcH = Math.max(30, Math.min(70, fdist * 0.12));
      var fCtrlX = fMidX, fCtrlY = fMidY - fArcH;
      var omt = 1 - t;
      var px = omt * omt * lx + 2 * omt * t * fCtrlX + t * t * ex;
      var py = omt * omt * ly + 2 * omt * t * fCtrlY + t * t * ey;
      var tx = 2 * omt * (fCtrlX - lx) + 2 * t * (ex - fCtrlX);
      var ty = 2 * omt * (fCtrlY - ly) + 2 * t * (ey - fCtrlY);
      var ang = Math.atan2(ty, tx);
      var cosA = Math.cos(ang), sinA = Math.sin(ang);
      var corners = [
        [-ARROW_LEN, -ARROW_H / 2], [-ARROW_LEN, ARROW_H / 2],
        [0, -ARROW_H / 2], [0, ARROW_H / 2]
      ];
      var boxLeft = Infinity, boxRight = -Infinity, boxTop = Infinity, boxBottom = -Infinity;
      for (var c = 0; c < corners.length; c++) {
        var wx = px + corners[c][0] * cosA - corners[c][1] * sinA;
        var wy = py + corners[c][0] * sinA + corners[c][1] * cosA;
        if (wx < boxLeft) boxLeft = wx;
        if (wx > boxRight) boxRight = wx;
        if (wy < boxTop) boxTop = wy;
        if (wy > boxBottom) boxBottom = wy;
      }
      var dxGap = Math.max(r.left - boxRight, boxLeft - r.right, 0);
      var dyGap = Math.max(r.top - boxBottom, boxTop - r.bottom, 0);
      if (dxGap > 0 || dyGap > 0) return Math.hypot(dxGap, dyGap);
      var overlapX = Math.min(boxRight, r.right) - Math.max(boxLeft, r.left);
      var overlapY = Math.min(boxBottom, r.bottom) - Math.max(boxTop, r.top);
      return -Math.min(overlapX, overlapY);
    }

    function sampledFlightClearance(lx, ly, ex, ey) {
      var minGap = Infinity;
      var SAMPLES = 240;
      for (var i = 0; i <= SAMPLES; i++) {
        var gap = flightBoxGapAtT(i / SAMPLES, lx, ly, ex, ey);
        if (gap < minGap) minGap = gap;
      }
      return minGap;
    }

    function launchClearance(lx, ly, ex, ey) {
      return flightBoxGapAtT(0, lx, ly, ex, ey);
    }

    var QUIVER_MIN_DEG = -10, QUIVER_MAX_DEG = 14;

    function quiverBoxGapAtDeg(deg, lx, ly, ex, ey) {
      var fdist = Math.hypot(ex - lx, ey - ly);
      var fMidX = (lx + ex) / 2, fMidY = (ly + ey) / 2;
      var fArcH = Math.max(30, Math.min(70, fdist * 0.12));
      var fCtrlX = fMidX, fCtrlY = fMidY - fArcH;
      var tx = 2 * (ex - fCtrlX), ty = 2 * (ey - fCtrlY);
      var ang = Math.atan2(ty, tx) + deg * Math.PI / 180;
      var cosA = Math.cos(ang), sinA = Math.sin(ang);
      var corners = [
        [-ARROW_LEN, -ARROW_H / 2], [-ARROW_LEN, ARROW_H / 2],
        [0, -ARROW_H / 2], [0, ARROW_H / 2]
      ];
      var boxLeft = Infinity, boxRight = -Infinity, boxTop = Infinity, boxBottom = -Infinity;
      for (var c = 0; c < corners.length; c++) {
        var wx = ex + corners[c][0] * cosA - corners[c][1] * sinA;
        var wy = ey + corners[c][0] * sinA + corners[c][1] * cosA;
        if (wx < boxLeft) boxLeft = wx;
        if (wx > boxRight) boxRight = wx;
        if (wy < boxTop) boxTop = wy;
        if (wy > boxBottom) boxBottom = wy;
      }
      var dxGap = Math.max(r.left - boxRight, boxLeft - r.right, 0);
      var dyGap = Math.max(r.top - boxBottom, boxTop - r.bottom, 0);
      if (dxGap > 0 || dyGap > 0) return Math.hypot(dxGap, dyGap);
      var overlapX = Math.min(boxRight, r.right) - Math.max(boxLeft, r.left);
      var overlapY = Math.min(boxBottom, r.bottom) - Math.max(boxTop, r.top);
      return -Math.min(overlapX, overlapY);
    }

    function sampledQuiverClearance(lx, ly, ex, ey) {
      var minGap = Infinity;
      var QUIVER_SAMPLES = 96;
      for (var i = 0; i <= QUIVER_SAMPLES; i++) {
        var deg = QUIVER_MIN_DEG + (QUIVER_MAX_DEG - QUIVER_MIN_DEG) * (i / QUIVER_SAMPLES);
        var gap = quiverBoxGapAtDeg(deg, lx, ly, ex, ey);
        if (gap < minGap) minGap = gap;
      }
      return minGap;
    }

    // ── Painted-shape overlap oracle (oculist-aouc RUN 7) ───────────────────────────────────
    function paintPtRect(x, y, rr) {
      var dx = Math.max(rr.left - x, x - rr.right, 0), dy = Math.max(rr.top - y, y - rr.bottom, 0);
      return Math.hypot(dx, dy);
    }
    function paintPtSeg(px, py, ax, ay, bx, by) {
      var vx = bx - ax, vy = by - ay;
      var L = vx * vx + vy * vy;
      var t = L ? ((px - ax) * vx + (py - ay) * vy) / L : 0;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(px - ax - t * vx, py - ay - t * vy);
    }
    function paintCross(ax, ay, bx, by, cx, cy) { return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax); }
    function paintSegInter(ax, ay, bx, by, cx, cy, dx, dy) {
      var d1 = paintCross(cx, cy, dx, dy, ax, ay), d2 = paintCross(cx, cy, dx, dy, bx, by);
      var d3 = paintCross(ax, ay, bx, by, cx, cy), d4 = paintCross(ax, ay, bx, by, dx, dy);
      return (d1 > 0) !== (d2 > 0) && (d3 > 0) !== (d4 > 0);
    }
    function paintSegRectDist(ax, ay, bx, by, rr) {
      function inside(x, y) { return x >= rr.left && x <= rr.right && y >= rr.top && y <= rr.bottom; }
      if (inside(ax, ay) || inside(bx, by)) return 0;
      var edges = [
        [rr.left, rr.top, rr.right, rr.top], [rr.right, rr.top, rr.right, rr.bottom],
        [rr.right, rr.bottom, rr.left, rr.bottom], [rr.left, rr.bottom, rr.left, rr.top]
      ];
      for (var e = 0; e < edges.length; e++) {
        if (paintSegInter(ax, ay, bx, by, edges[e][0], edges[e][1], edges[e][2], edges[e][3])) return 0;
      }
      var m = Math.min(paintPtRect(ax, ay, rr), paintPtRect(bx, by, rr));
      var corners = [[rr.left, rr.top], [rr.right, rr.top], [rr.left, rr.bottom], [rr.right, rr.bottom]];
      for (var c = 0; c < corners.length; c++) {
        m = Math.min(m, paintPtSeg(corners[c][0], corners[c][1], ax, ay, bx, by));
      }
      return m;
    }
    function paintPtInPoly(x, y, P) {
      var inPoly = false;
      for (var i = 0, j = P.length - 1; i < P.length; j = i++) {
        var xi = P[i][0], yi = P[i][1], xj = P[j][0], yj = P[j][1];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inPoly = !inPoly;
      }
      return inPoly;
    }
    function paintSatPen(P, rr) {
      var axes = [[1, 0], [0, 1]];
      for (var i = 0; i < P.length; i++) {
        var j = (i + 1) % P.length;
        var ex = P[j][0] - P[i][0], ey = P[j][1] - P[i][1];
        var L = Math.hypot(ex, ey);
        if (L > 1e-9) axes.push([-ey / L, ex / L]);
      }
      var rectCorners = [[rr.left, rr.top], [rr.right, rr.top], [rr.left, rr.bottom], [rr.right, rr.bottom]];
      var pen = Infinity;
      for (var a = 0; a < axes.length; a++) {
        var nx = axes[a][0], ny = axes[a][1];
        var a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
        for (var p = 0; p < P.length; p++) {
          var proj = P[p][0] * nx + P[p][1] * ny;
          if (proj < a0) a0 = proj;
          if (proj > a1) a1 = proj;
        }
        for (var rc = 0; rc < rectCorners.length; rc++) {
          var projR = rectCorners[rc][0] * nx + rectCorners[rc][1] * ny;
          if (projR < b0) b0 = projR;
          if (projR > b1) b1 = projR;
        }
        pen = Math.min(pen, Math.min(a1, b1) - Math.max(a0, b0));
      }
      return pen;
    }
    function paintShapeClear(pts, closed, rad, rr) {
      var d = Infinity;
      var n = pts.length;
      var segs = closed ? n : n - 1;
      for (var i = 0; i < segs; i++) {
        var a = pts[i], b = pts[(i + 1) % n];
        d = Math.min(d, paintSegRectDist(a[0], a[1], b[0], b[1], rr));
        if (d === 0) break;
      }
      if (d > 0 && closed && paintPtInPoly((rr.left + rr.right) / 2, (rr.top + rr.bottom) / 2, pts)) d = 0;
      if (d > 0) return d - rad;
      var pen;
      if (closed) {
        pen = paintSatPen(pts, rr);
      } else {
        pen = 0;
        for (var s = 0; s < n - 1; s++) pen = Math.max(pen, paintSatPen([pts[s], pts[s + 1]], rr));
      }
      return -Math.max(pen, 0) - rad;
    }

    function paintEllPts(cx, cy, rx, ry, N) {
      var o = [];
      for (var i = 0; i < N; i++) {
        var a = (2 * Math.PI * i) / N;
        o.push([cx + (rx * Math.cos(a)) / Math.cos(Math.PI / N), cy + (ry * Math.sin(a)) / Math.cos(Math.PI / N)]);
      }
      return o;
    }
    var ARCHER_PAINT = [
      [[[3, 107], [17, 104], [23, 108], [19, 114], [2, 114]], true, 1.5, true],
      [[[49, 105], [59, 108], [66, 111], [65, 114], [48, 114], [44, 109]], true, 1.5, true],
      [[[20, 84], [31, 87], [18, 106], [7, 108]], true, 2, true],
      [[[36, 87], [47, 84], [58, 107], [47, 109]], true, 2, true],
      [[[18, 55], [50, 55], [54, 88], [41, 91], [27, 91], [14, 87]], true, 2, true],
      [[[21, 47], [46, 47], [51, 56], [18, 56]], true, 2, true],
      [[[29, 39], [41, 39], [41, 50], [29, 50]], true, 1.5, true],
      [[[62, 16], [56, 22], [64, 31], [73, 43], [60, 54], [73, 65], [64, 77], [56, 86], [62, 92]], false, 6, false],
      [[[57, 49], [63, 49], [63, 59], [57, 59]], true, 1, false],
      [[[62, 16], [58, 54], [62, 92]], false, 1.6, false],
      [[[62, 16], [34, 50], [62, 92]], false, 1.6, false],
      [[[44, 56], [51, 53], [51, 61], [44, 63]], true, 1.8, true],
      [[[51, 53], [62, 51], [62, 58], [51, 61]], true, 1.8, true],
      [[[20, 55], [8, 59], [1, 54], [5, 45], [23, 49]], true, 1.8, true],
      [[[1, 54], [5, 45], [12, 41], [30, 47], [34, 48], [34, 54]], true, 1.5, true],
      [paintEllPts(60, 54, 4, 4, 24), true, 1.5, false],
      [paintEllPts(34, 50, 4, 4, 24), true, 1.5, false],
      [[[19, 36], [21, 25], [24, 18], [35, 15], [46, 18], [49, 25], [46, 37], [41, 45], [25, 47]], true, 2, true],
      [[[26, 35], [28, 20], [38, 16], [45, 21], [49, 27], [50, 32], [46, 34], [45, 40], [36, 44], [28, 42]], true, 2, true],
      [[[14, 20], [28, 20], [18, 14], [5, 12]], true, 2, true],
      [[[26, 19], [50, 18], [60, 27], [45, 27]], true, 2, true],
      [[[14, 20], [17, 9], [30, 7], [43, 8], [49, 19]], true, 2, true],
      [[[18, 16], [10, 5], [1, 2], [5, 15], [16, 20]], true, 1.5, true]
    ];
    for (var archerDx = 0; archerDx >= -24; archerDx -= 24) {
      ARCHER_PAINT.push([[[58 + archerDx, 54], [92 + archerDx, 54]], false, 2.4, false]);
      ARCHER_PAINT.push([[[92 + archerDx, 50], [100 + archerDx, 54], [92 + archerDx, 58]], true, 1, false]);
      ARCHER_PAINT.push([[[60 + archerDx, 54], [50 + archerDx, 47], [56 + archerDx, 54]], true, 1, false]);
      ARCHER_PAINT.push([[[60 + archerDx, 54], [50 + archerDx, 61], [56 + archerDx, 54]], true, 1, false]);
    }
    function paintedArcherClear(archerTopVal) {
      var s = archerH / VB_H;
      var m = Infinity;
      for (var i = 0; i < ARCHER_PAINT.length; i++) {
        var shape = ARCHER_PAINT[i];
        var pts = shape[0].map(function (pt) { return [INSET + pt[0] * s, archerTopVal + pt[1] * s]; });
        var rad = shape[3] ? shape[2] / 2 : (shape[2] * s) / 2;
        m = Math.min(m, paintShapeClear(pts, shape[1], rad, r));
      }
      return m;
    }

    var FEATHER_HAT_PAINT = [
      [[[14, 20], [28, 20], [18, 14], [5, 12]], true, 2],
      [[[26, 19], [50, 18], [60, 27], [45, 27]], true, 2],
      [[[14, 20], [17, 9], [30, 7], [43, 8], [49, 19]], true, 2],
      [[[18, 16], [10, 5], [1, 2], [5, 15], [16, 20]], true, 1.5]
    ];
    function paintedFeatherHatClear(archerTopVal) {
      var s = archerH / VB_H;
      var m = Infinity;
      for (var i = 0; i < FEATHER_HAT_PAINT.length; i++) {
        var shape = FEATHER_HAT_PAINT[i];
        var pts = shape[0].map(function (pt) { return [INSET + pt[0] * s, archerTopVal + pt[1] * s]; });
        m = Math.min(m, paintShapeClear(pts, shape[1], shape[2] / 2, r));
        if (m <= 0) return m;
      }
      return m;
    }

    // Local-unit points (relative to the arrow's own anchor at (ARROW_VB_W, ARROW_VB_H/2), i.e.
    // (58,13)); scaled by arrowScale wherever they're actually used below, mirroring how
    // ARCHER_PAINT's own points get scaled by `s` above.
    var ARROW_PAINT = [
      [[[4, 11], [48, 11], [48, 15], [4, 15]], 0.3],
      [[[48, 6], [58, 13], [48, 20]], 0.5],
      [[[14, 13], [1, 1], [9, 13]], 0.5],
      [[[14, 13], [1, 25], [9, 13]], 0.5]
    ].map(function (shape) {
      return [shape[0].map(function (pt) { return [pt[0] - ARROW_VB_W, pt[1] - ARROW_VB_H / 2]; }), shape[1]];
    });
    // `best` seeds an early-out via a true lower bound (any painted shape here is at most
    // 61*arrowScale from (px,py)); the per-shape exit right after only fires when !exhaustive.
    function paintedArrowAt(px, py, ang, best, exhaustive) {
      var farGap = paintPtRect(px, py, r);
      var REACH = 61 * arrowScale;
      if (farGap > REACH && farGap - REACH > best) return best;
      var cosA = Math.cos(ang), sinA = Math.sin(ang);
      var m = best;
      for (var i = 0; i < ARROW_PAINT.length; i++) {
        var shape = ARROW_PAINT[i];
        var pts = shape[0].map(function (pt) {
          var lx = pt[0] * arrowScale, ly = pt[1] * arrowScale;
          return [px + lx * cosA - ly * sinA, py + lx * sinA + ly * cosA];
        });
        m = Math.min(m, paintShapeClear(pts, true, shape[1] * arrowScale, r));
        if (!exhaustive && m <= 0) return m;
      }
      return m;
    }
    function paintedFlightClear(lx, ly, ex, ey, exhaustive, N, Q) {
      var d = Math.hypot(ex - lx, ey - ly);
      var mx = (lx + ex) / 2, my = (ly + ey) / 2;
      var arcH = Math.max(30, Math.min(70, d * 0.12));
      var cx = mx, cy = my - arcH;
      var m = Infinity;
      var SAMPLES = N || 240;
      for (var i = 0; i <= SAMPLES; i++) {
        var t = i / SAMPLES, u = 1 - t;
        var px = u * u * lx + 2 * u * t * cx + t * t * ex;
        var py = u * u * ly + 2 * u * t * cy + t * t * ey;
        var tx = 2 * u * (cx - lx) + 2 * t * (ex - cx);
        var ty = 2 * u * (cy - ly) + 2 * t * (ey - cy);
        m = paintedArrowAt(px, py, Math.atan2(ty, tx), m, exhaustive);
        if (!exhaustive && m <= 0) return m;
      }
      var baseAng = Math.atan2(2 * (ey - cy), 2 * (ex - cx));
      var QUIVER_SAMPLES = Q || 96;
      for (var q = 0; q <= QUIVER_SAMPLES; q++) {
        var deg = QUIVER_MIN_DEG + (QUIVER_MAX_DEG - QUIVER_MIN_DEG) * (q / QUIVER_SAMPLES);
        m = paintedArrowAt(ex, ey, baseAng + (deg * Math.PI) / 180, m, exhaustive);
        if (!exhaustive && m <= 0) return m;
      }
      return m;
    }

    var leftEndX = r.left - STRIKE_GAP, leftEndY = mcy;
    var topEndX = mcx, topEndY = r.top - STRIKE_GAP;
    var bottomEndX = mcx, bottomEndY = r.bottom + STRIKE_GAP;
    var leftDx = leftEndX - launchX;
    var topDy = topEndY - launchYTop;
    var bottomDy = launchYBottom - bottomEndY;

    var plan, corner, endX, endY;
    var archerYAdjust = 0;
    if (leftDx > MARGIN) {
      plan = 'left'; endX = leftEndX; endY = leftEndY;
      corner = Math.abs(leftEndY - launchYTop) <= Math.abs(leftEndY - launchYBottom) ? 'top-left' : 'bottom-left';
    } else if (topDy > MARGIN) {
      plan = 'top'; corner = 'top-left'; endX = topEndX; endY = topEndY;
    } else if (bottomDy > MARGIN) {
      plan = 'bottom'; corner = 'bottom-left'; endX = bottomEndX; endY = bottomEndY;
    } else {
      if (leftDx >= topDy && leftDx >= bottomDy) {
        plan = 'left'; corner = 'top-left'; endX = leftEndX; endY = leftEndY;
      } else if (topDy >= bottomDy) {
        plan = 'top'; corner = 'top-left'; endX = topEndX; endY = topEndY;
      } else {
        plan = 'bottom'; corner = 'bottom-left'; endX = bottomEndX; endY = bottomEndY;
      }

      var nominalArcherTop = corner === 'top-left' ? INSET : (vh - INSET - archerH);
      var nominalArcherClear = paintedArcherClear(nominalArcherTop);
      var archerOverlap = nominalArcherClear <= 0;
      var endX0 = endX, endY0 = endY;
      var nominalLaunchYForCorner = corner === 'top-left' ? launchYTop : launchYBottom;

      function pushFlightIfNeeded(archerYAdjustIn, gateLaunchY) {
        var fbLaunchY = nominalLaunchYForCorner + archerYAdjustIn;
        var endX = endX0, endY = endY0;
        var paintedFlightOverlapHere = paintedFlightClear(launchX, gateLaunchY, endX, endY) <= 0;
        if (paintedFlightOverlapHere) {
          var SAMPLE_SLOP = 4;
          var unpushedPaintedFlightClear = paintedFlightClear(launchX, fbLaunchY, endX, endY);
          var forwardOfLaunch =
            plan === 'left' ? leftEndX > launchX :
            plan === 'top' ? topEndY > fbLaunchY :
            bottomEndY < fbLaunchY;
          if (forwardOfLaunch && launchClearance(launchX, fbLaunchY, endX, endY) >= MARGIN + SAMPLE_SLOP) {
            var pushed = 0;
            var bestEndX = endX, bestEndY = endY, bestGap = -Infinity;
            var capped = false;
            var prevGap = -Infinity;
            for (var guard = 0; guard < 40; guard++) {
              var gap = Math.min(
                launchClearance(launchX, fbLaunchY, endX, endY),
                sampledFlightClearance(launchX, fbLaunchY, endX, endY),
                sampledQuiverClearance(launchX, fbLaunchY, endX, endY)
              );
              if (gap > bestGap) { bestGap = gap; bestEndX = endX; bestEndY = endY; }
              if (gap >= MARGIN + SAMPLE_SLOP) break;
              if (capped) break;
              if (gap <= prevGap) break;
              prevGap = gap;
              pushed += (MARGIN + SAMPLE_SLOP - gap) + SAMPLE_SLOP;
              if (plan === 'left') {
                endX = leftEndX - pushed;
                var floorX = Math.min(launchX + STRIKE_GAP, leftEndX);
                if (endX < floorX) { endX = floorX; capped = true; }
              } else if (plan === 'top') {
                endY = topEndY - pushed;
                var floorY = Math.min(fbLaunchY + STRIKE_GAP, topEndY);
                if (endY < floorY) { endY = floorY; capped = true; }
              } else {
                endY = bottomEndY + pushed;
                var ceilY = Math.max(fbLaunchY - STRIKE_GAP, bottomEndY);
                if (endY > ceilY) { endY = ceilY; capped = true; }
              }
            }
            if (bestGap < MARGIN + SAMPLE_SLOP) { endX = bestEndX; endY = bestEndY; }
          }
          if (paintedFlightClear(launchX, fbLaunchY, endX, endY) < unpushedPaintedFlightClear) {
            endX = plan === 'left' ? leftEndX : (plan === 'top' ? topEndX : bottomEndX);
            endY = plan === 'left' ? leftEndY : (plan === 'top' ? topEndY : bottomEndY);
          }
        }
        return { endX: endX, endY: endY };
      }

      var archerYAdjustBase = 0;
      var paintedFeatherHatOverlapBase = corner === 'bottom-left' && paintedFeatherHatClear(nominalArcherTop) <= 0;
      if (paintedFeatherHatOverlapBase) {
        var nominalFeatherTop = nominalArcherTop - FEATHER_OVERFLOW_LOCAL * scaleY;
        var archerGapBase = nominalFeatherTop - r.bottom;
        if (archerGapBase < MARGIN) archerYAdjustBase = MARGIN - archerGapBase;
      }
      var pushedBase = pushFlightIfNeeded(archerYAdjustBase, nominalLaunchYForCorner);
      var endXBase = pushedBase.endX, endYBase = pushedBase.endY;
      var launchYBase = nominalLaunchYForCorner + archerYAdjustBase;

      var archerClearBase = paintedArcherClear(nominalArcherTop + archerYAdjustBase);
      var baselineOverlap = archerClearBase <= 0 ||
        paintedFlightClear(launchX, launchYBase, endXBase, endYBase) <= 0;

      var archerYAdjustCand = 0;
      if (archerOverlap || baselineOverlap) {
        var aboveCandidate = r.top - STRIKE_GAP - archerH;
        var belowCandidate = r.bottom + STRIKE_GAP + FEATHER_OVERFLOW_LOCAL * scaleY;
        var aboveFits = aboveCandidate >= 0 && aboveCandidate + archerH <= vh;
        var belowFits = belowCandidate >= 0 && belowCandidate + archerH <= vh;
        var nearerCandidate =
          Math.abs(aboveCandidate - nominalArcherTop) <= Math.abs(belowCandidate - nominalArcherTop)
            ? aboveCandidate : belowCandidate;
        var chosenTop;
        if (aboveFits && belowFits) chosenTop = nearerCandidate;
        else if (aboveFits) chosenTop = aboveCandidate;
        else if (belowFits) chosenTop = belowCandidate;
        else chosenTop = nearerCandidate;
        var candidateAdjust = chosenTop - nominalArcherTop;
        if (paintedArcherClear(nominalArcherTop + candidateAdjust) > nominalArcherClear) {
          archerYAdjustCand = candidateAdjust;
        }
      }
      var archerClearCand = paintedArcherClear(nominalArcherTop + archerYAdjustCand);

      function forwardSign(ex, ey, ly) {
        return plan === 'left' ? Math.sign(ex - launchX) : plan === 'top' ? Math.sign(ey - ly) : -Math.sign(ey - ly);
      }
      var takeCandidate = false;
      var endXCand, endYCand, launchYCand;
      if (baselineOverlap && archerClearCand > archerClearBase) {
        var pushedCand = pushFlightIfNeeded(archerYAdjustCand, nominalLaunchYForCorner + archerYAdjustCand);
        endXCand = pushedCand.endX; endYCand = pushedCand.endY;
        launchYCand = nominalLaunchYForCorner + archerYAdjustCand;
        var flightClearBase = paintedFlightClear(launchX, launchYBase, endXBase, endYBase, true, 480, 96);
        var flightClearCand = paintedFlightClear(launchX, launchYCand, endXCand, endYCand, true, 480, 96);
        var newlyBackward =
          forwardSign(endXBase, endYBase, launchYBase) > 0 &&
          forwardSign(endXCand, endYCand, launchYCand) <= 0;
        takeCandidate = flightClearCand >= flightClearBase && !newlyBackward;
      }

      if (takeCandidate) {
        archerYAdjust = archerYAdjustCand;
        endX = endXCand;
        endY = endYCand;
      } else {
        archerYAdjust = archerYAdjustBase;
        endX = endXBase;
        endY = endYBase;
      }
    }

    var archerLeft = INSET;
    var archerTop = (corner === 'top-left' ? INSET : (vh - INSET - archerH)) + archerYAdjust;
    var launchY = (corner === 'top-left' ? launchYTop : launchYBottom) + archerYAdjust;

    // ── Archer sprite (vector, not pixel-grid) ──────────────────────────────────────────────
    var ARCHER_BODY = '#294b36', ARCHER_BODY_OUTLINE = '#111a13';
    var ARCHER_BODY_HI = '#50765a', ARCHER_BODY_SHADOW = '#173022';
    var LEG_BASE = '#22352b', LEG_OUTLINE = '#0d1510';
    var LEG_HI = '#3f5e49', LEG_SHADOW = '#13231a';
    var BOOT_BASE = '#5a351b', BOOT_OUTLINE = '#1d1007', BOOT_HI = '#8b5b2e', BOOT_SHADOW = '#2b180b';
    var SKIN = '#f2bd78', SKIN_OUTLINE = '#4f2d16';
    var SKIN_HI = '#ffd79b', SKIN_SHADOW = '#b8783d';
    var COLLAR = '#5a351b', COLLAR_OUTLINE = '#1d1007';
    var COLLAR_HI = '#8b5b2e', COLLAR_SHADOW = '#2b180b';
    var IRIS = '#3a2a18';
    var HAT_BASE = '#6f431d', HAT_OUTLINE = '#211205';
    var HAT_HI = '#a9672a', HAT_SHADOW = '#3d230f';
    var FEATHER_COLOR = '#c92f3a', FEATHER_HI = '#ef5b64', FEATHER_OUTLINE = '#410d12';
    var BOW_COLOR = '#8a541f', BOW_HI = '#c18438', BOW_OUTLINE = '#241307';
    var STRING_COLOR = '#1a1a1e';
    var ARROW_SHAFT = '#8a5a2c', ARROW_SHAFT_HI = '#c98f4e', ARROW_SHAFT_SHADOW = '#5c3a1a', ARROW_SHAFT_OUTLINE = '#3a2410';
    var ARROWHEAD_COLOR = '#4b4b52', ARROWHEAD_HI = '#8d8d97', ARROWHEAD_SHADOW = '#222226', ARROWHEAD_OUTLINE = '#0f0f11';
    var FLETCH_COLOR = '#c92f3a', FLETCH_HI = '#ef5b64', FLETCH_SHADOW = '#7e1921', FLETCH_OUTLINE = '#410d12';
    var ARCHER_STROKE = 'stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke;';

    var archerAnims = [];

    var archerWrap = document.createElement('div');
    archerWrap.className = 'oc-beacon oc-beacon-transient';
    archerWrap.setAttribute('data-arrowshot', 'archer');
    archerWrap.setAttribute('data-arrowshot-plan', plan);
    archerWrap.setAttribute('data-arrowshot-corner', corner);
    archerWrap.style.cssText = [
      'position:absolute',
      'left:' + (archerLeft + SCROLL_X) + 'px', 'top:' + (archerTop + SCROLL_Y) + 'px',
      'width:' + archerW + 'px', 'height:' + archerH + 'px',
      'pointer-events:none',
      'z-index:2147483642',
      'opacity:0'
    ].join(';');
    document.documentElement.appendChild(archerWrap);

    var archerSvg = document.createElementNS(NS, 'svg');
    archerSvg.setAttribute('width', String(archerW));
    archerSvg.setAttribute('height', String(archerH));
    archerSvg.setAttribute('viewBox', '0 0 ' + VB_W + ' ' + VB_H);
    archerSvg.style.cssText = 'display:block;overflow:visible;';
    archerWrap.appendChild(archerSvg);

    function addShape(tag, attrs, parent) {
      var el = document.createElementNS(NS, tag);
      for (var k in attrs) el.setAttribute(k, attrs[k]);
      parent.appendChild(el);
      return el;
    }

    var bootLD = 'M 3 107 L 17 104 L 23 108 L 19 114 L 2 114 Z';
    var bootRD = 'M 49 105 L 59 108 L 66 111 L 65 114 L 48 114 L 44 109 Z';
    addShape('path', { d: bootLD, fill: BOOT_BASE, stroke: BOOT_OUTLINE, 'stroke-width': '1', style: ARCHER_STROKE }, archerSvg);
    addShape('path', { d: bootRD, fill: BOOT_BASE, stroke: BOOT_OUTLINE, 'stroke-width': '1', style: ARCHER_STROKE }, archerSvg);
    addShape('polygon', { points: '3,107 17,104 20,106 7,110', fill: BOOT_HI }, archerSvg);
    addShape('polygon', { points: '7,110 20,106 23,108 19,114 13,114', fill: BOOT_BASE }, archerSvg);
    addShape('polygon', { points: '2,114 7,110 13,114', fill: BOOT_SHADOW }, archerSvg);
    addShape('polygon', { points: '49,105 59,108 62,110 47,109', fill: BOOT_HI }, archerSvg);
    addShape('polygon', { points: '47,109 62,110 66,111 65,114 53,114', fill: BOOT_BASE }, archerSvg);
    addShape('polygon', { points: '48,114 47,109 53,114', fill: BOOT_SHADOW }, archerSvg);

    var legLD = 'M 20 84 L 31 87 L 18 106 L 7 108 Z';
    var legRD = 'M 36 87 L 47 84 L 58 107 L 47 109 Z';
    addShape('path', { d: legLD, fill: LEG_BASE, stroke: LEG_OUTLINE, 'stroke-width': '2', style: ARCHER_STROKE }, archerSvg);
    addShape('path', { d: legRD, fill: LEG_BASE, stroke: LEG_OUTLINE, 'stroke-width': '2', style: ARCHER_STROKE }, archerSvg);
    addShape('polygon', { points: '20,84 25,86 13,106 7,108', fill: LEG_HI }, archerSvg);
    addShape('polygon', { points: '25,86 31,87 18,106 13,106', fill: LEG_SHADOW }, archerSvg);
    addShape('polygon', { points: '36,87 41,85 52,107 47,109', fill: LEG_HI }, archerSvg);
    addShape('polygon', { points: '41,85 47,84 58,107 52,107', fill: LEG_SHADOW }, archerSvg);

    var torsoD = 'M 18 55 L 50 55 L 49 80 L 54 88 L 41 91 L 34 84 L 27 91 L 14 87 L 19 79 Z';
    addShape('path', { d: torsoD, fill: ARCHER_BODY, stroke: ARCHER_BODY_OUTLINE, 'stroke-width': '2', style: ARCHER_STROKE }, archerSvg);
    addShape('polygon', { points: '18,55 28,55 27,91 14,87 19,79', fill: ARCHER_BODY_HI }, archerSvg);
    addShape('polygon', { points: '41,55 50,55 49,80 54,88 41,91 34,84', fill: ARCHER_BODY_SHADOW }, archerSvg);
    addShape('rect', { x: '17', y: '78', width: '34', height: '7', rx: '1', fill: COLLAR, stroke: COLLAR_OUTLINE, 'stroke-width': '1.5' }, archerSvg);
    addShape('rect', { x: '31', y: '78.5', width: '7', height: '6', rx: '1', fill: HAT_HI, stroke: COLLAR_OUTLINE, 'stroke-width': '1' }, archerSvg);

    var collarD = 'M 21 47 L 46 47 L 51 56 L 18 56 Z';
    addShape('path', { d: collarD, fill: COLLAR, stroke: COLLAR_OUTLINE, 'stroke-width': '2', style: ARCHER_STROKE }, archerSvg);
    addShape('polygon', { points: '21,47 32,47 27,56 18,56', fill: COLLAR_HI }, archerSvg);
    addShape('polygon', { points: '38,47 46,47 51,56 43,56', fill: COLLAR_SHADOW }, archerSvg);

    addShape('rect', { x: '29', y: '39', width: '12', height: '11', fill: SKIN, stroke: SKIN_OUTLINE, 'stroke-width': '1.5', style: ARCHER_STROKE }, archerSvg);

    var bowD = 'M 62 16 Q 56 22 64 31 Q 73 43 60 54 Q 73 65 64 77 Q 56 86 62 92';
    addShape('path', { d: bowD, stroke: BOW_OUTLINE, 'stroke-width': '6', fill: 'none', 'stroke-linecap': 'round' }, archerSvg);
    addShape('path', { d: bowD, stroke: BOW_COLOR, 'stroke-width': '4', fill: 'none', 'stroke-linecap': 'round' }, archerSvg);
    addShape('path', { d: 'M 61.5 17 Q 57.5 22 64 31 Q 69 40 61 51', stroke: BOW_HI, 'stroke-width': '1.2', fill: 'none', 'stroke-linecap': 'round' }, archerSvg);
    addShape('rect', { x: '57', y: '49', width: '6', height: '10', rx: '2', fill: COLLAR, stroke: BOW_OUTLINE, 'stroke-width': '1' }, archerSvg);
    addShape('line', { x1: '57.5', y1: '52', x2: '62.5', y2: '52', stroke: COLLAR_HI, 'stroke-width': '1' }, archerSvg);
    addShape('line', { x1: '57.5', y1: '56', x2: '62.5', y2: '56', stroke: COLLAR_SHADOW, 'stroke-width': '1' }, archerSvg);

    var stringRest = addShape('path', { d: 'M 62 16 L 58 54 L 62 92', stroke: STRING_COLOR, 'stroke-width': '1.6', fill: 'none', opacity: '1' }, archerSvg);
    var stringDrawn = addShape('path', { d: 'M 62 16 L 34 50 L 62 92', stroke: STRING_COLOR, 'stroke-width': '1.6', fill: 'none', opacity: '0' }, archerSvg);

    var sleeveD = 'M 44 56 L 51 53 L 62 51 L 62 58 L 51 61 L 44 63 Z';
    addShape('path', { d: sleeveD, fill: ARCHER_BODY, stroke: ARCHER_BODY_OUTLINE, 'stroke-width': '1.8', style: ARCHER_STROKE }, archerSvg);
    addShape('polygon', { points: '44,56 51,53 56,52 53,58 45,61', fill: ARCHER_BODY_HI }, archerSvg);
    addShape('polygon', { points: '56,52 62,51 62,58 51,61 53,58', fill: ARCHER_BODY_SHADOW }, archerSvg);
    addShape('rect', { x: '54', y: '50.5', width: '7', height: '9', rx: '1', fill: COLLAR, stroke: COLLAR_OUTLINE, 'stroke-width': '1' }, archerSvg);
    addShape('circle', { cx: '60', cy: '54', r: '4', fill: SKIN, stroke: SKIN_OUTLINE, 'stroke-width': '1.5' }, archerSvg);
    addShape('ellipse', { cx: '58.5', cy: '52.5', rx: '1.6', ry: '1.3', fill: SKIN_HI }, archerSvg);

    var drawSleeveD = 'M 20 55 L 8 59 L 1 54 L 5 45 L 23 49 Z';
    addShape('path', { d: drawSleeveD, fill: ARCHER_BODY, stroke: ARCHER_BODY_OUTLINE, 'stroke-width': '1.8', style: ARCHER_STROKE }, archerSvg);
    addShape('polygon', { points: '5,45 12,41 30,47 34,48 34,54 28,53 11,51 1,54', fill: SKIN, stroke: SKIN_OUTLINE, 'stroke-width': '1.5', style: ARCHER_STROKE }, archerSvg);
    addShape('polygon', { points: '15,42 29,47 28,53 13,51', fill: COLLAR, stroke: COLLAR_OUTLINE, 'stroke-width': '1' }, archerSvg);
    addShape('circle', { cx: '34', cy: '50', r: '4', fill: SKIN, stroke: SKIN_OUTLINE, 'stroke-width': '1.5' }, archerSvg);
    addShape('ellipse', { cx: '33', cy: '48.8', rx: '1.4', ry: '1', fill: SKIN_HI }, archerSvg);

    var nockedArrow = document.createElementNS(NS, 'g');
    archerSvg.appendChild(nockedArrow);
    addShape('line', { x1: '58', y1: '54', x2: '92', y2: '54', stroke: ARROW_SHAFT, 'stroke-width': '2.4' }, nockedArrow);
    addShape('polygon', { points: '92,50 100,54 92,58', fill: ARROWHEAD_COLOR, stroke: ARROWHEAD_OUTLINE, 'stroke-width': '1' }, nockedArrow);
    addShape('polygon', { points: '60,54 50,47 56,54', fill: FLETCH_COLOR, stroke: FLETCH_OUTLINE, 'stroke-width': '1' }, nockedArrow);
    addShape('polygon', { points: '60,54 50,61 56,54', fill: FLETCH_COLOR, stroke: FLETCH_OUTLINE, 'stroke-width': '1' }, nockedArrow);

    var hairD = 'M 21 25 Q 24 18 35 15 Q 46 15 49 25 L 46 37 L 41 45 L 31 43 L 25 47 L 25 40 L 19 36 Z';
    addShape('path', { d: hairD, fill: '#171612', stroke: ARCHER_BODY_OUTLINE, 'stroke-width': '2', style: ARCHER_STROKE }, archerSvg);
    var headD = 'M 28 20 Q 38 16 45 21 L 49 27 L 45 29 L 50 32 L 46 34 Q 45 40 36 44 Q 28 42 26 35 Z';
    addShape('path', { d: headD, fill: SKIN, stroke: SKIN_OUTLINE, 'stroke-width': '2', style: ARCHER_STROKE }, archerSvg);
    addShape('polygon', { points: '28,20 36,18 33,42 28,39 26,35', fill: SKIN_HI }, archerSvg);
    addShape('polygon', { points: '43,21 49,27 45,29 50,32 46,34 45,40 40,42', fill: SKIN_SHADOW }, archerSvg);
    addShape('path', { d: 'M 38 25 Q 42 23 45 26', fill: 'none', stroke: SKIN_OUTLINE, 'stroke-width': '1.4', style: 'stroke-linecap:round;' }, archerSvg);
    addShape('ellipse', { cx: '42', cy: '27', rx: '2.2', ry: '2.6', fill: '#ffffff', stroke: SKIN_OUTLINE, 'stroke-width': '1' }, archerSvg);
    addShape('circle', { cx: '43', cy: '27.5', r: '1.2', fill: IRIS }, archerSvg);
    addShape('path', { d: 'M 43 36 Q 46 37 48 35.5', fill: 'none', stroke: SKIN_OUTLINE, 'stroke-width': '1.2', style: 'stroke-linecap:round;' }, archerSvg);

    var brimBackD = 'M 14 20 L 28 20 L 18 14 L 5 12 Z';
    addShape('path', { d: brimBackD, fill: HAT_BASE, stroke: HAT_OUTLINE, 'stroke-width': '2', style: ARCHER_STROKE }, archerSvg);
    var brimFrontD = 'M 26 19 L 50 18 L 60 27 L 45 27 Z';
    addShape('path', { d: brimFrontD, fill: HAT_HI, stroke: HAT_OUTLINE, 'stroke-width': '2', style: ARCHER_STROKE }, archerSvg);
    var crownD = 'M 14 20 Q 17 7 30 7 Q 43 8 49 19 Z';
    addShape('path', { d: crownD, fill: HAT_BASE, stroke: HAT_OUTLINE, 'stroke-width': '2', style: ARCHER_STROKE }, archerSvg);
    addShape('polygon', { points: '30,7 43,8 49,19 37,19', fill: HAT_SHADOW }, archerSvg);
    addShape('polygon', { points: '14,20 17,10 25,8 24,19', fill: HAT_HI }, archerSvg);
    var featherD = 'M 18 16 L 10 5 L 1 2 L 5 15 L 16 20 Z';
    addShape('path', { d: featherD, fill: FEATHER_COLOR, stroke: FEATHER_OUTLINE, 'stroke-width': '1.5', style: ARCHER_STROKE }, archerSvg);
    addShape('polygon', { points: '1,2 10,5 7,10 3,8', fill: FEATHER_HI }, archerSvg);
    addShape('polygon', { points: '11,13 18,16 16,20 12,17', fill: FLETCH_SHADOW }, archerSvg);

    // ── Flight arrow ─────────────────────────────────────────────────────────────────────────
    var arrowSvg = document.createElementNS(NS, 'svg');
    arrowSvg.setAttribute('width', String(ARROW_LEN));
    arrowSvg.setAttribute('height', String(ARROW_H));
    arrowSvg.setAttribute('viewBox', '0 0 ' + ARROW_VB_W + ' ' + ARROW_VB_H);
    arrowSvg.style.cssText = 'display:block;overflow:visible;';
    addShape('rect', { x: '4', y: '11', width: '44', height: '4', fill: ARROW_SHAFT, stroke: ARROW_SHAFT_OUTLINE, 'stroke-width': '0.6' }, arrowSvg);
    addShape('rect', { x: '4', y: '11', width: '44', height: '1.3', fill: ARROW_SHAFT_HI }, arrowSvg);
    addShape('rect', { x: '4', y: '13.7', width: '44', height: '1.3', fill: ARROW_SHAFT_SHADOW }, arrowSvg);
    var arrowheadD = 'M 48 6 L 58 13 L 48 20 Z';
    addShape('path', { d: arrowheadD, fill: ARROWHEAD_COLOR, stroke: ARROWHEAD_OUTLINE, 'stroke-width': '1' }, arrowSvg);
    var arrowDefs = document.createElementNS(NS, 'defs');
    arrowSvg.insertBefore(arrowDefs, arrowSvg.firstChild);
    // Renamed from the prototype's own retried id (oculist-1ta.11 retry): unique across every id
    // this function and the archer's own addShape() calls mint.
    var arrowheadClip = document.createElementNS(NS, 'clipPath');
    arrowheadClip.setAttribute('id', 'as_arrowhead');
    addShape('path', { d: arrowheadD }, arrowheadClip);
    arrowDefs.appendChild(arrowheadClip);
    addShape('polygon', { points: '48,7 57,13 48,11.5', fill: ARROWHEAD_HI, 'clip-path': 'url(#as_arrowhead)' }, arrowSvg);
    addShape('polygon', { points: '48,19 57,13 48,14.5', fill: ARROWHEAD_SHADOW, 'clip-path': 'url(#as_arrowhead)' }, arrowSvg);
    var fletchTopD = 'M 14 13 L 1 1 L 9 13 Z';
    var fletchBotD = 'M 14 13 L 1 25 L 9 13 Z';
    addShape('path', { d: fletchTopD, fill: FLETCH_COLOR, stroke: FLETCH_OUTLINE, 'stroke-width': '1' }, arrowSvg);
    addShape('path', { d: fletchBotD, fill: FLETCH_COLOR, stroke: FLETCH_OUTLINE, 'stroke-width': '1' }, arrowSvg);
    addShape('polygon', { points: '1,1 9.58,8.92 6.28,8.92', fill: FLETCH_HI }, arrowSvg);
    addShape('polygon', { points: '6.28,8.92 9.58,8.92 11.92,11.08 7.72,11.08', fill: FLETCH_COLOR }, arrowSvg);
    addShape('polygon', { points: '7.72,11.08 11.92,11.08 14,13 9,13', fill: FLETCH_SHADOW }, arrowSvg);
    addShape('polygon', { points: '9,13 14,13 11.92,14.92 7.72,14.92', fill: FLETCH_SHADOW }, arrowSvg);
    addShape('polygon', { points: '7.72,14.92 11.92,14.92 9.58,17.08 6.28,17.08', fill: FLETCH_COLOR }, arrowSvg);
    addShape('polygon', { points: '6.28,17.08 9.58,17.08 1,25', fill: FLETCH_HI }, arrowSvg);

    var dx = endX - launchX, dy = endY - launchY;
    var dist = Math.hypot(dx, dy);
    var midX = (launchX + endX) / 2, midY = (launchY + endY) / 2;
    var ARC_HEIGHT = Math.max(30, Math.min(70, dist * 0.12));
    var ctrlX = midX, ctrlY = midY - ARC_HEIGHT;
    var pathStr = 'M ' + (launchX + SCROLL_X) + ' ' + (launchY + SCROLL_Y) +
      ' Q ' + (ctrlX + SCROLL_X) + ' ' + (ctrlY + SCROLL_Y) +
      ' ' + (endX + SCROLL_X) + ' ' + (endY + SCROLL_Y);

    var arrowAnims = [];

    var flightArrow = document.createElement('div');
    flightArrow.className = 'oc-beacon oc-beacon-transient';
    flightArrow.setAttribute('data-arrowshot', 'arrow');
    flightArrow.style.cssText = [
      'position:absolute',
      'left:0', 'top:0',
      'width:' + ARROW_LEN + 'px', 'height:' + ARROW_H + 'px',
      'pointer-events:none',
      'z-index:2147483642',
      "offset-path:path('" + pathStr + "')", 'offset-anchor:100% 50%', 'offset-rotate:auto',
      'transform-origin:100% 50%',
      'opacity:0'
    ].join(';');
    flightArrow.appendChild(arrowSvg);
    document.documentElement.appendChild(flightArrow);

    // ── Target rings ─────────────────────────────────────────────────────────────────────────
    var SQRT2 = Math.SQRT2;
    var w2 = r.width / 2, h2 = r.height / 2;
    var padIn = 16 * beaconScale, padMid = 32 * beaconScale, padOut = 48 * beaconScale, ringStroke = 8 * beaconScale;
    var rxIn = w2 * SQRT2 + padIn, ryIn = h2 * SQRT2 + padIn;
    var rxMid = w2 * SQRT2 + padMid, ryMid = h2 * SQRT2 + padMid;
    var rxOut = w2 * SQRT2 + padOut, ryOut = h2 * SQRT2 + padOut;
    var boxHalfW = rxOut + ringStroke, boxHalfH = ryOut + ringStroke;
    var targetW = boxHalfW * 2, targetH = boxHalfH * 2;

    var targetAnims = [];

    var targetEl = document.createElement('div');
    targetEl.className = 'oc-beacon oc-beacon-transient';
    targetEl.setAttribute('data-arrowshot', 'target');
    targetEl.style.cssText = [
      'position:absolute',
      'left:' + (mcx - boxHalfW + SCROLL_X) + 'px', 'top:' + (mcy - boxHalfH + SCROLL_Y) + 'px',
      'width:' + targetW + 'px', 'height:' + targetH + 'px',
      'pointer-events:none',
      'z-index:2147483642',
      'opacity:0'
    ].join(';');
    document.documentElement.appendChild(targetEl);

    var targetSvg = document.createElementNS(NS, 'svg');
    targetSvg.setAttribute('width', String(targetW));
    targetSvg.setAttribute('height', String(targetH));
    targetSvg.setAttribute('viewBox', '0 0 ' + targetW + ' ' + targetH);
    targetSvg.style.cssText = 'display:block;overflow:visible;';
    targetEl.appendChild(targetSvg);

    function addRing(rx, ry, color) {
      addShape('ellipse', {
        cx: String(boxHalfW), cy: String(boxHalfH), rx: String(rx), ry: String(ry),
        fill: 'none', stroke: color, 'stroke-width': String(ringStroke)
      }, targetSvg);
    }
    addRing(rxOut, ryOut, '#264893');
    addRing(rxMid, ryMid, '#c62828');
    addRing(rxIn, ryIn, '#e8b93a');

    // ── Timeline ─────────────────────────────────────────────────────────────────────────────
    // Every raw ms constant below stays UNSCALED, used only for offset RATIOS -- rule 6: only
    // the final duration/delay at each .animate() call is multiplied by durFactor.
    var APPEAR_DUR = 200;
    var DRAW_START = 300;
    var DRAW_DUR = 200, HOLD = 130, RELEASE_DUR = 90;
    var DRAW_PHASE = DRAW_DUR + HOLD + RELEASE_DUR;
    var RELEASE_TIME = DRAW_START + DRAW_DUR + HOLD;
    var FLIGHT_DUR = 620;
    var ARRIVAL = RELEASE_TIME + FLIGHT_DUR;
    var QUIVER_DUR = 420;
    var HOLD_AFTER = 200;
    var FADE_OUT_DELAY = ARRIVAL + QUIVER_DUR + HOLD_AFTER;
    var FADE_OUT_DUR = 280;

    // Beat 1: archer dissolves in.
    archerAnims.push(archerWrap.animate([
      { opacity: 0 },
      { opacity: 1 }
    ], { duration: APPEAR_DUR * durFactor, easing: 'ease-out', fill: 'forwards' }));

    // Beat 2: nock-draw-release. String and arrow snap through rest -> drawn -> rest across one
    // shared timeline, so they always agree on phase. Hung on archerWrap's own __waapiAnims
    // (rule 4: animations on child nodes hang on the parent).
    var f1 = DRAW_DUR / DRAW_PHASE, f2 = (DRAW_DUR + HOLD) / DRAW_PHASE;
    archerAnims.push(stringRest.animate([
      { opacity: 1, offset: 0 },
      { opacity: 0, offset: f1 },
      { opacity: 0, offset: f2 },
      { opacity: 1, offset: 1 }
    ], { duration: DRAW_PHASE * durFactor, delay: DRAW_START * durFactor, fill: 'forwards' }));
    archerAnims.push(stringDrawn.animate([
      { opacity: 0, offset: 0 },
      { opacity: 1, offset: f1 },
      { opacity: 1, offset: f2 },
      { opacity: 0, offset: 1 }
    ], { duration: DRAW_PHASE * durFactor, delay: DRAW_START * durFactor, fill: 'forwards' }));
    archerAnims.push(nockedArrow.animate([
      { transform: 'translateX(0px)', offset: 0 },
      { transform: 'translateX(-24px)', offset: f1 },
      { transform: 'translateX(-24px)', offset: f2 },
      { transform: 'translateX(0px)', offset: 1 }
    ], { duration: DRAW_PHASE * durFactor, delay: DRAW_START * durFactor, fill: 'forwards' }));
    archerAnims.push(nockedArrow.animate([
      { opacity: 1, offset: 0 },
      { opacity: 1, offset: f2 - 0.02 },
      { opacity: 0, offset: f2 }
    ], { duration: DRAW_PHASE * durFactor, delay: DRAW_START * durFactor, fill: 'forwards' }));

    // Beat 3: the arrow arcs to the target. Appear instantly at release, then travel.
    arrowAnims.push(flightArrow.animate([
      { opacity: 0 },
      { opacity: 1 }
    ], { duration: 1, delay: RELEASE_TIME * durFactor, fill: 'forwards' }));
    arrowAnims.push(flightArrow.animate([
      { offsetDistance: '0%' },
      { offsetDistance: '100%' }
    ], { duration: FLIGHT_DUR * durFactor, delay: RELEASE_TIME * durFactor, easing: 'ease-out', fill: 'forwards' }));

    // Beat 4: the target dissolves in at the match, ahead of the arrow.
    targetAnims.push(targetEl.animate([
      { opacity: 0, transform: 'scale(1.15)' },
      { opacity: 1, transform: 'scale(1)' }
    ], { duration: 240 * durFactor, delay: (RELEASE_TIME + 60) * durFactor, easing: 'ease-out', fill: 'forwards' }));

    // Beat 5: strike -- a damped rotational quiver about the embedded tip.
    arrowAnims.push(flightArrow.animate([
      { transform: 'rotate(0deg)', offset: 0 },
      { transform: 'rotate(14deg)', offset: 0.15 },
      { transform: 'rotate(-10deg)', offset: 0.35 },
      { transform: 'rotate(6deg)', offset: 0.55 },
      { transform: 'rotate(-3deg)', offset: 0.75 },
      { transform: 'rotate(0deg)', offset: 1 }
    ], { duration: QUIVER_DUR * durFactor, delay: ARRIVAL * durFactor, fill: 'forwards' }));

    // Beat 6: archer, bow (part of the archer sprite), arrow and target all dissolve out together.
    archerAnims.push(archerWrap.animate([
      { opacity: 1 },
      { opacity: 0 }
    ], { duration: FADE_OUT_DUR * durFactor, delay: FADE_OUT_DELAY * durFactor, easing: 'ease-in', fill: 'forwards' }));
    arrowAnims.push(flightArrow.animate([
      { opacity: 1 },
      { opacity: 0 }
    ], { duration: FADE_OUT_DUR * durFactor, delay: FADE_OUT_DELAY * durFactor, easing: 'ease-in', fill: 'forwards' }));
    targetAnims.push(targetEl.animate([
      { opacity: 1 },
      { opacity: 0 }
    ], { duration: FADE_OUT_DUR * durFactor, delay: FADE_OUT_DELAY * durFactor, easing: 'ease-in', fill: 'forwards' }));

    archerWrap.__waapiAnims = archerAnims;
    var archerDone = Promise.allSettled(archerAnims.map(function (a) { return a.finished; })).then(function () { archerWrap.remove(); });

    flightArrow.__waapiAnims = arrowAnims;
    var arrowDone = Promise.allSettled(arrowAnims.map(function (a) { return a.finished; })).then(function () { flightArrow.remove(); });

    targetEl.__waapiAnims = targetAnims;
    var targetDone = Promise.allSettled(targetAnims.map(function (a) { return a.finished; })).then(function () { targetEl.remove(); });

    // RESIZE HARD CUT, measured not assumed (see the header comment's own RESIZE note): every
    // element above is positioned once, at fire time, from the pre-resize rect -- the target
    // rings in particular sit only STRIKE_GAP/padIn clear of #match's own fire-time edges.
    // content.js's own handleResize() only reaches cancelBeacons() via repositionActiveOverlays()
    // after a 100ms debounce (overlayResizeTimer) that a continuous resize drag keeps resetting,
    // so a reflowed #match can end up under this stale, still-mounted geometry for the whole
    // drag. Measured directly (test/arrowshot_effect.test.js's own 'resize mid-flight' test): an
    // 8px horizontal reflow during a frozen mid-quiver frame left a nonzero painted-pixel delta
    // on #match before this hard cut existed. Tear every element down on the FIRST resize event,
    // ahead of the debounce -- same technique oculist-3dd8 ported for Fairy Cast's own clip-path
    // hole, applied here to all three top-level elements instead of one clip mask.
    function hardCutArrowShot() {
      window.removeEventListener('resize', hardCutArrowShot);
      [archerWrap, flightArrow, targetEl].forEach(function (el) {
        if (!el.isConnected) return;
        (el.__waapiAnims || []).forEach(function (a) { try { a.cancel(); } catch (e) {} });
        el.remove();
      });
    }
    window.addEventListener('resize', hardCutArrowShot, { passive: true, once: true });

    // { once: true } above only removes the listener once a resize actually FIRES -- if no
    // resize ever happens during this beacon's run (the common case), the listener would
    // otherwise outlive it, leaked on window forever and keeping archerWrap/flightArrow/targetEl
    // reachable after they've already been removed. Explicitly remove it once every element has
    // finished on its own (natural completion) or been cancelled (destroyBeacon() calls .cancel()
    // on every __waapiAnims entry, which settles archerDone/arrowDone/targetDone immediately) --
    // this covers both paths hardCutArrowShot's own early removeEventListener does not reach.
    Promise.all([archerDone, arrowDone, targetDone]).then(function () {
      window.removeEventListener('resize', hardCutArrowShot);
    });
  }


  // oculist-nq1x.12: promotes fxVineSwing (artifacts/prototypes/effects-playground.html:6426)
  // into extension/content.js as the eleventh entry in the Halloween pack. A vine-swinging
  // figure swoops in on a vine anchored off-screen above, releases near the bottom of the arc,
  // and carries on to land beside the match on a short ballistic hop while the riderless vine
  // swings on past and fades. RIGHTS: a generic public-domain jungle-swinger silhouette; the
  // label names the motion, never a character (oculist-1ta.4's own DONE-CRITERIA / the epic's
  // naming convention -- "Tarzan" is a live trademark).
  //
  // PLACEMENT, corrected (oculist-nq1x.12, oculist-8qrc, amended 2026-09-23): there is NO
  // above/below decision in this effect. The vine is UNCONDITIONALLY anchored off-screen above
  // -- PIVOT_Y starts at PIVOT_Y_BASE (above the viewport top by construction) -- there is no
  // below option and nothing to fall back to. The only placement freedom is LEFT vs RIGHT
  // LANDING SIDE, chosen the same "right by default, mirror left only if it doesn't fit" way
  // animateReanimate/animateWandCast/animateTentacleRise choose theirs. When the match sits
  // near the viewport TOP, the code does not switch sides -- it shortens the vine length L
  // toward L_FLOOR (below which "it no longer reads as a swing") and, if that alone is not
  // enough, pushes PIVOT_Y further off-screen, so releaseFeetY (the deepest point of the WHOLE
  // swing arc) is clamped by construction to never exceed r.top - SAFE_MARGIN, for any r.top.
  // oculist-1ta.4's own close reason confirms this clamp was tested and holds ("min clearance
  // 13.86px in the near-top-of-viewport probe"). This clamp -- computed from the PRE-SCROLL
  // viewport rect per contract rule 2, since "does the figure fit" is a viewport question even
  // though every element below is positioned in document space -- is the first thing this
  // file's own test asserts.
  //
  // RULE 9 EXCEPTION (oculist-i8zu, the same class fxArrowShot/fxWandCast/fxBatFlight already
  // carry, see their own header comments): the shipped lastMouseX/find-bar/viewport
  // start-point cascade animateTrail uses is deliberately NOT used here. Every geometric input
  // to the swing -- Px (the vine's own pivot x, chosen by the side-selection math below),
  // PIVOT_Y and L (both derived from #match's own rect and the viewport, see the clamp above)
  // -- comes from the match's own geometry, never from the cursor or the find bar. A
  // cursor-driven pivot would detach the vine from its own physics (theta(t) is defined about a
  // fixed pivot) and could walk the swept arc across #match, which rule 10 forbids. Rule 9's
  // other half -- the mirrored branch must work for real, not just compile -- still applies:
  // the left-landing side is a genuine mirrored branch (theta0's sign, onRight, buildFigure's
  // own mirror transform) and is tested below (the left-fallback test), not merely documented.
  //
  // OCCLUSION (verify the WHOLE arc, not just arrival): REACH_TOWARD/REACH_AWAY below are
  // derived by sampling every degree of the swing's own entry sweep (theta in
  // [-theta0Mag, 0]) against the figure's own rotating bounding corners, the same
  // fxReanimate-derived REACH_INWARD/OUTWARD idiom animateReanimate's/animateWandCast's own
  // header comments describe -- so the whole arc, not just the landing point, stays clear of
  // #match. The vine itself never needs a separate sample: it is a straight segment from the
  // pivot to the figure's own grip, strictly INSIDE the figure's own bounding-corner envelope
  // at every sampled angle (the figure's own box always extends further from the pivot than
  // the vine's attachment point at y=L), so the figure's own sweep bounds it too.
  // REACH_TOWARD/REACH_AWAY are accepted as an undetectable gap by this file's own test suite
  // (no fixture here makes the runway-based term lose to `r.right + GAP + REACH_TOWARD` --
  // see test/vineswing_effect.test.js's own mutation-proof note on the 'normal placement'
  // test). What actually protects #match for the WHOLE swing, independent of REACH_TOWARD's
  // own horizontal value, is VERTICAL: releaseFeetY -- the deepest point the entire rotating
  // arc ever reaches -- is clamped by construction (see the PLACEMENT note above) to stay at or
  // above r.top - SAFE_MARGIN for any r.top, so the swinging figure can never descend far
  // enough to reach #match's own row regardless of how close it swings horizontally.
  //
  // Fixed identity palette (rule 6's own license, "the pumpkin's orange"): SKIN/HAIR/SASH/
  // CLOTH/VINE/LEAF are fixed literals, the same "no separate flash/UI-accent element" reasoning
  // animateBatFlight's/animateWandCast's own header comments give for themselves -- there is no
  // UI-accent element here for getEffectiveColors().beacon to drive.
  //
  // Lite Mode (rule 7): a no-op, the same reasoning animateWandCast's/animateBatFlight's own
  // header comments give for themselves. There is no filter, no box-shadow and no decorative
  // glow layer anywhere in this effect's shipped art -- the pendulum swing, the release at the
  // bottom of the arc, and the real ballistic landing hop ARE the effect's defining beats, not
  // decorative flicker to cut. settings.performanceMode is deliberately never read below.
  //
  // RESIZE, measured, load-bearing: every element below is positioned once, at fire time, from
  // the pre-resize rect, and content.js's own handleResize() only reaches cancelBeacons() via
  // repositionActiveOverlays() after a 100ms debounce a continuous resize drag keeps resetting
  // -- so a reflowed #match can sit under this stale, still-mounted geometry for the whole
  // drag. A shrinking-viewport reflow that moves #match AWAY from the landing side (see
  // test/vineswing_effect.test.js's own 'resize mid-swing' test) shows zero delta regardless of
  // the hard cut, because the gap between the stale figure and the match only widens -- that is
  // not evidence of safety. The load-bearing case is a WIDENING reflow that moves #match TOWARD
  // the fixed, fire-time landing position (the resize test's own fixture: fired at a narrower
  // viewport, paused mid-hold, then widened, which shifts the centred #match ~40px toward the
  // right-side landing figure): with hardCutVineSwing() below removed, that closes the gap
  // enough for the stale, still-mounted landing figure to paint over #match's own new position
  // -- max painted-pixel delta 206 on #match's rect, measured directly. With the hard cut in
  // place, delta is 0. Torn down on the FIRST resize event, ahead of the debounce -- see
  // hardCutVineSwing() below.
  function animateVineSwing(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;

    var NS = 'http://www.w3.org/2000/svg';
    var r = rect; // viewport space (rule 2)
    var mcy = r.top + r.height / 2;
    var vw = window.innerWidth, vh = window.innerHeight;
    var SCROLL_X = window.scrollX, SCROLL_Y = window.scrollY;

    var beaconScale = getBeaconScale();
    var durFactor = getBeaconDuration(1);

    // Fixed screen-px geometry, unaffected by beaconScale -- same discipline animateReanimate's/
    // animateBatFlight's own GAP comments describe for themselves. Only the figure/vine SIZES
    // further down (figHeight, vine stroke widths, leaf size) scale directly with beaconScale.
    var GAP = 14; // match-rect clearance floor (brief asks >=12px; a little headroom over the bare minimum, unlike fxArrowShot's STRIKE_GAP=8 cliff)
    var SAFE_MARGIN = 12; // brief's clearance floor: the vine's deepest reach must stay this far above r.top
    var L_FLOOR = 120; // below this the vine no longer reads as a swing -- push PIVOT_Y up instead of shortening past it
    var DROP = 56; // visual fall distance (feet-to-feet) from release to the match's own vertical center
    var PIVOT_Y_BASE = -70; // baseline, above the viewport top; may be pushed further up below for tight-viewport clearance

    var SKIN = '#e39a52', SKIN_OUTLINE = '#572b16', SKIN_HI = '#f6bd78', SKIN_SHADE = '#b86a32';
    var HAIR = '#21150f', HAIR_OUTLINE = '#100906';
    var SASH = '#9d6523', SASH_HI = '#c88b38', SASH_SHADE = '#684018';
    var CLOTH = '#6d421f', CLOTH_HI = '#9a6430', CLOTH_OUTLINE = '#160d08';
    var VINE = '#4a7a2e', VINE_OUTLINE = '#243d16', VINE_HI = '#6ea23f';
    var LEAF = '#5c8f34', LEAF_OUTLINE = '#2c4517', LEAF_HI = '#7fb44e';
    var STROKE = 'stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke;';

    function svgEl(tag, attrs, parent) {
      var el = document.createElementNS(NS, tag);
      for (var k in attrs) el.setAttribute(k, attrs[k]);
      if (parent) parent.appendChild(el);
      return el;
    }

    // ── Figure authoring grid -- used identically for the swinging figure and the
    // post-release landing figure (identical artwork); both are nested <svg viewBox="0 0
    // VB_W VB_H"> elements built by the same buildFigure() below. figHeight carries
    // beaconScale (rule 6) BEFORE the placement/clearance math below is derived from it --
    // the same "scale before computing placement" discipline animateReanimate's/
    // animateWandCast's own figHeight comments describe.
    var VB_W = 40, VB_H = 56;
    var figHeight = 1.2 * Math.max(36, Math.min(48, 2.0 * r.height)) * beaconScale;
    var figWidth = figHeight * (VB_W / VB_H);
    var FACE_ANCHOR_Y = 16;

    // Two hand-authored silhouettes in a shared 40x56 authoring grid, ported byte-for-byte
    // from the prototype's own v2 character sheet (oculist-n8m0/oculist-38nv) -- broad
    // regions survive the 36px floor without gradients, filters, clip ids, or a runtime
    // raster asset.
    function buildFigure(svg, mirrored, pose) {
      var g = svgEl('g', {}, svg);
      if (mirrored) g.setAttribute('transform', 'translate(' + VB_W + ',0) scale(-1,1)');

      function shape(tag, attrs) { return svgEl(tag, attrs, g); }

      if (pose === 'land') {
        shape('path', { d: 'M 21 24 C 16 24 11 26 7 29 L 3 28 L 1 32 L 7 34 C 13 32 17 30 22 29 Z', fill: SKIN_SHADE, stroke: SKIN_OUTLINE, 'stroke-width': '1.6', style: STROKE, 'data-vs-part': 'arm-back' });
        shape('path', { d: 'M 20 35 C 14 36 8 40 6 46 L 10 50 C 13 45 17 42 23 41 Z', fill: SKIN_SHADE, stroke: SKIN_OUTLINE, 'stroke-width': '1.8', style: STROKE, 'data-vs-part': 'leg-back' });
        shape('path', { d: 'M 7 46 C 4 49 2 53 3 56 L 14 56 C 16 54 13 52 9 51 L 10 47 Z', fill: SKIN, stroke: SKIN_OUTLINE, 'stroke-width': '1.5', style: STROKE, 'data-vs-part': 'foot-back' });
        shape('path', { d: 'M 18 22 C 22 18 28 20 32 26 L 29 36 C 26 40 19 39 15 34 Z', fill: SKIN, stroke: SKIN_OUTLINE, 'stroke-width': '1.8', style: STROKE });
        shape('path', { d: 'M 20 21 C 25 23 28 27 30 33 L 24 38 C 22 33 19 29 15 27 Z', fill: SASH, stroke: CLOTH_OUTLINE, 'stroke-width': '1.5', style: STROKE, 'data-vs-part': 'sash' });
        shape('path', { d: 'M 15 34 L 30 34 L 32 40 L 22 42 L 13 45 L 12 39 Z', fill: CLOTH, stroke: CLOTH_OUTLINE, 'stroke-width': '1.7', style: STROKE, 'data-vs-part': 'waist-cloth' });
        shape('path', { d: 'M 14 37 L 18 35 L 17 41 L 13 43 Z', fill: CLOTH_HI });
        shape('path', { d: 'M 25 35 C 32 35 37 39 36 44 C 35 48 31 50 28 52 L 25 49 C 29 46 31 44 29 41 L 23 40 Z', fill: SKIN, stroke: SKIN_OUTLINE, 'stroke-width': '1.8', style: STROKE, 'data-vs-part': 'leg-front' });
        shape('path', { d: 'M 28 49 C 27 52 27 55 29 56 L 39 56 C 40 54 37 52 33 51 L 33 49 Z', fill: SKIN, stroke: SKIN_OUTLINE, 'stroke-width': '1.5', style: STROKE, 'data-vs-part': 'foot-front' });
        shape('path', { d: 'M 29 24 C 33 28 33 35 35 41 L 33 49 L 36 56 L 40 55 L 38 49 L 39 40 C 37 32 34 26 31 23 Z', fill: SKIN, stroke: SKIN_OUTLINE, 'stroke-width': '1.6', style: STROKE, 'data-vs-part': 'arm-front' });
      } else {
        shape('path', { d: 'M 18 23 C 14 24 11 27 7 29 L 3 28 L 1 32 L 7 34 C 12 32 17 30 21 27 Z', fill: SKIN_SHADE, stroke: SKIN_OUTLINE, 'stroke-width': '1.6', style: STROKE, 'data-vs-part': 'arm-back' });
        shape('path', { d: 'M 17 36 C 12 39 9 45 11 50 C 12 53 15 54 17 51 L 21 44 L 24 39 Z', fill: SKIN_SHADE, stroke: SKIN_OUTLINE, 'stroke-width': '1.8', style: STROKE, 'data-vs-part': 'leg-back' });
        shape('path', { d: 'M 18 21 C 22 19 27 21 29 26 L 28 39 C 24 42 18 41 14 37 Z', fill: SKIN, stroke: SKIN_OUTLINE, 'stroke-width': '1.8', style: STROKE });
        shape('path', { d: 'M 22 21 C 25 24 27 29 28 35 L 23 39 C 22 34 19 29 16 26 Z', fill: SASH, stroke: CLOTH_OUTLINE, 'stroke-width': '1.5', style: STROKE, 'data-vs-part': 'sash' });
        shape('path', { d: 'M 14 36 L 29 36 L 31 42 L 23 44 L 17 49 L 11 48 L 14 41 Z', fill: CLOTH, stroke: CLOTH_OUTLINE, 'stroke-width': '1.7', style: STROKE, 'data-vs-part': 'waist-cloth' });
        shape('path', { d: 'M 14 37 L 17 37 L 15 43 L 12 46 Z', fill: CLOTH_HI });
        shape('path', { d: 'M 24 37 C 29 34 35 36 35 41 C 35 45 30 48 27 50 L 25 54 C 24 56 20 55 20 52 L 21 45 L 18 42 Z', fill: SKIN, stroke: SKIN_OUTLINE, 'stroke-width': '1.8', style: STROKE, 'data-vs-part': 'leg-front' });
        shape('path', { d: 'M 24 22 C 24 17 22 11 20 4 L 17 4 C 17 12 18 19 20 25 Z', fill: SKIN, stroke: SKIN_OUTLINE, 'stroke-width': '1.6', style: STROKE, 'data-vs-part': 'arm-front' });
        shape('path', { d: 'M 16 -3 C 18 -5 21 -4 22 -2 L 22 1 L 20 4 L 17 4 L 15 1 Z', fill: SKIN, stroke: SKIN_OUTLINE, 'stroke-width': '1.5', style: STROKE, 'data-vs-part': 'grip' });
        shape('path', { d: 'M 17 -2 L 20 -3 L 21 -1', fill: 'none', stroke: SKIN_HI, 'stroke-width': '1.1', style: STROKE });
      }

      var headTransform = pose === 'land' ? 'translate(0,5)' : '';
      shape('path', { d: 'M 18 9 C 14 8 11 10 12 13 L 9 15 L 13 16 L 10 19 L 16 18 C 17 22 21 24 25 22 L 29 17 L 28 11 Z', fill: HAIR, stroke: HAIR_OUTLINE, 'stroke-width': '1.7', style: STROKE, transform: headTransform, 'data-vs-part': 'hair' });
      shape('path', { d: 'M 20 9 C 25 7 30 10 31 14 L 34 16 L 31 18 C 30 22 27 24 23 23 C 19 22 17 18 18 14 Z', fill: SKIN, stroke: SKIN_OUTLINE, 'stroke-width': '1.6', style: STROKE, transform: headTransform, 'data-vs-part': 'face' });
      shape('path', { d: 'M 19 11 C 16 9 13 9 11 11 L 14 9 L 10 9 L 15 7 L 20 8 L 24 8 L 28 11 L 25 13 L 22 11 L 20 16 L 18 14 Z', fill: HAIR, stroke: HAIR_OUTLINE, 'stroke-width': '1.5', style: STROKE, transform: headTransform });
      shape('ellipse', { cx: '19', cy: '16', rx: '2', ry: '2.4', fill: SKIN_SHADE, stroke: SKIN_OUTLINE, 'stroke-width': '1', transform: headTransform });
      shape('path', { d: 'M 27 14 L 29 14', fill: 'none', stroke: HAIR_OUTLINE, 'stroke-width': '1.2', style: STROKE, transform: headTransform });
      shape('path', { d: 'M 29 20 L 31 19', fill: 'none', stroke: SKIN_OUTLINE, 'stroke-width': '1', style: STROKE, transform: headTransform });
      shape('path', { d: pose === 'land' ? 'M 21 23 L 25 25 L 22 28 Z' : 'M 20 23 L 24 25 L 21 28 Z', fill: SASH_HI });
      shape('path', { d: pose === 'land' ? 'M 28 33 L 31 36 L 27 39 Z' : 'M 25 34 L 28 36 L 24 39 Z', fill: SASH_SHADE });
    }

    // ── Pendulum physics, baked once at fire time (rule 1 of the effect's own brief: geometry
    // generated once, not per-frame). theta(t) = theta0 * cos(sqrt(g/L) * t); omega/G are
    // solved backwards from the chosen SWING_DUR (a quarter period) so a single analytic
    // function reproduces it, and every timing constant below stays in RAW ms here -- durFactor
    // (rule 6) is applied only to the WAAPI duration/delay values further down, never to the
    // physics itself, so the frame SHAPE stays correct at any Animation Speed and only its
    // playback rate changes. ──
    var theta0Mag = 58; // degrees
    var SWING_DUR = 820; // ms, entry -> release (raw; scaled by durFactor only at playback)
    var omega = (Math.PI / 2) / SWING_DUR; // quarter period == SWING_DUR, so cos() reaches 0 exactly at release
    var G = omega * omega;
    function thetaAt(theta0, t) { return theta0 * Math.cos(Math.sqrt(G) * t); }

    var PIVOT_Y = PIVOT_Y_BASE;
    var FIG_Y_OFFSET = 0; // vine endpoint -> grip; shared with releaseFeetY so the pose swap stays pop-free

    var Lraw = (mcy - DROP) - FIG_Y_OFFSET - figHeight - PIVOT_Y;
    var L = Math.max(200, Lraw);

    // Clearance clamp (oculist-1ta.4's own finding 1, re-asserted by oculist-nq1x.12/
    // oculist-8qrc): the 200-floor clamp above can make L LONGER than the mcy-derived value
    // ever intended when the match sits within ~230px of the viewport top -- check the single
    // deepest point explicitly and correct it: shorten L if that alone keeps it a real swing,
    // otherwise keep L at the swing-length floor and push the pivot further up instead. Both
    // r.top and the clamp math below use the PRE-SCROLL viewport rect (rule 2).
    var releaseFeetY = PIVOT_Y + L + FIG_Y_OFFSET + figHeight;
    if (releaseFeetY > r.top - SAFE_MARGIN) {
      var Lsafe = (r.top - SAFE_MARGIN) - PIVOT_Y - FIG_Y_OFFSET - figHeight;
      if (Lsafe >= L_FLOOR) {
        L = Lsafe;
      } else {
        L = L_FLOOR;
        PIVOT_Y = (r.top - SAFE_MARGIN) - L - FIG_Y_OFFSET - figHeight;
      }
      releaseFeetY = PIVOT_Y + L + FIG_Y_OFFSET + figHeight; // recompute at the new boundary (== r.top - SAFE_MARGIN)
    }

    // REACH sampling: bounds how far the rotating figure (its own bbox corners, relative to
    // the pivot) can reach either toward or away from the match, across the full entry sweep
    // theta in [-theta0Mag, 0]. Mirrors animateReanimate's/animateWandCast's own REACH_INWARD/
    // OUTWARD pattern; by mirror symmetry these two numbers are reused as-is for a left-side
    // landing too (just applied to the opposite side).
    var corners = [
      [-figWidth / 2, L], [figWidth / 2, L],
      [-figWidth / 2, L + figHeight], [figWidth / 2, L + figHeight]
    ];
    var minRel = 0, maxRel = 0;
    for (var deg = -theta0Mag; deg <= 0; deg += 1) {
      var rad = deg * Math.PI / 180, cosT = Math.cos(rad), sinT = Math.sin(rad);
      corners.forEach(function (c) {
        var rel = c[0] * cosT - c[1] * sinT;
        if (rel < minRel) minRel = rel;
        if (rel > maxRel) maxRel = rel;
      });
    }
    var REACH_TOWARD = -minRel + 2; // +2 for the 1deg sampling step
    var REACH_AWAY = maxRel + 2;

    // Side selection: the exact constant-vx ballistic runway, so the clearance-bound pivot
    // determines the final resting point, not a later speed adjustment. Prefer right, mirror
    // left when only left fits (never above/below -- see the header comment's PLACEMENT note).
    var FALL_DUR = 340; // ms, raw
    var releaseRadius = L + figHeight * FACE_ANCHOR_Y / VB_H;
    var releaseSpeed = releaseRadius * (theta0Mag * Math.PI / 180) * omega;
    var runway = releaseSpeed * FALL_DUR;
    var desiredRightX = r.right + GAP + figWidth / 2;
    var rightPx = Math.max(desiredRightX + runway, r.right + GAP + REACH_TOWARD);
    var sideRight = { x: rightPx - runway, px: rightPx, side: 'right' };
    sideRight.fits = sideRight.x + figWidth / 2 <= vw - 4;
    var desiredLeftX = r.left - GAP - figWidth / 2;
    var leftPx = Math.min(desiredLeftX - runway, r.left - GAP - REACH_TOWARD);
    var sideLeft = { x: leftPx + runway, px: leftPx, side: 'left' };
    sideLeft.fits = sideLeft.x - figWidth / 2 >= 4;
    var landing = sideRight.fits ? sideRight : (sideLeft.fits ? sideLeft : sideRight);
    var onRight = landing.side === 'right';
    var landingX = landing.x;
    var Px = landing.px;

    var theta0 = onRight ? -theta0Mag : theta0Mag;

    // Real release velocity at theta=0 (the bottom, where this design releases): differentiating
    // thetaAt() and evaluating at t=SWING_DUR (omega*t=pi/2) reduces to this one-line formula;
    // the vertical velocity is exactly zero at the bottom, so the ballistic segment below starts
    // with that same vector -- `landingX - Px` equals vxRelease*FALL_DUR exactly, so the flight
    // inherits the pendulum's horizontal velocity without a seam.
    var theta0Rad = theta0 * Math.PI / 180;
    var vxRelease = releaseRadius * theta0Rad * omega; // px/ms, signed toward the landing side

    // ── Shared static wrapper: DOCUMENT coordinates (rule 2), not the prototype's
    // position:fixed. Every child below is positioned in THIS element's own local coordinate
    // space, which starts at the viewport's top-left exactly like the prototype's fixed-
    // position math did -- so every viewport-space offset below (Px/PIVOT_Y/L/figWidth/
    // figHeight) ports unchanged; only this one wrapper's own left/top carry the scroll
    // offset. Same idiom as animateReanimate's own reanimateWrap. ──
    var vineWrap = document.createElement('div');
    vineWrap.className = 'oc-beacon oc-beacon-transient';
    vineWrap.setAttribute('data-vineswing', 'vine');
    vineWrap.setAttribute('data-vineswing-side', landing.side);
    vineWrap.setAttribute('data-vineswing-l', String(L));
    vineWrap.setAttribute('data-vineswing-pivot-y', String(PIVOT_Y));
    vineWrap.setAttribute('data-vineswing-release-feet-y', String(releaseFeetY));
    vineWrap.setAttribute('data-vineswing-px', String(Px));
    vineWrap.style.cssText = [
      'position:absolute',
      'left:' + (SCROLL_X) + 'px', 'top:' + (SCROLL_Y) + 'px',
      'width:' + vw + 'px', 'height:' + vh + 'px',
      'pointer-events:none',
      'z-index:2147483642',
      'opacity:0'
    ].join(';');
    document.documentElement.appendChild(vineWrap);

    var vineAnims = [];
    function trackVine(a) { vineAnims.push(a); return a; }

    var vineSvg = svgEl('svg', {
      width: String(vw), height: String(vh), viewBox: '0 0 ' + vw + ' ' + vh
    }, vineWrap);
    vineSvg.style.cssText = 'display:block;overflow:visible;';

    var vineGroup = svgEl('g', {}, vineSvg);
    vineGroup.style.cssText = 'transform-origin:' + Px + 'px ' + PIVOT_Y + 'px;transform:rotate(' + theta0 + 'deg);';

    function vShape(tag, attrs) { return svgEl(tag, attrs, vineGroup); }

    // Vine: outline stroke underneath, base stroke, thin highlight offset toward the
    // upper-left (same lit-from-upper-left rule every other shape in this effect follows).
    // Stroke widths are SIZES (rule 6), so they scale directly with beaconScale.
    var vineD = 'M ' + Px + ' ' + PIVOT_Y + ' L ' + Px + ' ' + (PIVOT_Y + L);
    vShape('path', { d: vineD, fill: 'none', stroke: VINE_OUTLINE, 'stroke-width': String(7 * beaconScale), style: STROKE });
    vShape('path', { d: vineD, fill: 'none', stroke: VINE, 'stroke-width': String(4.5 * beaconScale), style: STROKE });
    var vineHiD = 'M ' + (Px - 1) + ' ' + PIVOT_Y + ' L ' + (Px - 1) + ' ' + (PIVOT_Y + L);
    vShape('path', { d: vineHiD, fill: 'none', stroke: VINE_HI, 'stroke-width': String(1.4 * beaconScale), style: STROKE });

    // Two leaves along the vine, alternating sides.
    [0.38, 0.72].forEach(function (frac, i) {
      var ly = PIVOT_Y + L * frac;
      var side = i === 0 ? 1 : -1;
      var lx = Px + side * 9 * beaconScale;
      var leafSpan = 6 * beaconScale;
      var leafD = 'M ' + Px + ' ' + ly + ' L ' + lx + ' ' + (ly - leafSpan) + ' L ' + (lx + side * leafSpan) + ' ' + ly + ' L ' + lx + ' ' + (ly + leafSpan) + ' Z';
      vShape('path', { d: leafD, fill: LEAF, stroke: LEAF_OUTLINE, 'stroke-width': String(1.4 * beaconScale), style: STROKE });
      vShape('ellipse', { cx: String(lx), cy: String(ly - 2 * beaconScale), rx: String(2 * beaconScale), ry: String(1.4 * beaconScale), fill: LEAF_HI });
    });

    // Swinging figure -- a nested <svg> so buildFigure()'s authoring-unit grid can be reused
    // verbatim; positioned so its own top edge (grip level) sits at the vine's lower end, in
    // the group's local (pre-rotation) coordinates. Rotating the group therefore always
    // carries the figure along with the vine's end -- attachment by construction.
    // overflow:visible lets the raised-arm fist (drawn above y=0 in the 'swing' pose) render
    // instead of being clipped by the nested <svg>'s own box.
    var figSwingSvg = svgEl('svg', {
      'data-vs-pose': 'swing',
      x: String(Px - figWidth / 2), y: String(PIVOT_Y + L + FIG_Y_OFFSET),
      width: String(figWidth), height: String(figHeight), viewBox: '0 0 ' + VB_W + ' ' + VB_H
    }, vineGroup);
    figSwingSvg.style.cssText = 'overflow:visible;';
    buildFigure(figSwingSvg, !onRight, 'swing');

    // ── Landing figure -- separate top-level element, identical artwork (crouched pose),
    // hidden until release ────────────────────────────────────────────────────────────────
    var FALL_PAD = 8; // headroom above the landing figure's own feet within its box, for the squash animation below
    var LAND_HEAD_DROP = 5;
    var landingPoseLift = figHeight * LAND_HEAD_DROP / VB_H;
    var releaseLeft = Px - figWidth / 2, releaseTop = releaseFeetY - figHeight - FALL_PAD;

    var fallOuter = document.createElement('div');
    fallOuter.className = 'oc-beacon oc-beacon-transient';
    fallOuter.setAttribute('data-vineswing', 'landing');
    fallOuter.style.cssText = [
      'position:absolute',
      'left:' + (releaseLeft + SCROLL_X) + 'px', 'top:' + (releaseTop + SCROLL_Y) + 'px',
      'width:' + figWidth + 'px', 'height:' + (figHeight + FALL_PAD) + 'px',
      'pointer-events:none',
      'z-index:2147483642',
      'opacity:0'
    ].join(';');
    document.documentElement.appendChild(fallOuter);

    var fallAnims = [];
    function trackFall(a) { fallAnims.push(a); return a; }

    var fallInner = document.createElement('div');
    fallInner.style.cssText = 'width:100%;height:100%;transform-origin:50% 100%;';
    fallOuter.appendChild(fallInner);

    var figFallSvg = svgEl('svg', {
      'data-vs-pose': 'land',
      width: String(figWidth), height: String(figHeight), viewBox: '0 0 ' + VB_W + ' ' + VB_H
    }, fallInner);
    figFallSvg.style.cssText = 'display:block;overflow:visible;position:absolute;left:0;top:' + (FALL_PAD - landingPoseLift) + 'px;';
    buildFigure(figFallSvg, !onRight, 'land');

    // ── Timeline: every phase boundary below is computed in RAW ms (rule 6's own "phase
    // boundaries scaling with it [durFactor] rather than staying absolute" -- the fraction
    // math needs the raw values so the shape of the motion is unaffected by Animation Speed;
    // durFactor is multiplied in only at the point each value is handed to a `duration:` or
    // `delay:` option below). ──
    var STEP = 16; // ms, fixed integration step (raw)

    // The vine's own rotation is ONE continuous sample of the same pendulum formula from
    // entry all the way to a natural stop on the FAR side (oculist-1ta.4's own finding 1:
    // reversing back the way it came was wrong). FAR_FRAC=0.8 stops the sample on the far
    // side while theta is still comfortably nonzero -- the vine is still visibly moving when
    // it fades below.
    var FAR_FRAC = 0.8;
    var FAR_T = Math.acos(-FAR_FRAC) / omega;
    var SWING_TOTAL = FAR_T; // raw ms

    var SQUASH_DUR = 150, HOLD_AFTER = 500, FADE_DUR = 300, FADE_IN_DUR = 120, FADE_OUT_DUR = 200; // raw ms

    var RELEASE_T = SWING_DUR; // theta=0, the bottom
    var LAND_T = RELEASE_T + FALL_DUR;
    var SQUASH_END_T = LAND_T + SQUASH_DUR;
    var FADE_DELAY = SQUASH_END_T + HOLD_AFTER;

    var rotFrames = [];
    var nSteps = Math.max(2, Math.round(SWING_TOTAL / STEP));
    for (var si = 0; si <= nSteps; si++) {
      var st = (si / nSteps) * SWING_TOTAL;
      var sth = thetaAt(theta0, st);
      rotFrames.push({ transform: 'rotate(' + sth.toFixed(3) + 'deg)', offset: si / nSteps });
    }
    rotFrames.push({ transform: 'rotate(0deg)', offset: RELEASE_T / SWING_TOTAL });
    rotFrames.sort(function (a, b) { return a.offset - b.offset; });
    rotFrames[rotFrames.length - 1].offset = 1; // exact end, immune to float rounding
    trackVine(vineGroup.animate(rotFrames, { duration: SWING_TOTAL * durFactor, easing: 'linear', fill: 'forwards' }));

    // Swinging figure hides the instant release happens; the vine (now riderless) keeps
    // going per rotFrames above, then fades.
    var releaseFrac = RELEASE_T / SWING_TOTAL;
    trackVine(figSwingSvg.animate([
      { opacity: 1, offset: 0, easing: 'step-end' },
      { opacity: 0, offset: releaseFrac },
      { opacity: 0, offset: 1 }
    ], { duration: SWING_TOTAL * durFactor, fill: 'forwards' }));

    // Vine + figure fade in over the first FADE_IN_DUR ms (oculist-1ta.4's own finding 2: no
    // materializing at rest -- the whole group is already moving, mid-rotation), held at full
    // opacity through the swing, then fade out over the last FADE_OUT_DUR ms while the
    // riderless vine is still moving.
    var fadeInFrac = FADE_IN_DUR / SWING_TOTAL;
    var fadeOutStartFrac = (SWING_TOTAL - FADE_OUT_DUR) / SWING_TOTAL;
    trackVine(vineWrap.animate([
      { opacity: 0, offset: 0, easing: 'ease-out' },
      { opacity: 1, offset: fadeInFrac, easing: 'linear' },
      { opacity: 1, offset: fadeOutStartFrac, easing: 'ease-in' },
      { opacity: 0, offset: 1 }
    ], { duration: SWING_TOTAL * durFactor, fill: 'forwards' }));

    // Landing figure: hidden -> instant reveal at release -> a real projectile hop
    // (oculist-1ta.4's own finding 3): constant horizontal velocity and a true kinematic
    // parabola vertically (vy0*t + 0.5*g*t^2), not an eased mirror of gravity. The swing's
    // vertical velocity at the exact theta=0 release point is exactly zero, so the ballistic
    // segment starts with vy=0 and gravity bends that horizontal release into the landing ->
    // squash -> held settle -> fade with the rest of the scene.
    trackFall(fallOuter.animate([
      { opacity: 0, offset: 0 },
      { opacity: 1, offset: 1 }
    ], { duration: 1, delay: RELEASE_T * durFactor, fill: 'forwards' }));

    var vxHop = (landingX - Px) / FALL_DUR; // px/ms, constant -- the actual release-to-landing gap over FALL_DUR (raw)
    var vy0 = 0;
    var TARGET_DROP = mcy - releaseFeetY + landingPoseLift;
    var g = 2 * (TARGET_DROP - vy0 * FALL_DUR) / (FALL_DUR * FALL_DUR); // px/ms^2, raw-time-solved

    var fallSteps = Math.max(2, Math.round(FALL_DUR / STEP));
    var fallFrames = [];
    for (var fi = 0; fi <= fallSteps; fi++) {
      var ffrac = fi / fallSteps;
      var ft = ffrac * FALL_DUR; // raw ms, used only to sample the physical curve's SHAPE
      var fx = vxHop * ft;
      var fy = vy0 * ft + 0.5 * g * ft * ft;
      fallFrames.push({ transform: 'translate(' + fx.toFixed(2) + 'px,' + fy.toFixed(2) + 'px)', offset: ffrac });
    }
    trackFall(fallOuter.animate(fallFrames, { duration: FALL_DUR * durFactor, delay: RELEASE_T * durFactor, easing: 'linear', fill: 'forwards' }));

    trackFall(fallInner.animate([
      { transform: 'scale(1,1)', offset: 0 },
      { transform: 'scale(1.18,0.78)', offset: 0.45 },
      { transform: 'scale(0.95,1.05)', offset: 0.75 },
      { transform: 'scale(1,1)', offset: 1 }
    ], { duration: SQUASH_DUR * durFactor, delay: LAND_T * durFactor, easing: 'ease-out', fill: 'forwards' }));

    trackFall(fallOuter.animate([
      { opacity: 1 }, { opacity: 0 }
    ], { duration: FADE_DUR * durFactor, delay: FADE_DELAY * durFactor, easing: 'ease-in', fill: 'forwards' }));

    vineWrap.__waapiAnims = vineAnims;
    fallOuter.__waapiAnims = fallAnims;

    // Natural completion removes each top-level element only once EVERY one of its own
    // animations has settled (rule 5). destroyBeacon() still removes both synchronously on
    // cancel (cancelBeacons() selects every `.oc-beacon` element, and both wrappers carry
    // that class independently), cancelling every entry in __waapiAnims regardless of these
    // promises -- same idiom animateReanimate's own removeReanimateWrap() uses.
    function removeVineWrap() { vineWrap.remove(); }
    function removeFallOuter() { fallOuter.remove(); }
    var vineDone = Promise.allSettled(vineAnims.map(function (a) { return a.finished; })).then(removeVineWrap);
    var fallDone = Promise.allSettled(fallAnims.map(function (a) { return a.finished; })).then(removeFallOuter);

    // RESIZE HARD CUT -- see the header comment's own RESIZE note. Tear both top-level
    // elements down on the FIRST resize event, ahead of the 100ms cancelBeacons() debounce,
    // the same technique hardCutArrowShot()/hardCutBackWrap() already use.
    function hardCutVineSwing() {
      window.removeEventListener('resize', hardCutVineSwing);
      [vineWrap, fallOuter].forEach(function (el) {
        if (!el.isConnected) return;
        (el.__waapiAnims || []).forEach(function (a) { try { a.cancel(); } catch (e) {} });
        el.remove();
      });
    }
    window.addEventListener('resize', hardCutVineSwing, { passive: true, once: true });

    // { once: true } above only removes the listener once a resize actually FIRES -- if no
    // resize ever happens during this beacon's run (the common case), the listener would
    // otherwise outlive it, leaked on window forever. Explicitly remove it once every element
    // has finished on its own (natural completion) or been cancelled (destroyBeacon() calls
    // .cancel() on every __waapiAnims entry, which settles vineDone/fallDone immediately) --
    // this covers both paths hardCutVineSwing()'s own early removeEventListener does not
    // reach, using allSettled-based promises throughout so a cancel rejection can never skip
    // this cleanup.
    Promise.all([vineDone, fallDone]).then(function () {
      window.removeEventListener('resize', hardCutVineSwing);
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
    container.className = 'oc-beacon oc-beacon-transient';
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

    // See cancelBeacons(): every Animation this beacon creates is hung off the
    // container so a mid-flight cancel actually stops it (not just detaches its element).
    // container.__waapiAnims is assigned once, right after this batch — the setTimeout
    // callback below pushes its own (later-scheduled) animations onto this same array
    // reference, so a cancelBeacons() that fires either before or after that callback
    // still sees every animation that exists at the time it runs.
    var anims = [];

    paths.forEach(function (p) {
      var totalLength = 1500;
      try {
        totalLength = p.core.getTotalLength() || 1500;
      } catch (e) {}

      p.glow.setAttribute('stroke-dasharray', totalLength);
      p.glow.setAttribute('stroke-dashoffset', totalLength);
      p.core.setAttribute('stroke-dasharray', totalLength);
      p.core.setAttribute('stroke-dashoffset', totalLength);

      anims.push(p.glow.animate([
        { strokeDashoffset: totalLength },
        { strokeDashoffset: '0' }
      ], {
        duration: travelDuration,
        easing: 'ease-out',
        fill: 'forwards'
      }));

      anims.push(p.core.animate([
        { strokeDashoffset: totalLength },
        { strokeDashoffset: '0' }
      ], {
        duration: travelDuration,
        easing: 'ease-out',
        fill: 'forwards'
      }));
    });

    container.__waapiAnims = anims;

    setTimeout(function () {
      // The container may already have been cancelled/removed (cancelBeacons() ran
      // mid-flight, before this scheduled callback) — do not create new elements or
      // animations on a detached container; nothing would ever cancel them.
      if (!container.isConnected) return;

      var flashBg = document.createElement('div');
      flashBg.style.cssText = [
        'position:absolute', 'left:0', 'top:0', 'width:100%', 'height:100%',
        'background:#ffffff', 'opacity:0', 'pointer-events:none'
      ].join(';');
      container.appendChild(flashBg);
      anims.push(flashBg.animate([
        { opacity: 0.3 },
        { opacity: 0, offset: 0.8 }
      ], {
        duration: getBeaconDuration(300),
        easing: 'ease-out',
        fill: 'forwards'
      }));

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

      anims.push(flashCircle.animate([
        { transform: 'scale(0.5)', opacity: 1 },
        { transform: 'scale(1.4)', opacity: 1, offset: 0.2 },
        { transform: 'scale(1.1)', opacity: 0.9, offset: 0.7 },
        { transform: 'scale(1.8) scaleY(0)', opacity: 0 }
      ], {
        duration: getBeaconDuration(700),
        easing: 'cubic-bezier(0.19, 1, 0.22, 1)',
        fill: 'forwards'
      }));

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

        anims.push(flickerGlow.animate(flickAnim, { duration: getBeaconDuration(400), fill: 'forwards' }));
        anims.push(flickerCore.animate(flickAnim, { duration: getBeaconDuration(400), fill: 'forwards' }));
      }

      paths.forEach(function (p) {
        anims.push(p.glow.animate([{ opacity: 0.8 }, { opacity: 0 }], { duration: getBeaconDuration(150), fill: 'forwards' }));
        anims.push(p.core.animate([{ opacity: 1 }, { opacity: 0 }], { duration: getBeaconDuration(150), fill: 'forwards' }));
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
    container.className = 'oc-beacon oc-beacon-transient';
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
    // Reset every speed-lines __ocTest hook before the guard below can return early, so a
    // skipped run (rect missing or zero-sized) can never be graded against the previous
    // run's leftover values (oculist-47e; same gap oculist-viv found and fixed for
    // lastSpeedLinesContainerRect alone, generalised here to the full hook set).
    // lastSpeedLinesContainerRect/lastSpeedLinesLaneBounds/lastSpeedLinesAnchor/
    // lastSpeedLinesHighlightY reset to null and speedLinesDone to false — unambiguous
    // "this run produced nothing" sentinels a real run never writes back into at its own
    // setup, so a wait on speedLinesDone times out loudly instead of resolving off a stale
    // true, and reading a property off any of the null ones throws instead of silently
    // reporting the prior run's geometry. speedLinesFrameCount/lastSpeedLinesLaneAlphaMax/
    // lastSpeedLinesElseAlphaMax/speedLinesHighlightDrawCount reset to 0, same as a real
    // run's own setup before its first frame — 0 alone cannot tell "skipped" apart from
    // "started, no frame drawn yet", so those four are safe to read only because
    // speedLinesDone gates every consumer.
    window.__ocTest.lastSpeedLinesContainerRect = null;
    window.__ocTest.lastSpeedLinesStreakCount = 0;
    window.__ocTest.speedLinesFrameCount = 0;
    window.__ocTest.lastSpeedLinesLaneAlphaMax = 0;
    window.__ocTest.lastSpeedLinesElseAlphaMax = 0;
    window.__ocTest.lastSpeedLinesLaneBounds = null;
    window.__ocTest.lastSpeedLinesAnchor = null;
    window.__ocTest.lastSpeedLinesHighlightY = null;
    window.__ocTest.speedLinesHighlightDrawCount = 0;
    window.__ocTest.speedLinesDone = false;

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
    container.className = 'oc-beacon oc-beacon-transient';
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

    // lastSpeedLinesContainerRect: the container's own position, taken right after it is
    // placed in the document and never touched again on this element -- its CSS
    // (left/top/width/height/transform) is fixed for the rest of this beacon's life, so
    // this stays correct for the container's entire lifetime. A test that needs the
    // container's rendered position should read this instead of re-querying '.oc-beacon'
    // near completion: this beacon's own container is removed in frame()'s own completion
    // branch below (mirroring animateChronoTunnel, oculist-3ae/oculist-ws4), strictly after
    // the last frame that will ever run -- but it can also be removed early, before this run
    // completes, by cancelBeacons()/fadeActiveBeacons() on a new search or a scroll. Either
    // way, a live '.oc-beacon' query taken anywhere near or after completion risks finding
    // the element already detached. Capturing here, right after the container is placed and
    // long before any of those removal paths can run, sidesteps that risk entirely instead
    // of trying to win a race against it.
    //
    // Stored in DOCUMENT coordinates (viewport rect + the scroll offset at capture time),
    // not viewport coordinates: getBoundingClientRect() is viewport-relative, and any scroll
    // between this capture and a later read would shift the viewport-relative numbers by the
    // scroll delta even though the container's actual document position never moves. A
    // consumer must convert its own comparison point to document coordinates the same way
    // (its own live rect + the scroll offset read at that same instant) so both sides stay
    // in one coordinate space that cannot go stale under scrolling.
    window.__ocTest.lastSpeedLinesContainerRect = (function () {
      var r = container.getBoundingClientRect();
      return { left: r.left + window.scrollX, top: r.top + window.scrollY };
    })();

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
    // this run reaches its final frame, giving the test a deterministic completion signal.
    // Since oculist-ws4 it is also the signal that ORDERS removal: the completion branch
    // sets it and then removes the container in the same tick, so no frame can run after
    // the container is gone.
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
    // lastSpeedLinesAnchor exposes the same local-canvas anchor (vpCx, offsetY) every
    // streak/flare/lane computation above is drawn relative to, so a test can grade it
    // against the match's own independently-observed rendered position (see
    // test/helpers/effect_anchor.js) rather than only ever checking this effect's
    // internals for self-consistency (oculist-dvt.7).
    window.__ocTest.lastSpeedLinesAnchor = { matchX: vpCx, matchY: offsetY };
    // Set again every frame below at the exact point the centre-line highlight is actually
    // drawn (so a mutation to that draw call's y is caught), but initialised here too so it
    // is never momentarily undefined before the first rAF callback runs.
    window.__ocTest.lastSpeedLinesHighlightY = offsetY;
    window.__ocTest.speedLinesHighlightDrawCount = 0;
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

      // Persistent centre-line: a thin bright horizontal beam at the match's own vertical
      // centre, spanning the full canvas width — an accessibility locator so the eye always
      // has one fixed thing to land on while the streak field rushes past. Unlike everything
      // above, it does not ride `env` (the burst impulse envelope): it draws at a constant
      // alpha every frame from the effect's first frame to its last, the same full duration
      // the frame loop itself runs for, rather than spiking and decaying with the burst.
      // Evokes animateAnimeLaser's sheath/core beam pair, just calmer and full-width so it
      // reads as a through-line rather than another burst. `highlightY` is a single local
      // variable feeding both the actual draw calls below and the lastSpeedLinesHighlightY
      // test hook, so the two can never drift apart the way a hook copied from a different
      // expression could — a test can grade this against the match's own
      // independently-observed rendered position the same way lastSpeedLinesAnchor already
      // is (test/helpers/effect_anchor.js, oculist-dvt.7). speedLinesHighlightDrawCount
      // increments unconditionally alongside it, every frame in both Lite and full mode, so
      // a test can prove the line keeps drawing for the run's full length rather than only
      // at the start, without racing the canvas for a pixel sample.
      var highlightThick = 2;
      var highlightY = offsetY;
      window.__ocTest.lastSpeedLinesHighlightY = highlightY;
      window.__ocTest.speedLinesHighlightDrawCount++;
      // Lite Mode drops the soft glow pass (same call as the streak bloom halos above) but
      // keeps the core line itself — it IS the accessibility aid, not decoration.
      if (!settings.performanceMode) {
        ctx.fillStyle = hexToRgba(color, 0.14);
        ctx.fillRect(0, highlightY - highlightThick * 4, W, highlightThick * 8);
      }
      ctx.fillStyle = hexToRgba(color, 0.6);
      ctx.fillRect(0, highlightY - highlightThick / 2, W, highlightThick);

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
        // Removal used to be an independently-timed setTimeout(DUR) fired right after the
        // first rAF; that timer consistently fired ~8-16ms before this completing frame, so
        // exactly one more frame() ran after the container was already detached, one frame
        // of stale hook writes past the point a reader would expect this run to be over
        // (oculist-3ae review 1 found this for animateChronoTunnel; same idiom here).
        // Removing here instead, in frame()'s own completion branch, puts removal strictly
        // after the last frame that will ever run, by construction of this single rAF loop,
        // instead of racing a second, unrelated clock against it. There is no
        // cancelAnimationFrame call here — none is needed, since taking this branch means no
        // further frame is ever scheduled.
        //
        // Three things can still remove this container before this branch runs:
        // cancelBeacons() and fadeActiveBeacons() (both via destroyBeacon(), since the
        // container carries .oc-beacon and .oc-beacon-transient) on a new search or a
        // scroll, or this branch itself on normal completion. Whichever fires first wins;
        // container.remove() on an already-detached node is a harmless no-op.
        //
        // Accepted trade (mirrors oculist-3ae review 2): if the tab is hidden, rAF is
        // suspended by the browser and this branch never runs until the tab is shown again,
        // so the container now persists attached instead of being removed by the old
        // wall-clock timer. On resume, one frame runs and removes it — at most one frame of
        // stale streaks, self-healing. The offsetting benefit: while suspended, the
        // container stays reachable by cancelBeacons() (it is still in the DOM), where the
        // old timer would eventually have detached it regardless of tab visibility,
        // permanently outside cancelBeacons()'s reach.
        container.remove();
      }
    }

    animFrameId = requestAnimationFrame(frame);
    container.__rafId = animFrameId;
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
    // Reset every chrono __ocTest hook before the guard below can return early, so a
    // skipped run (rect missing or zero-sized) can never be graded — or, worse, keep
    // accumulating hueSamples — against the previous run's leftover values (oculist-3ae,
    // same gap oculist-47e closed for animateSpeedLines). lastChronoHueRun/lastChronoAnchor
    // reset to null (unambiguous "this run produced nothing"; a real run never writes null
    // back at its own setup, so reading a property off either one after a skipped run
    // throws instead of silently reporting the prior run's hues/anchor).
    // chronoFrameCount resets to 0 and chronoDone to false, mirroring a real run's own
    // setup before its first frame.
    window.__ocTest.lastChronoHueRun = null;
    window.__ocTest.lastChronoAnchor = null;
    window.__ocTest.chronoFrameCount = 0;
    window.__ocTest.chronoDone = false;

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
    container.className = 'oc-beacon oc-beacon-transient';
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
    // lastChronoAnchor exposes the same local-canvas anchor (vpCx, offsetY) every ring and
    // the core glow are drawn relative to, so a test can grade it against the match's own
    // independently-observed rendered position (see test/helpers/effect_anchor.js) rather
    // than only ever checking this effect's internals for self-consistency (oculist-dvt.7).
    window.__ocTest.lastChronoAnchor = { matchX: vpCx, matchY: offsetY };
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
      // Pushed into the same hueSamples array the ring loop above feeds (oculist-dvt.7):
      // without this, a regression that hardcoded coreHue to a fixed value instead of
      // calling hueAt(0, t) would go undetected, since hueSamples would still only ever
      // reflect the ring hues.
      window.__ocTest.lastChronoHueRun.hueSamples.push(coreHue);
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
        // Removal used to be an independently-timed setTimeout(DUR) fired right after the
        // first rAF; that timer consistently fired ~8-16ms before this completing frame,
        // so exactly one more frame() ran after the container was already detached,
        // pushing into whatever __ocTest.lastChronoHueRun a later run had installed by
        // then (oculist-3ae review 1). Removing here instead, in frame()'s own completion
        // branch, puts removal strictly after the last frame that will ever run, by
        // construction of this single rAF loop, instead of racing a second, unrelated
        // clock against it. There is no cancelAnimationFrame call here — none is needed,
        // since taking this branch means no further frame is ever scheduled.
        //
        // Three things can still remove this container before this branch runs:
        // cancelBeacons() and fadeActiveBeacons() (both via destroyBeacon(), since the
        // container carries .oc-beacon and .oc-beacon-transient) on a new search or a
        // scroll, or this branch itself on normal completion. Whichever fires first wins;
        // container.remove() on an already-detached node is a harmless no-op.
        //
        // Accepted trade (oculist-3ae review 2): if the tab is hidden, rAF is suspended by
        // the browser and this branch never runs until the tab is shown again, so the
        // container now persists attached instead of being removed by the old wall-clock
        // timer. On resume, one frame runs and removes it — at most one frame of stale
        // rings, self-healing. The offsetting benefit: while suspended, the container
        // stays reachable by cancelBeacons() (it is still in the DOM), where the old timer
        // would eventually have detached it regardless of tab visibility, permanently
        // outside cancelBeacons()'s reach.
        container.remove();
      }
    }

    animFrameId = requestAnimationFrame(frame);
    container.__rafId = animFrameId;
  }

  // Cyber-Vision: a targeting-HUD sweep over the viewport, resolving down onto the match.
  // Ported from the approved beacon-bench.html reference geometry (the scanline/tint wash,
  // the single downward sweep bar with its hard bright leading edge, the per-column
  // staggered thermal false-colour grid, the four corner brackets snapping in from outside
  // then holding, and the readout beside them) verbatim, with the same departures every DOM
  // effect in this registry makes: viewport-relative geometry converted to document space, a
  // container clamped against the page's own scroll height, and every duration routed
  // through getBeaconDuration(). One of the DOM/WAAPI effects in this batch — uses the
  // container/__waapiAnims pattern the other DOM/WAAPI effects in this registry also use.
  //
  // Scaling follows animateAnimeLaser (content.js:847): getBeaconScale()
  // is applied exactly once, as the container's own transform, anchored on the match centre
  // so the targeting geometry (brackets, thermal grid) grows/shrinks around the match the
  // way AnimeLaser's beam grows/shrinks around it. Every child element below therefore uses
  // a FIXED pixel size — multiplying an already-scaled container's children by scale again
  // is a double-scaling defect (oculist-dvt.8).
  //
  // The four thermal heat colours are the approved mockup's fixed false-colour palette, not
  // derived from getEffectiveColors().beacon — a thermal camera's whole visual point is
  // multiple fixed hues, so recolouring the blocks to a single user beacon colour would
  // undercut the effect's own premise. Every other surface (tint, scanlines, sweep, brackets,
  // readout) rides getEffectiveColors().beacon per the shared beacon contract.
  function animateCyberVision(rect) {
    // Reset the __ocTest hook before the guard below can return early, so a skipped run
    // (rect missing or zero-sized) can never look like a completed run off the previous
    // run's leftover true (oculist-3ae, same gap oculist-47e closed for
    // animateSpeedLines).
    window.__ocTest.cyberVisionBracketsSettled = false;

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
    // animateAnimeLaser uses) and the CURRENT viewport height, so the sweep
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
    container.className = 'oc-beacon oc-beacon-transient';
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
    // (mirrors speedLinesDone/chronoDone; also reset ahead of the zero-rect guard above,
    // oculist-3ae). The brackets' own keyframes (above) reach translate(0,0)
    // — fully snapped in — at offset 0.3 of their delay+duration and hold there until the
    // fade-out; that offset is exact real math derived from this run's own BRACKET_DELAY/
    // BRACKET_DUR, not a guess, so a timeout keyed to it is a genuine completion signal
    // (other DOM/WAAPI effects in this registry instead use .finished — there, "done" IS the animation's
    // end; here "settled" is a mid-animation point .finished cannot express, since waiting
    // for full completion would race the container's own self-removal timeout below, which
    // fires at the same moment the brackets' fade-out actually finishes).
    //
    // This settle timer is a plain setTimeout, not tied to the container's own lifecycle, so
    // it is not cancelled if this run is cancelled early. Two independent paths can cancel
    // it: a new search calls animate() -> cancelBeacons() synchronously before every run
    // (including the one that reset the hook above), which detaches the container via
    // destroyBeacon() immediately — isConnected alone already tells that stale timer (its
    // container already detached) apart from a live one (oculist-3ae review 2). A scroll
    // mid-effect calls fadeActiveBeacons() instead, which does NOT detach synchronously: it
    // fades opacity for 50ms and only removes the container afterward, so this timer can
    // fire with the container still isConnected even though the run was already cancelled
    // (oculist-xi4). __ocCancelled is set synchronously the instant fadeActiveBeacons()
    // starts that fade, so checking it alongside isConnected catches this second path too,
    // without needing the container to have actually been removed yet.
    window.__ocTest.cyberVisionBracketsSettled = false;
    setTimeout(function () {
      if (container.isConnected && !container.__ocCancelled) {
        window.__ocTest.cyberVisionBracketsSettled = true;
      }
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

    if (settings.displayPreset === 'reduced-motion') {
      var scale = getBeaconScale();
      // oculist-4re: cx/cy must be document coordinates (like x/y above), not
      // viewport coordinates, otherwise the mask stays fixed on screen while
      // the match scrolls out from under it. Sizing the overlay to the full
      // document (not just top/left/right/bottom:0, which resolves against the
      // viewport-sized containing block for position:absolute) is the smaller
      // fix and matches how glow/leftArrow/rightArrow already use x/y/w/h.
      var cx = x + w / 2;
      var cy = y + h / 2;
      var sw = Math.max(rect.width + 40, 80) * scale;
      var sh = Math.max(rect.height + 24, 40) * scale;
      var docWidth = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0);
      var docHeight = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);

      var overlay = document.createElement('div');
      overlay.className = 'oc-beacon oc-beacon-transient';
      overlay.style.cssText = [
        'position:absolute', 'top:0', 'left:0',
        'width:' + docWidth + 'px', 'height:' + docHeight + 'px',
        'pointer-events:none', 'z-index:2147483641',
        'background:radial-gradient(ellipse ' + (sw * 2) + 'px ' + (sh * 2) + 'px at ' + cx + 'px ' + cy + 'px, transparent 20%, rgba(28, 25, 22, 0.45) 80%)'
      ].join(';');
      document.documentElement.appendChild(overlay);

      var glow = document.createElement('div');
      glow.className = 'oc-beacon oc-beacon-transient';
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
      leftArrow.className = 'oc-beacon oc-beacon-transient';
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
      rightArrow.className = 'oc-beacon oc-beacon-transient';
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

      // overlay/glow/leftArrow/rightArrow are each their own top-level .oc-beacon
      // element (no shared container) — each needs its own __waapiAnims for
      // cancelBeacons() to reach.
      overlay.__waapiAnims = [overlay.animate([
        { opacity: 0 },
        { opacity: 1, offset: 0.15 },
        { opacity: 1, offset: 0.85 },
        { opacity: 0 }
      ], { duration: duration, fill: 'forwards' })];

      var anim = glow.animate([
        { opacity: 0 },
        { opacity: 1, offset: 0.15 },
        { opacity: 1, offset: 0.85 },
        { opacity: 0 }
      ], { duration: duration, fill: 'forwards' });
      glow.__waapiAnims = [anim];

      leftArrow.__waapiAnims = [leftArrow.animate([
        { opacity: 0, transform: 'translateX(-' + (10 * scale) + 'px)' },
        { opacity: 1, transform: 'translateX(0)', offset: 0.15 },
        { opacity: 1, transform: 'translateX(0)', offset: 0.85 },
        { opacity: 0, transform: 'translateX(-' + (5 * scale) + 'px)' }
      ], { duration: duration, fill: 'forwards' })];

      rightArrow.__waapiAnims = [rightArrow.animate([
        { opacity: 0, transform: 'translateX(' + (10 * scale) + 'px)' },
        { opacity: 1, transform: 'translateX(0)', offset: 0.15 },
        { opacity: 1, transform: 'translateX(0)', offset: 0.85 },
        { opacity: 0, transform: 'translateX(' + (5 * scale) + 'px)' }
      ], { duration: duration, fill: 'forwards' })];

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
    glow.className = 'oc-beacon oc-beacon-transient';
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
    glow.__waapiAnims = [anim];

    anim.finished.then(function () {
      glow.remove();
    }).catch(function () {
      glow.remove();
    });
  }

  // skipEntrance draws straight at opacity:1 with no fade — used by
  // repositionActiveOverlays() (oculist-rrn), which redraws for a settings/resize change
  // that didn't move the match and shouldn't blink it.
  function drawActiveMatchBorder(rect, skipEntrance) {
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
      'opacity:' + (skipEntrance ? '1' : '0')
    ].join(';');
    document.documentElement.appendChild(borderEl);

    if (!skipEntrance) {
      borderEl.__waapiAnims = [borderEl.animate([
        { opacity: 0 },
        { opacity: 1 }
      ], {
        duration: 200,
        fill: 'forwards'
      })];
    }
  }

  function drawActiveMatchShape(rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return;
    
    var palette = (settings.visionSettings && settings.visionSettings.colorPalette) ? settings.visionSettings.colorPalette : 'default';
    var isColorBlind = (palette === 'amber-sky' || palette === 'amber-indigo' || palette === 'rose-cyan');
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

  // skipEntrance: see drawActiveMatchBorder above.
  function drawActiveMatchLabel(rect, skipEntrance) {
    if (!rect || rect.width === 0 || rect.height === 0) return;
    if (!settings.visionSettings || !settings.visionSettings.textLabels) return;

    // Unreachable today, kept defensively (oculist-egy): every caller reaches this
    // through drawActiveOverlays(), and both of ITS callers run cancelBeacons() one
    // statement earlier, which already destroys every .oc-beacon including this label.
    // So `existing` is always null in production. The guard stays because it enforces
    // id uniqueness — one added caller of drawActiveOverlays() and two elements would
    // share #oc-active-match-label, which is worse than the leak. destroyBeacon() and
    // not a bare remove() so that if it ever does run, the label's live 250ms fade-in
    // Animation is cancelled rather than left 'running' on a detached node.
    var existing = document.getElementById('oc-active-match-label');
    if (existing) destroyBeacon(existing);

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
      'opacity:' + (skipEntrance ? '1' : '0')
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

    if (!skipEntrance) {
      label.__waapiAnims = [label.animate([
        { opacity: 0 },
        { opacity: 1 }
      ], {
        duration: 250,
        fill: 'forwards'
      })];
    }
  }

  // Same test-reachability reasoning as window.__ocTest.cancelBeacons above: both of
  // drawActiveMatchLabel's real callers (drawActiveOverlays(), reached only from
  // animate()/repositionActiveOverlays()) call cancelBeacons() immediately beforehand, so
  // a real second draw never actually lands on a pre-existing #oc-active-match-label — the
  // internal destroyBeacon(existing) guard above only fires through a call path a test
  // cannot reach via simulated navigation alone. Exposing the real closure directly lets a
  // test call it twice back-to-back to exercise that guard on its own terms.
  window.__ocTest.drawActiveMatchLabel = drawActiveMatchLabel;

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
  // skipEntrance: see drawActiveMatchBorder above.
  function drawActiveMatchMagnifier(rect, skipEntrance) {
    // Unreachable today, kept defensively — same reasoning as drawActiveMatchLabel's
    // guard above (oculist-egy). It also sits ahead of the decline guards below on
    // purpose, so a call that declines to draw still clears a stale card.
    // destroyBeacon() and not a bare remove() because `existing` is the card, and both
    // the card's own lift/fade Animation and its connector child's fade Animation are
    // hung off card.__waapiAnims (see the "connector is a child of card" comments
    // below), so a bare remove() would strand up to a 470ms lift still 'running'.
    var existing = document.getElementById('oc-active-match-magnifier');
    if (existing) destroyBeacon(existing);

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
    var initialOpacity = (motion === 'off' || skipEntrance) ? '1' : '0';

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

    if (motion === 'off' || skipEntrance) {
      // Opacity (and, for the zoom-lift case, the identity transform default) is
      // already baked into the initial styles above — nothing left to animate.
      return true;
    }

    if (motion === 'reduced') {
      // Fades in at final size and position: no scale, no lift. This is a
      // vision-accessibility product — the magnifier does not get to be the one overlay
      // that ignores the motion settings.
      var fadeDuration = getBeaconDuration(220);
      // connector is a child of card, not itself .oc-beacon — both Animations are hung
      // off card (the element cancelBeacons() actually selects).
      card.__waapiAnims = [
        card.animate([{ opacity: 0 }, { opacity: 1 }], { duration: fadeDuration, fill: 'forwards' }),
        connector.animate([{ opacity: 0 }, { opacity: 1 }], { duration: fadeDuration, fill: 'forwards' })
      ];
      return true;
    }

    // Zoom-lift: render at the match's own position at page font size with opacity 0,
    // scale up and rise ~40px, then the connector to the match fades in last.
    card.style.transformOrigin = placeAbove ? 'bottom center' : 'top center';
    var startScale = Math.min(1, Math.max(0.2, baseFontSize / fontSize));
    var liftPx = 40;
    var liftDuration = getBeaconDuration(320);

    var liftAnim = card.animate([
      { transform: 'translateY(' + liftPx + 'px) scale(' + startScale + ')', opacity: 0 },
      { transform: 'translateY(0px) scale(1)', opacity: 1 }
    ], { duration: liftDuration, easing: 'ease-out', fill: 'forwards' });

    var connectorDuration = getBeaconDuration(150);
    var connectorAnim = connector.animate([
      { opacity: 0 },
      { opacity: 1 }
    ], { duration: connectorDuration, delay: liftDuration, fill: 'forwards' });

    // connector is a child of card, not itself .oc-beacon — both Animations are hung
    // off card (the element cancelBeacons() actually selects).
    card.__waapiAnims = [liftAnim, connectorAnim];

    return true;
  }

  // Same test-reachability reasoning as window.__ocTest.drawActiveMatchLabel above:
  // drawActiveMatchMagnifier's own internal destroyBeacon(existing) guard only fires
  // through a call path (a bare second draw with no intervening cancelBeacons()) a test
  // cannot reach via simulated navigation alone, since its real caller always runs
  // cancelBeacons() first. Exposing the real closure directly lets a test call it twice
  // back-to-back to exercise that guard on its own terms.
  window.__ocTest.drawActiveMatchMagnifier = drawActiveMatchMagnifier;

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
  function drawActiveOverlays(rect, skipEntrance) {
    var motion = effectiveMotion();

    // Draw accessibility overlays (border + label) if motion is not completely off
    if (motion !== 'off') {
      drawActiveMatchBorder(rect, skipEntrance);
    }

    // The magnifier absorbs the "N of M" counter when it draws — both want the same
    // space above the match, so exactly one of them may. Falls back to the plain label
    // when the magnifier declines (off, or a match whose text collapsed to nothing).
    var magnifierDrawn = drawActiveMatchMagnifier(rect, skipEntrance);
    if (!magnifierDrawn) {
      drawActiveMatchLabel(rect, skipEntrance);
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
  //
  // oculist-rrn: also the entry point for an overlay-affecting vision-settings change
  // (see the settings-change caller below), and neither case moves the match relative
  // to the page — so this redraws with skipEntrance=true, drawing the border/label/
  // magnifier straight at their final opacity/position instead of destroy-then-recreate
  // replaying each one's entrance fade/lift. The cancelBeacons() below is what makes
  // add/remove of an overlay (e.g. toggling textLabels) land with no orphans — not the
  // draw* functions' same-id guards, which are dead under this call graph (oculist-egy).
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
    drawActiveOverlays(rect, true);
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
      // oculist-9t5: raise the same "have we drawn since the last reset" flag the
      // full-motion site below raises (identical zero-rect guard, oculist-5rv), so
      // fadeActiveBeacons()'s scroll-path check no longer short-circuits before it can
      // fade a reduced-motion beacon out. Without this, a reduced-motion beacon just
      // sits there until its own multi-second WAAPI animation finishes, long after the
      // user has scrolled on. (The spotlight overlay's own scroll staleness — it used to
      // be position:fixed and centred on a one-shot viewport-coordinate point — was a
      // second, separate reason to fade; oculist-4re fixed that by rendering it in
      // document coordinates, so it now tracks scroll like its siblings.)
      // Fading it out on scroll, same as the full-motion path, is itself a much smaller
      // dose of motion than leaving a stale beacon on screen — and a brief
      // opacity fade is already how this codebase treats "acceptable motion" under
      // 'reduced' elsewhere (see the magnifier's fade-in comment above).
      if (rect && rect.width !== 0 && rect.height !== 0) activeBeacons++;
      animateReducedMotion(rect);
      return;
    }

    // Lite Mode uses the selected effect but scales down the particle counts
    // and complex geometries inside each effect function.
    var effectKey = settings.effect;
    // oculist-tdj: reads availableEffects(), not effectsRegistry directly. This is the
    // actual run-time resolution point for a pack-disabled selection: the coercions
    // below deliberately leave settings.effect untouched when its pack is off (so
    // re-enabling the pack restores the choice), which means THIS lookup is what falls
    // back to hud instead of firing an effect the user currently can't see in the
    // picker. A genuinely-unknown key (never registered at all) falls back here too,
    // same as it always did.
    var effects = availableEffects();
    var effectObj = effects[effectKey] || effects.hud;
    if (effectObj && typeof effectObj.run === 'function') {
      // ponytail: every effectsRegistry entry guards run(rect) with the identical
      // `if (!rect || rect.width === 0 || rect.height === 0) return;` (audited
      // oculist-5rv) before drawing anything, so a zero-metric rect never draws a beacon
      // regardless of which effect is selected. animateSpeedLines() is the one entry
      // where that guard is not the first statement — its oculist-47e hook resets run
      // ahead of it, which is exactly why run() is still called unconditionally below. activeBeacons++ used to fire unconditionally right here,
      // so a guard-skipped run below still counted itself with no matching decrement
      // — a real leak, just not a suppression: activeBeacons is only ever compared to
      // 0 (cancelBeacons resets it; fadeActiveBeacons's scroll-path check
      // short-circuits a querySelectorAll('.oc-beacon-transient') on it), so it's a "have we
      // drawn since the last reset" flag, not a true count, and each leaked increment
      // only cost one wasted querySelectorAll — fadeActiveBeacons() self-heals a pure
      // leak on the first scroll after it, since it zeroes the flag when it finds no
      // beacons in the DOM. Gating
      // just the increment here (rather than a bare early return before this whole
      // block) keeps that flag accurate at its single call site while still always
      // calling run() — animateSpeedLines() relies on being called even on a
      // guard-skipped rect to reset its own __ocTest hooks before its early return
      // (oculist-47e); a bare early return here would silently stop it from ever
      // being invoked on a zero rect, leaving those hooks stale.
      if (rect && rect.width !== 0 && rect.height !== 0) activeBeacons++;
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
          // silently self-matching. Since oculist-39z that helper is a closest() walk,
          // so the cost here is O(depth) per element rather than the O(1) classList
          // comparisons it used to be — still well under the getComputedStyle() this
          // loop already pays per element, but no longer free. The walk itself never
          // changes the answer on this path: traverse() roots at document.body and every
          // Oculist node except wrap mounts on documentElement or head, so nothing with
          // an Oculist ancestor is ever passed in.
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

  // Draft check (oculist-l6m.19), shared by the late working-list merge (oculist-fqti)
  // and the mutation rescan (oculist-3p87): performListSearch()/addChipTerm()/
  // activateChip() always alias searchRanges to termRanges[activeTermIndex] itself —
  // only a real performDraftSearch() builds searchRanges fresh, breaking that identity.
  function isDraftActive() {
    return !!input.value && searchRanges !== termRanges[activeTermIndex];
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

  // Roots that define "ours" — anything at or under one of these is an oculist node.
  // A closest() ancestor walk (rather than an identity/class check on the node itself)
  // is what lets this recognise beacon-descendant elements (e.g. Cyber-Vision's
  // oc-cv-readout, a child of .oc-beacon) and their text-node children, not just the
  // roots themselves. Never widen this to a bare class-prefix match ("oc-*") — real
  // page content is never inside #oc-wrap or a .oc-beacon, so anchoring on these roots
  // is what keeps genuine page mutations from being swallowed.
  var OCULIST_ROOT_SELECTOR = '#oc-wrap, #oc-global-highlight-styles, .oc-beacon, .oc-viewport-marker';

  function isOculistNode(node) {
    if (!node) return false;
    if (node === wrap) return true;
    // Text nodes have no closest() of their own — walk from the parent element instead.
    // A detached removed text node's parentElement is null and this correctly finds
    // nothing; isOculistMutation() covers that case separately via m.target, which is
    // the (still-attached) parent element the removal happened on.
    var el = node.nodeType === 1 ? node : (node.nodeType === 3 ? node.parentElement : null);
    if (!el || typeof el.closest !== 'function') return false;
    return el.closest(OCULIST_ROOT_SELECTOR) !== null;
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

    if (isDraftActive()) {
      // A real draft owns the highlight (oculist-3p87) — a bare performListSearch()
      // would replace searchRanges with the working list's active chip (or nothing),
      // stealing the highlight from the draft the user is actually looking at. But the
      // working list's termRanges/counts/dim registry still need to track the mutated
      // DOM: restoreActiveChip() (what runs when the draft is later cleared) only reads
      // the cached termRanges, it never rescans, so leaving them stale here would surface
      // as a wrong count/highlight the moment the draft ends, not just during it.
      // performListSearch() then performDraftSearch(lastTerm) back to back — both fully
      // synchronous, no await between them — refreshes termRanges/renderChipRow/the dim
      // registry first and then immediately re-asserts the draft's own oculist-match/
      // count/nav-enabled state over it, so the chip-owned intermediate state this
      // produces is never actually painted.
      var previousDraftIndex = activeIndex;
      performListSearch();
      performDraftSearch(lastTerm);
      if (searchRanges.length > 0) {
        activeIndex = Math.min(Math.max(previousDraftIndex, 0), searchRanges.length - 1);
        firstEnter = false;
        // skipScroll: a background rescan re-attaches highlights, it must not yank the
        // viewport back to the match while the user is scrolling elsewhere.
        highlightActiveRange(false, true);
      }
      return;
    }

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

  // ── Pack discovery notice ───────────────────────────────────────────────────────
  //
  // oculist-tdj.3: packs default OFF (settings.enabledPacks starts empty), so once a
  // pack ships (knownPacks(), extension/content.js, returns something) it is otherwise
  // undiscoverable — the settings-panel toggle it lives behind is opt-in UI nobody has a
  // reason to open. This is the single dismissible nudge toward that toggle, chosen over
  // defaulting a pack on.

  // Removes the notice element (if present) and, unless already recorded, marks it
  // permanently answered — settings.packsNoticeDismissed is an ordinary SETTINGS_KEYS
  // member, so this persists through saveSettings()'s normal sync write and, once it
  // syncs, suppresses the notice on every other device too. Called by both the notice's
  // own close control and its "Open Settings" link — either one is "the user has been
  // told", not just the close control alone.
  function dismissPackDiscoveryNotice() {
    if (packNoticeEl) {
      packNoticeEl.remove();
      packNoticeEl = null;
      // oculist-3rq: give #oc-settings-panel/#oc-lists-panel their full space back now that
      // the notice's chrome is gone, rather than leaving their max-height cap permanently
      // shrunk by a notice that no longer exists.
      packNoticeChromePx = 0;
      injectHighlightStyles();
    }
    if (!settings.packsNoticeDismissed) {
      settings.packsNoticeDismissed = true;
      saveSettings();
    }
  }

  // Called once per overlay open (window.__ocToggle()'s build branch, below). A no-op
  // once settings.packsNoticeDismissed is true (the user has already answered — neither
  // "does a pack exist" nor "is a pack enabled"), while no registry entry carries a
  // `pack` yet (knownPacks() empty below — "does a pack exist"), or — oculist-nq1x.3 —
  // while every known pack is already enabled (the loop below — "is a pack enabled").
  // See oculist-tdj.2's knownPacks() for why those last two are deliberately different
  // questions; the settings-panel toggle itself reads the latter too.
  //
  // oculist-nq1x.3: seedHalloweenPack() (extension/background.js, oculist-nq1x.2) turns
  // the Halloween pack ON by default for every install, existing and fresh alike — the
  // human chose that over leaving it opt-in. With Halloween pre-enabled, this notice
  // would otherwise nudge every one of those users toward a toggle that is already on:
  // an interruption that teaches them nothing and costs a dismissal for free. The notice
  // itself stays — a future pack may still ship off by default, and a user who turns
  // Halloween back off is exactly who this still serves — it just no longer fires for a
  // pack that has nothing left to discover. Only suppresses the notice; does NOT set
  // settings.packsNoticeDismissed (that would wrongly answer the prompt for a user who
  // never saw it, permanently hiding it once they later disable the pack).
  //
  // Appended into wrapRoot (the overlay's own shadow root) like showNotice()'s noticeEl
  // above — never document.body — so this can't reflow the host page or be reached by
  // anything outside the .oc- subtree. Deliberately does not call .focus() on anything:
  // buildUI()/window.__ocToggle() already put focus in the find input, and that must
  // stay put (this notice is announced via role="status" instead — see below).
  function maybeShowPackDiscoveryNotice() {
    if (!wrapRoot || packNoticeEl || settings.packsNoticeDismissed) return;
    var known = knownPacks();
    if (known.length === 0) return;

    // Same non-array guard as availableEffects() (oculist-nq1x.1): settings.enabledPacks
    // can be a malformed stored value (a string, a number, null, an object) rather than
    // an array. Degrading that to "nothing enabled" here means a malformed value makes
    // every known pack count as undiscovered — the notice stays eligible to show rather
    // than a corrupt value silently suppressing it forever.
    var enabled = Array.isArray(settings.enabledPacks) ? settings.enabledPacks : [];
    var hasUndiscoveredPack = false;
    for (var i = 0; i < known.length; i++) {
      if (enabled.indexOf(known[i]) === -1) {
        hasUndiscoveredPack = true;
        break;
      }
    }
    if (!hasUndiscoveredPack) return;

    packNoticeEl = document.createElement('div');
    packNoticeEl.className = 'oc-pack-notice';
    // role="status" (an implicit polite live region) announces the text to a screen
    // reader without moving focus — an alertdialog or an explicit focus() call would
    // both yank focus off the find input, which is exactly what must not happen here.
    packNoticeEl.setAttribute('role', 'status');

    var textEl = document.createElement('span');
    textEl.className = 'oc-pack-notice-text';
    textEl.textContent = i18n.packsNoticeText;
    packNoticeEl.appendChild(textEl);

    var ctaEl = document.createElement('button');
    ctaEl.type = 'button';
    ctaEl.className = 'oc-pack-notice-cta';
    ctaEl.textContent = i18n.packsNoticeCta;
    ctaEl.addEventListener('click', function () {
      // Reaching the toggle is itself the answer this prompt was looking for — see
      // dismissPackDiscoveryNotice()'s header comment.
      dismissPackDiscoveryNotice();
      // Same mutual-exclusion step toggleSettings() takes before opening the panel.
      if (listsPanel) { closeListsMenu({ skipFocusReturn: true }); }
      if (!settingsPanel) openSettings();
    });
    packNoticeEl.appendChild(ctaEl);

    var closeEl = document.createElement('button');
    closeEl.type = 'button';
    closeEl.className = 'oc-pack-notice-close';
    closeEl.textContent = '✕';
    closeEl.setAttribute('aria-label', i18n.packsNoticeDismiss);
    closeEl.addEventListener('click', function () {
      dismissPackDiscoveryNotice();
    });
    packNoticeEl.appendChild(closeEl);

    wrapRoot.appendChild(packNoticeEl);

    // oculist-3rq: measure the notice's own rendered height now that it's attached (its CSS
    // is already on wrapRoot — injectHighlightStyles() always runs before this in
    // window.__ocToggle()'s build branch, see packNoticeChromePx's declaration for why that
    // makes this live read safe), then regenerate the dialog stylesheet so #oc-settings-panel/
    // #oc-lists-panel's max-height cap subtracts it too, same as barChromePx already does for
    // the bar.
    packNoticeChromePx = packNoticeEl.getBoundingClientRect().height;
    injectHighlightStyles();

    // Same two-tier motion gate as listsPanel's own entrance animation (buildListsMenu()
    // above): only 'full' runs it, 'reduced' and 'off' both render the notice fully in
    // place with no animate() call at all — "static", not merely a shorter animation.
    if (effectiveMotion() === 'full') {
      packNoticeEl.animate([
        { opacity: 0, transform: 'translateY(-4px)' },
        { opacity: 1, transform: 'translateY(0)' }
      ], {
        duration: 160,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
        fill: 'forwards'
      });
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

    if (!term && !hasActiveChip) {
      // Nothing is or was being searched: no draft in the input, no chip to fall back
      // on. Matches performSearch('')'s own blank (not "no match") count text.
      countEl.textContent = '';
      setNavEnabled(false);
      return;
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
    workListTouchedThisMount = true;
    persistWorkList();
    performListSearch();
  }

  // Removing the active chip moves the pointer to the previous index (index - 1),
  // clamped to 0 so removing the first chip while others remain activates the new
  // leftmost chip rather than clearing. The list-emptying case is handled separately
  // below, which forces -1 regardless of what this clamp computes.
  function removeChipAt(index) {
    if (index < 0 || index >= workListTerms.length) return;
    workListTouchedThisMount = true;
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
    workListTouchedThisMount = true;
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
            // oculist-rbx: the debounce TIMER (as opposed to the listener that schedules
            // it) is closed over per-navigation and has no other module-level handle, so a
            // superseded navigation's already-scheduled 80ms timer survives a listener-only
            // teardown and can still fire onScrollEnd for a match that is no longer
            // active, animate()-ing a stale rect.
            clearActiveScrollHandles();
            // oculist-44y: DISOWN (not cancel) any still-pending immediate-draw timer
            // from a preceding in-viewport/instant navigation — move it out of
            // activeImmediateDrawTimer so a later Site A/B navigation never mistakes it
            // for something IT armed and cancels it. It keeps ticking on its original
            // schedule and, when it fires, calls getBoundingClientRect() fresh — by
            // then this navigation's own scroll has typically moved the viewport
            // already, so it usually draws off-screen or nowhere near where the user
            // is now looking (measured beacon tops as low as -46px in the oculist-7uc
            // scenario), not at some "still correct" position. It is preserved anyway,
            // matching this file's existing tolerance for that kind of redundant draw
            // (verified by superseded_scroll_navigation_no_stale_draw.test.js and
            // superseded_by_in_viewport_navigation_no_stale_draw.test.js, both of which
            // require it to still fire and break if this instead cancels it) — the
            // asymmetry with the in-viewport branch below, which DOES cancel a
            // still-pending immediate-draw timer on entry, is intentional: superseding
            // with ANOTHER immediate navigation lands the new draw within the same
            // 50ms, so the old match's border would appear alongside, and visibly
            // contradict, the match that's actually active. (In-viewport supersession
            // does not scroll at all; the instant branch jumps synchronously before
            // its own draw. Either way the stale border has no moment of being
            // correct.) Superseding with a long smooth scroll does
            // not carry that same expectation, and the timing-invariance case for
            // keeping it holds — a draw that had already landed before 50ms elapsed
            // would stay through the scroll same as any other, so one that merely
            // hasn't fired YET shouldn't be treated differently. "Disowned" must still
            // mean reachable by __ocDestroy(), not "leaked": see
            // orphanedImmediateDrawTimers and disownActiveImmediateDrawTimer() above.
            disownActiveImmediateDrawTimer();

            var scrollTimeout = null;
            // ponytail: native 'scrollend' and the scroll-debounce timer can both
            // fire for one navigation (~47ms apart); this flag makes the handler
            // idempotent so animate() only tears down/redraws once per navigation.
            var scrollEndFired = false;
            var onScrollEnd = function () {
              if (scrollEndFired) return;
              scrollEndFired = true;
              if (scrollTimeout) clearTimeout(scrollTimeout);
              if (scrollDebounceTimer) clearTimeout(scrollDebounceTimer);
              if (activeScrollTimeout === scrollTimeout) activeScrollTimeout = null;
              if (activeScrollDebounceTimer === scrollDebounceTimer) activeScrollDebounceTimer = null;
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
              activeScrollDebounceTimer = scrollDebounceTimer;
            };

            scrollTimeout = setTimeout(onScrollEnd, 600);
            activeScrollTimeout = scrollTimeout;
            activeScrollEndHandler = onScrollEnd;
            activeScrollDebounceHandler = onScrollEndDebounced;

            window.addEventListener('scrollend', onScrollEnd, { once: true });
            window.addEventListener('scroll', onScrollEndDebounced);
          } else {
            // oculist-44y: same hazard oculist-rbx/tz6/7uc fixed elsewhere in this
            // function — this bare timer had no module-level handle, so no teardown
            // (not __ocDestroy(), not a superseding navigation) could cancel it.
            // Registered into activeImmediateDrawTimer (see its declaration above for
            // why it's a dedicated handle, not folded into clearActiveScrollHandles()).
            clearActiveImmediateDrawTimer();
            var instantDrawTimer = setTimeout(function () {
              forgetFiredImmediateDrawTimer(instantDrawTimer);
              var freshRect = activeRange.getBoundingClientRect();
              animate(freshRect);
            }, 50);
            activeImmediateDrawTimer = instantDrawTimer;
          }
        }
        element.scrollIntoView({
          behavior: behavior,
          block: 'center',
          inline: 'nearest'
        });
      }
    } else {
      // oculist-7uc: same hazard oculist-rbx fixed at the smooth-scroll branch entry above,
      // reached via a third path — a navigation superseding an in-flight smooth scroll whose
      // OWN match is already in the viewport takes this branch instead, so without this
      // teardown the superseded navigation's four handles (and its still-running native
      // scrollIntoView animation) are left live and its orphaned timer/scrollend can still
      // animate() a stale rect over the draw below.
      clearActiveScrollHandles();
      if (shouldAnimate) {
        // oculist-44y: same hazard as the instant-behavior branch above — this bare
        // timer had no module-level handle, so a second in-viewport navigation less
        // than 50ms later left it orphaned to paint a stale rect later. Registered
        // into activeImmediateDrawTimer so the next Site A/B navigation, or
        // __ocDestroy(), cancels it (see that variable's declaration above for why
        // it's kept separate from clearActiveScrollHandles()'s four handles).
        clearActiveImmediateDrawTimer();
        var inViewDrawTimer = setTimeout(function () {
          forgetFiredImmediateDrawTimer(inViewDrawTimer);
          var freshRect = activeRange.getBoundingClientRect();
          animate(freshRect);
        }, 50);
        activeImmediateDrawTimer = inViewDrawTimer;
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

  // oculist-z8n: isAutoScrolling used to expire on a flat 800ms timer measured from the
  // moment the auto-scroll started, regardless of how long the browser's own smooth
  // scrollIntoView animation actually ran. Chrome's native smooth scroll can run well past
  // 800ms on an ordinary distance (measured: 1034ms at 3000px, 1546ms at 12000px), so on a
  // long enough scroll the suppression closed while the scroll was still in flight, and the
  // extension's own trailing 'scroll' events reached handleScroll() with isAutoScrolling
  // already false — fading a beacon that had only just been drawn.
  //
  // Same last-event-plus-grace-period idiom as onScrollEndDebounced/onScrollEnd above: the
  // grace timer is re-armed on every real 'scroll' event, so the flag stays live for
  // whatever the auto-scroll's actual duration turns out to be, and clears immediately on
  // native 'scrollend' when that fires. It still always terminates even if 'scrollend'
  // never fires: once scroll events genuinely stop arriving, the grace timer runs out on
  // its own 300ms later.
  function clearAutoScrollFlag() {
    isAutoScrolling = false;
    if (autoScrollTimer) { clearTimeout(autoScrollTimer); autoScrollTimer = null; }
    window.removeEventListener('scrollend', clearAutoScrollFlag);
    window.removeEventListener('scroll', extendAutoScrollFlag);
  }

  function extendAutoScrollFlag() {
    if (autoScrollTimer) clearTimeout(autoScrollTimer);
    autoScrollTimer = setTimeout(clearAutoScrollFlag, 300);
  }

  function triggerAutoScrollFlag() {
    isAutoScrolling = true;
    // Re-entrant-safe: a navigation superseding an already-in-flight auto-scroll removes
    // the previous listeners before re-adding, rather than accumulating duplicates.
    window.removeEventListener('scrollend', clearAutoScrollFlag);
    window.removeEventListener('scroll', extendAutoScrollFlag);
    if (autoScrollTimer) clearTimeout(autoScrollTimer);
    window.addEventListener('scrollend', clearAutoScrollFlag, { once: true });
    window.addEventListener('scroll', extendAutoScrollFlag);
    autoScrollTimer = setTimeout(clearAutoScrollFlag, 300);
  }

  // Same test-reachability reasoning as window.__ocTest.getDebounceTimer above (see its
  // comment near the top of this closure): autoScrollTimer is a plain closure variable with
  // no other way for a test to observe whether the grace timer armed by
  // triggerAutoScrollFlag()/extendAutoScrollFlag() is still pending. oculist-30k's
  // regression test polls this after __ocDestroy() on a continuously-scrolling page: if the
  // 'scroll' listener were still attached (the bug), further scroll events would keep
  // re-arming this to a fresh non-null value; if __ocDestroy() has torn it down via
  // clearAutoScrollFlag(), it stays null no matter how much more scrolling follows.
  window.__ocTest.getAutoScrollTimer = function () { return autoScrollTimer; };

  function fadeActiveBeacons() {
    if (activeBeacons === 0) return;
    // Only the transient beacon effects, not the persistent accessibility overlays
    // (border/shape/label/magnifier) that drawActiveOverlays() also tags .oc-beacon —
    // those track scroll correctly in document coordinates and must survive it.
    var beacons = document.querySelectorAll('.oc-beacon-transient');
    if (beacons.length === 0) { activeBeacons = 0; return; }
    activeBeacons = 0;
    for (var i = 0; i < beacons.length; i++) {
      var b = beacons[i];
      // Marked the instant the fade starts, not at removal 50ms later (oculist-xi4) — this
      // beacon is logically cancelled right now, but stays isConnected for another 50ms, and
      // any settle-style flag a beacon schedules off its own duration (animateCyberVision's
      // cyberVisionBracketsSettled) needs a way to tell "cancelled, still attached" apart
      // from "genuinely still live" that does not depend on detachment.
      b.__ocCancelled = true;
      b.style.transition = 'opacity 50ms ease-out';
      b.style.opacity = '0';
    }
    setTimeout(function () {
      for (var i = 0; i < beacons.length; i++) {
        if (beacons[i] && beacons[i].parentNode && beacons[i].style.opacity === '0') {
          // During the fade the beacon is still attached, so cancelBeacons() can still
          // reach it — there is no orphan window until the removal itself. Cancelling
          // at fade start instead of here would freeze the animation mid-fade, a
          // gratuitous visual change. destroyBeacon() cancels and removes in the same
          // statement, closing the window where a detached element is still animating
          // and no longer findable via querySelectorAll('.oc-beacon').
          destroyBeacon(beacons[i]);
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
    var isColorBlind = (palette === 'amber-sky' || palette === 'amber-indigo' || palette === 'rose-cyan');
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
  //
  // oculist-01sj: this used to reach cancelBeacons() only through the 100ms debounce below
  // (overlayResizeTimer), which a continuous resize drag keeps resetting on every event — so
  // an effect's own transient beacons could paint against a reflowed #match for the whole
  // drag. Front sparkles are the case that exposed it: unlike backWrap/arrowShot/vineSwing,
  // they carry no per-effect hard-cut resize listener of their own (see hardCutBackWrap's own
  // comment), so cancelBeacons() was their only teardown path, and it never ran until the
  // debounce settled. Cancel on the LEADING edge instead: overlayResizeTimer is null only at
  // the start of a new burst (its own setTimeout callback nulls it back out once it fires, see
  // below), never mid-burst, so this fires once per burst, not once per event.
  //
  // '.oc-beacon-transient' ONLY on that leading-edge call (review fix, same bead): the default
  // '.oc-beacon' selector also matches the persistent Low Vision overlays (border/shape/label/
  // magnifier) that drawActiveOverlays() tags .oc-beacon — those track resize correctly on
  // their own and have no redraw scheduled to replace them until the debounce settles, so the
  // full selector here would blank them for the whole drag, or for good if
  // repositionActiveOverlays() returns early (no active match). The trailing, debounced
  // repositionActiveOverlays() below still does the redraw once the drag settles — the final
  // rect isn't known until then — and its own cancelBeacons() call (the default '.oc-beacon'
  // selector) is NOT a no-op by that point: the transients are already gone, so it is what
  // removes the persistent overlays themselves, immediately before drawActiveOverlays()
  // redraws them in place.
  function handleResize() {
    if (!overlayResizeTimer) cancelBeacons('.oc-beacon-transient');
    scheduleViewportMarkersUpdate();
    if (overlayResizeTimer) clearTimeout(overlayResizeTimer);
    overlayResizeTimer = setTimeout(function () {
      overlayResizeTimer = null;
      repositionActiveOverlays();
    }, 100);
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
          // Land on match 0 (or the last match, backwards) — firstEnter is guaranteed true
          // here (oculist-l6m.18): commitResult.committed is only true when addChipTerm()
          // ran performListSearch() synchronously just above (via the push path or
          // activateChip()), and performListSearch() itself unconditionally sets
          // firstEnter = true whenever searchRanges.length > 0. Nothing runs between that
          // call and here that could flip it back, so the old "else" branch that carried
          // activeIndex forward from a previous scan was dead code; verified by reading
          // performListSearch()/maybeAddChipFromInput()/addChipTerm()/activateChip(), which
          // are synchronous end-to-end with no path that resets firstEnter in between.
          if (searchRanges.length > 0) {
            firstEnter = false;
            activeIndex = e.shiftKey ? searchRanges.length - 1 : 0;
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

  // oculist-gw7b: optional `groups` param — an ordered array of
  // { id, label, values: [item.value, ...] } — lets a caller (the Highlight Effect field)
  // render its items under per-pack subheadings while staying ONE radio group: every row,
  // grouped or not, still gets the same `groupKey + ':' + value` data-oc-key, the same
  // click handler that clears every `.oc-radio-item` list-wide via list.querySelectorAll
  // (a descendant query, unaffected by the extra nesting), and the same disabled/opacity
  // handling on the outer list. Callers decide sort order (both which items land in which
  // group, and the order within each) — this function only decides where to draw the
  // group boundaries and whether a boundary gets a subheading at all.
  //
  // Any item not named in `groups[].values` renders first, in the order given, with no
  // wrapper — built-ins get no subheading (orchestrator decision, oculist-gw7b). A group
  // whose `values` list is empty (its pack is disabled, or has nothing available right
  // now) is skipped entirely: no heading, no empty role="group" wrapper. The heading is a
  // plain, non-focusable <div> (not a <button>, no tabindex) so it is never a Tab stop —
  // native Tab order still walks the flat sequence of `.oc-radio-item` buttons exactly as
  // it did before grouping existed. Deliberately aria-labelledby (not aria-label): unlike
  // #oc-settings-panel's own label (see its comment above, `role="dialog"` block), this
  // heading carries no CSS text-transform, so Blink's aria-labelledby name computation
  // reads plain sentence-case text — the transform pitfall documented there doesn't apply.
  function makeRadioList(items, currentVal, onChange, disabled, groupKey, groups) {
    var list = document.createElement('div');
    list.className = 'oc-radio-list';
    if (disabled) {
      list.style.opacity = '0.5';
      list.style.pointerEvents = 'none';
    }

    function makeRow(item) {
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
      return row;
    }

    if (!groups || !groups.length) {
      items.forEach(function (item) { list.appendChild(makeRow(item)); });
      return list;
    }

    var grouped = {};
    groups.forEach(function (g) {
      g.values.forEach(function (v) { grouped[v] = g.id; });
    });

    items.forEach(function (item) {
      if (!grouped.hasOwnProperty(item.value)) list.appendChild(makeRow(item));
    });

    groups.forEach(function (g) {
      var groupItems = g.values
        .map(function (v) {
          return items.filter(function (item) { return item.value === v; })[0];
        })
        .filter(Boolean);
      if (!groupItems.length) return; // disabled/empty pack: no heading, no empty group

      var headingId = 'oc-radio-group-' + groupKey + '-' + g.id;
      var heading = document.createElement('div');
      heading.className = 'oc-radio-group-heading';
      heading.id = headingId;
      heading.textContent = g.label;
      list.appendChild(heading);

      var wrapper = document.createElement('div');
      wrapper.className = 'oc-radio-group';
      wrapper.setAttribute('role', 'group');
      wrapper.setAttribute('aria-labelledby', headingId);
      groupItems.forEach(function (item) { wrapper.appendChild(makeRow(item)); });
      list.appendChild(wrapper);
    });

    return list;
  }

  // oculist-gw7b: makeRadioList's `groups` param is exercised directly (synthetic items,
  // including a deliberately-empty group) by the jsdom unit test — no real registry/pack
  // fixture needed just to prove the grouping/empty-group-skip mechanics.
  window.__ocTest.makeRadioList = makeRadioList;

  // oculist-tdj.2: multi-select sibling of makeRadioList above — same native-<button>-
  // per-row shape (so Enter/Space/Tab all work for free, per settings_panel_enter_
  // activation.test.js) and the same groupKey + ':' + value data-oc-key convention (so
  // rebuildSettingsPanelPreservingFocus() can re-resolve a checked row after a rebuild),
  // but each row toggles independently instead of exclusively selecting one.
  function makeCheckboxList(items, checkedValues, onToggle, groupKey) {
    var list = document.createElement('div');
    list.className = 'oc-checkbox-list';

    items.forEach(function (item) {
      var checked = checkedValues.indexOf(item.value) !== -1;

      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'oc-checkbox-item' + (checked ? ' active' : '');
      // role="checkbox" + aria-checked on a real <button>: a button's native keyboard
      // activation (Enter/Space) is kept, its exposed role is overridden to match what
      // it visually is. See oc-radio-item above for the same real-<button> rationale.
      row.setAttribute('role', 'checkbox');
      row.setAttribute('aria-checked', String(checked));
      if (groupKey) row.setAttribute('data-oc-key', groupKey + ':' + item.value);

      var box = document.createElement('span');
      box.className = 'oc-checkbox-box';
      box.setAttribute('aria-hidden', 'true');
      box.textContent = checked ? '☑' : '☐';

      var lbl = document.createElement('span');
      lbl.textContent = item.label;

      row.appendChild(box);
      row.appendChild(lbl);
      row.addEventListener('click', function () {
        onToggle(item.value, !checked);
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

  function getProfileConstraints() {
    var p = settings.displayPreset;
    return {
      effectDisabled: !!(p === 'reduced-motion'),
      colorsDisabled: !!(p && (p === 'reduced-motion' || p === 'rg-adjust-deut' || p === 'rg-adjust-prot' || p === 'by-adjust'))
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
    // The ↺ glyph is decorative. Left as a bare text node, it becomes part of the
    // button's accessible name (a screen reader would announce something like "circled
    // anticlockwise arrow Reset") — wrap it in its own aria-hidden span so the accessible
    // name is just "Reset", matching i18n.resetBtn.
    var resetBtnGlyph = document.createElement('span');
    resetBtnGlyph.setAttribute('aria-hidden', 'true');
    resetBtnGlyph.textContent = '↺ ';
    resetBtn.appendChild(resetBtnGlyph);
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
      rebuildSettingsPanelPreservingFocus();
    });
    header.appendChild(resetBtn);
    settingsPanel.appendChild(header);

    if (settings.displayPreset) {
      var banner = document.createElement('div');
      banner.className = 'oc-settings-profile-banner';
      banner.style.cssText = 'background: rgba(245, 158, 11, 0.08); border: 1px solid rgba(245, 158, 11, 0.2); padding: 8px 12px; font-size: 11px; color: #fbbf24; margin: 8px 16px 0; border-radius: 6px; display: flex; align-items: center; gap: 6px; font-weight: 500;';

      // oculist-rnr.12 (review fix, gap 3): reverted to the original clinical wording here —
      // storage must be functional, but the UI banner is explicitly allowed to keep the named
      // affordance (rnr.13 owns UI wording). Only the field name (displayPreset) changed.
      var profileDisplay = settings.displayPreset === 'reduced-motion' ? 'Eye Strain' : settings.displayPreset === 'high-contrast' ? 'Low Vision' : 'Color Blind';
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
    // oculist-tdj: availableEffects(), not effectsRegistry — a pack-disabled entry must
    // not be offered here, or picking it would look valid but silently fall back to hud.
    var pickerEffects = availableEffects();
    for (var key in pickerEffects) {
      if (pickerEffects.hasOwnProperty(key)) {
        effectOptions.push({ value: key, label: pickerEffects[key].label, pack: pickerEffects[key].pack || null });
      }
    }
    function byEffectLabel(a, b) { return a.label.localeCompare(b.label); }

    // oculist-gw7b: split into built-ins (no pack, rendered first, no subheading — see
    // makeRadioList's banner) and one group per pack, groups ordered like knownPacks()
    // (registry insertion order) rather than alphabetically by pack label, so a pack's
    // position here matches its position in the pack-toggle list below. Each list is
    // alphabetical by label within itself. availableEffects() already excludes a
    // disabled pack's entries, so effectOptions simply has nothing left for that pack's
    // id here — makeRadioList's own empty-group guard is what turns that into "no
    // subheading" rather than a check made twice.
    var effectOptionsSorted = effectOptions.filter(function (o) { return !o.pack; }).sort(byEffectLabel);
    var effectPackGroups = knownPacks().map(function (packId) {
      var values = effectOptions
        .filter(function (o) { return o.pack === packId; })
        .sort(byEffectLabel)
        .map(function (o) { return o.value; });
      return { id: packId, label: packLabel(packId), values: values };
    });
    effectPackGroups.forEach(function (g) {
      g.values.forEach(function (v) {
        effectOptionsSorted.push(effectOptions.filter(function (o) { return o.value === v; })[0]);
      });
    });

    var constraints = getProfileConstraints();
    var effColors = getEffectiveColors();

    var effectField = makeSettingsField(i18n.highlightEffect, i18n.effectDesc, makeRadioList(
      effectOptionsSorted,
      settings.effect,
      function (v) { settings.effect = v; saveSettings(); },
      constraints.effectDisabled,
      'effect',
      effectPackGroups
    ));
    effectField.style.marginTop = '8px';
    col1.appendChild(effectField);

    // oculist-tdj.2: the pack toggle list. Empty (no registry entry carries a `pack` yet,
    // per oculist-tdj.1) means knownPacks() returns [] and this whole field is skipped —
    // deliberately no empty section header rendered for a feature with nothing to offer.
    var packIds = knownPacks();
    if (packIds.length) {
      var packOptions = packIds.map(function (id) {
        return { value: id, label: packLabel(id) };
      });
      packOptions.sort(function (a, b) {
        return a.label.localeCompare(b.label);
      });

      var packsField = makeSettingsField(i18n.packsLabel, i18n.packsDesc, makeCheckboxList(
        packOptions,
        settings.enabledPacks || [],
        function (packId, nowChecked) {
          if (!Array.isArray(settings.enabledPacks)) settings.enabledPacks = [];
          var idx = settings.enabledPacks.indexOf(packId);
          if (nowChecked) {
            if (idx === -1) settings.enabledPacks.push(packId);
          } else if (idx !== -1) {
            settings.enabledPacks.splice(idx, 1);
          }
          saveSettings();
          // Rebuilds in place (same path as theme/position/reset above) so the effect
          // picker's options — sourced from availableEffects(), which reads
          // settings.enabledPacks — reflect the new pack state immediately, no reload.
          rebuildSettingsPanelPreservingFocus();
        },
        'pack'
      ));
      packsField.style.marginTop = '8px';
      col1.appendChild(packsField);
    }

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
    workListTouchedThisMount = true;
    workListReplacedThisMount = true;
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
    mountGeneration += 1;
    var ownMountGeneration = mountGeneration;
    workListTouchedThisMount = false;
    workListReplacedThisMount = false;

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
      // The mountGeneration check catches the further case (oculist-3z6) where the overlay
      // was ALSO reopened before this call landed: wrapRoot/chipRow are non-null again by
      // then, but they belong to a newer mount whose own loadWorkList() call already
      // restored the real list — this stale one must not clobber it.
      if (!wrapRoot || !chipRow || ownMountGeneration !== mountGeneration) return;

      if (workListReplacedThisMount) {
        // loadSavedList() already replaced AND persisted the working list this mount —
        // this stale restore is not "terms added this mount" to merge with, it is exactly
        // the carried-over list loadSavedList's own no-confirmation replace was meant to
        // discard. Drop it outright: no merge, no second search, no second save.
        return;
      }

      if (!workListTouchedThisMount) {
        // Untouched: nobody has committed a chip action against this mount yet, so this is
        // a plain restore, byte-for-byte as before — must never trigger a search.
        workListTerms = list.terms;
        activeTermIndex = list.activeIndex;
        // No scan has run against this term set yet, so termRanges must not carry over any
        // stale entries from before this mount — see the "every writer of activeTermIndex"
        // note in performListSearch() for the invariant this upholds without scanning.
        termRanges = [];
        termStarved = [];
        renderChipRow();
        return;
      }

      if (workListTerms.length === 0) {
        // Touched, but the user's own actions (e.g. add then remove) already emptied the
        // list — that emptiness IS the user's current deliberate state (already persisted
        // by whichever writer got it there), so this stale load must be dropped rather than
        // resurrecting whatever was on disk before this mount started.
        return;
      }

      // Touched and non-empty: the user already committed at least one chip action (and
      // its own performListSearch() scan) before this late load landed. Merge rather than
      // overwrite — restored terms first (oldest committed order), then whatever the user
      // added this mount that isn't already in the restored list, deduped exactly like
      // addChipTerm()'s workListTerms.indexOf() check. The chip active in memory stays
      // active. A real scan has already run this mount, so re-running performListSearch()
      // here (unlike the untouched branch above) is fine — it also brings the restored
      // terms' counts up to date in the same synchronous pass, so nothing renders blank in
      // between.
      var activeTermValue = (activeTermIndex >= 0 && activeTermIndex < workListTerms.length)
        ? workListTerms[activeTermIndex]
        : null;
      // isDraftActive() (oculist-l6m.19) must be read before workListTerms/termRanges/
      // termStarved below are reassigned to the merged values — capture the pre-merge
      // arrays it needs alongside it.
      var oldWorkListTerms = workListTerms;
      var oldTermRanges = termRanges;
      var oldTermStarved = termStarved;
      var draftActive = isDraftActive();
      var restoredTerms = list.terms.slice();
      var addedSinceMount = workListTerms.filter(function (t) {
        return restoredTerms.indexOf(t) === -1;
      });
      // The 10-term cap trims the RESTORED side, never the user's own terms — the user
      // already sees and is acting on their own chips this mount; a restored term they've
      // never seen yet is the one that should give way when both sides can't fit.
      var keepRestored = Math.max(0, MAX_LIST_TERMS - addedSinceMount.length);
      var trimmedRestored;
      if (restoredTerms.length <= keepRestored) {
        trimmedRestored = restoredTerms;
      } else {
        // A restored term whose value the user also typed this mount is deduped into
        // addChipTerm()'s existing chip, not addedSinceMount — keep it regardless of
        // position; cut only terms with no matching user term (oculist-fqti).
        var protectedCount = restoredTerms.filter(function (t) {
          return workListTerms.indexOf(t) !== -1;
        }).length;
        var unprotectedBudget = keepRestored - protectedCount;
        trimmedRestored = [];
        for (var ri = 0; ri < restoredTerms.length; ri++) {
          var rt = restoredTerms[ri];
          if (workListTerms.indexOf(rt) !== -1) {
            trimmedRestored.push(rt);
          } else if (unprotectedBudget > 0) {
            trimmedRestored.push(rt);
            unprotectedBudget--;
          }
        }
      }
      var mergedTerms = trimmedRestored.concat(addedSinceMount);

      workListTerms = mergedTerms;
      if (activeTermValue !== null && mergedTerms.indexOf(activeTermValue) !== -1) {
        activeTermIndex = mergedTerms.indexOf(activeTermValue);
      } else {
        activeTermIndex = (list.activeIndex >= 0 && list.activeIndex < mergedTerms.length)
          ? list.activeIndex
          : -1;
      }

      if (!draftActive) {
        // Preserve a next-match position the same way rescanAfterMutation() already does
        // for a background DOM rescan: a plain performListSearch() call always resets
        // activeIndex to -1, which would otherwise roll a pressed next-match back to 0.
        var previousActiveIndex = activeIndex;
        performListSearch();
        if (previousActiveIndex >= 0 && searchRanges.length > 0) {
          activeIndex = Math.min(previousActiveIndex, searchRanges.length - 1);
          firstEnter = false;
          highlightActiveRange(false, true);
        }
      } else {
        // A draft owns the highlight — skip the rescan so it survives; the next natural
        // trigger picks the merged terms up. Still realign termRanges/termStarved by term
        // value so a scanned term doesn't inherit another term's stale slot (oculist-fqti).
        var remappedRanges = new Array(mergedTerms.length);
        var remappedStarved = new Array(mergedTerms.length);
        for (var mi = 0; mi < mergedTerms.length; mi++) {
          var oldIdx = oldWorkListTerms.indexOf(mergedTerms[mi]);
          if (oldIdx !== -1) {
            remappedRanges[mi] = oldTermRanges[oldIdx];
            remappedStarved[mi] = oldTermStarved[oldIdx];
          }
        }
        termRanges = remappedRanges;
        termStarved = remappedStarved;
        renderChipRow();
      }
      persistWorkList();
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
      '  --oc-palette-amber-sky-match: #fef08a;',
      '  --oc-palette-amber-sky-active: #0284c7;',
      '  --oc-palette-amber-sky-beacon: #0284c7;',
      '  --oc-palette-amber-indigo-match: #fef08a;',
      '  --oc-palette-amber-indigo-active: #2563eb;',
      '  --oc-palette-amber-indigo-beacon: #2563eb;',
      '  --oc-palette-rose-cyan-match: #ffcbd1;',
      '  --oc-palette-rose-cyan-active: #06b6d4;',
      '  --oc-palette-rose-cyan-beacon: #06b6d4;',
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
      // bar's actual tallest child — not '.oc-bar button' (pinned to a fixed 26px below,
      // font-size/DPI/OS-independent) but input.oc-input (height: auto, ~27px from its
      // 4px+4px padding, 14px font's line box, and 1px border) — + :host's own 1px top +
      // 1px bottom border, for a total of ~41px. 44px rounds that up, leaving ~3px of slack
      // for cross-platform subpixel rounding rather than the tight margin the original
      // comment's (wrong) 26px-tallest-child arithmetic implied (oculist-7de review).
      var barChromePx = 44;
      // oculist-3rq: the total chrome above #oc-settings-panel/#oc-lists-panel — the bar
      // (barChromePx, fixed) plus the pack-discovery notice when it's showing
      // (packNoticeChromePx, live-measured, 0 otherwise; see its declaration). Both panels'
      // max-height caps use this combined figure so bar + notice + panel always fit the
      // viewport together, the same way bar + panel already did before the notice existed.
      var hostChromePx = barChromePx + packNoticeChromePx;

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
        // Capping this panel at 100vh minus the host chrome above it (hostChromePx, above —
        // the bar, plus the pack-discovery notice whenever it's showing, oculist-3rq) keeps
        // panel + bar (+ notice) together within the viewport regardless of which of the four
        // positions is active — the same numeric cap applies to all four since neither
        // contribution to total host height depends on which edge it is anchored to.
        '  max-height: calc(100vh - ' + hostChromePx + 'px);',
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
        // height/overflow-y above). Likely inert in practice — a flex item's default
        // min-height:auto already resolves to its content's height for a plain block like
        // this header (nothing here sets its own overflow), which independently stops it
        // shrinking below that regardless of flex-shrink. Left in as cheap defense should
        // that stop holding (e.g. if the header ever gains its own overflow) rather than for
        // the squash-prevention effect the original comment claimed (oculist-7de review).
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
        // oculist-6cd: same flex-shrink: 0 as .oc-settings-header above, and just as likely
        // inert for the same reason — min-height:auto already pins the grid at its content
        // height since nothing sets overflow on it either. Left in as the same cheap defense,
        // not because it's doing the work of keeping this content at natural height
        // (oculist-7de review corrects the original comment's overstated claim here).
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
        // oculist-nlp8: the generic 'button:hover' rule above applies transform: scale(1.05)
        // to every <button>, including this one — .oc-radio-item is a full-width row
        // (width: 100%) inside .oc-radio-list, a scrolling container (overflow-y: auto,
        // which per the CSS overflow spec makes the unset overflow-x compute to auto too).
        // Scaling a full-width row up on hover pushed its painted box past the list's right
        // edge, growing scrollWidth past clientWidth and popping a horizontal scrollbar for
        // as long as the pointer stayed over any row. Pinning transform: none here reserves
        // the same box in both states — hover feedback still comes through via
        // background/opacity above, just without the growth.
        '.oc-radio-item:hover {',
        '  background: var(--oc-btn-hover-bg);',
        '  opacity: 1;',
        '  transform: none;',
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
        // oculist-gw7b: pack subheading inside .oc-radio-list (makeRadioList). No
        // text-transform here — the aria-labelledby wiring on .oc-radio-group below reads
        // this element's text directly for its computed accessible name, and Blink applies
        // CSS text-transform when computing a name from a *referenced* element (see
        // #oc-settings-panel's own aria-label comment above for the same pitfall). Do not
        // add text-transform: uppercase (or similar) to this rule.
        '.oc-radio-group-heading {',
        '  font-size: .7rem;',
        '  font-weight: 600;',
        '  letter-spacing: 0.04em;',
        '  color: var(--oc-subtle);',
        '  padding: 6px 8px 2px;',
        '  flex-shrink: 0;',
        '}',
        // Same flex-shrink: 0 rationale as .oc-radio-item above (oculist-dvt.5) — this
        // wrapper is itself a flex item of the scrolling .oc-radio-list column and must not
        // get squashed to fit.
        '.oc-radio-group {',
        '  display: flex;',
        '  flex-direction: column;',
        '  gap: 2px;',
        '  flex-shrink: 0;',
        '}',
        // oculist-tdj.2: same capped-scroll idiom as .oc-radio-list (oculist-dvt.5) —
        // this list renders one row per known pack (see knownPacks()), and a
        // future pack list should not be able to regrow the whole-panel overflow problem
        // .oc-radio-list already had to fix once.
        '.oc-checkbox-list {',
        '  display: flex;',
        '  flex-direction: column;',
        '  gap: 2px;',
        '  max-height: 160px;',
        '  overflow-y: auto;',
        '}',
        '.oc-checkbox-item {',
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
        '  flex-shrink: 0;',
        '  transition: background-color 120ms, opacity 120ms, color 120ms;',
        '}',
        // oculist-nlp8: same fix, same cause as .oc-radio-item:hover above — this is the
        // Packs checkbox list's full-width row, in a scrolling .oc-checkbox-list container,
        // hit by the same generic 'button:hover' transform: scale(1.05).
        '.oc-checkbox-item:hover {',
        '  background: var(--oc-btn-hover-bg);',
        '  opacity: 1;',
        '  transform: none;',
        '}',
        '.oc-checkbox-item.active {',
        '  color: var(--oc-accent);',
        '  opacity: 1;',
        '}',
        '.oc-checkbox-box {',
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
        // oculist-tdj.3: same width:0 + min-width:100% shadow-host-stretch guard as
        // .oc-notice above, same reasoning.
        '.oc-pack-notice {',
        '  display: flex;',
        '  align-items: center;',
        '  flex-wrap: wrap;',
        '  gap: 6px 10px;',
        '  padding: 6px 10px;',
        '  width: 0;',
        '  min-width: 100%;',
        '  box-sizing: border-box;',
        '  font: 12px/1.4 system-ui, -apple-system, sans-serif;',
        '  background: ' + t.bg + ';',
        '  color: ' + t.text + ';',
        '  border-top: 1px solid ' + t.divider + ';',
        '  border-left: 3px solid var(--oc-accent);',
        '}',
        '.oc-pack-notice-text {',
        '  flex: 1;',
        '  min-width: 120px;',
        '  opacity: 0.85;',
        '}',
        // Real <button>s (unlike .oc-notice-close, a plain <span>) — reset every default
        // button chrome property so they read as the same quiet inline controls, per the
        // "small, quiet, easy to get rid of" brief.
        '.oc-pack-notice-cta, .oc-pack-notice-close {',
        '  flex-shrink: 0;',
        '  border: none;',
        '  background: transparent;',
        '  font: inherit;',
        '  cursor: pointer;',
        '  padding: 0;',
        '  margin: 0;',
        '}',
        '.oc-pack-notice-cta {',
        '  color: var(--oc-accent);',
        '  font-weight: 600;',
        '  text-decoration: underline;',
        '}',
        '.oc-pack-notice-cta:hover {',
        '  opacity: 0.85;',
        '}',
        '.oc-pack-notice-close {',
        '  color: ' + t.text + ';',
        '  opacity: 0.6;',
        '  font-size: 13px;',
        '}',
        '.oc-pack-notice-close:hover {',
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
        // oculist-7de: was a flat 320px, which only bounds the host (bar + this panel, both
        // position: fixed with no scrollable ancestor per :host's overflow: hidden above) on
        // viewports taller than roughly 320px + barChromePx — the exact same whole-host-
        // grows-past-the-viewport failure oculist-6cd fixed for #oc-settings-panel, just
        // needing a shorter viewport to trigger since a flat cap doesn't shrink to leave room
        // for the bar the way this one does. Same fix, same cap: bound to whatever's left of
        // the viewport once the host chrome above it (hostChromePx, above — bar + notice,
        // oculist-3rq) is accounted for, so bar + notice + panel together always fit
        // regardless of which of the four positions is active.
        '  max-height: calc(100vh - ' + hostChromePx + 'px);',
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
        // oculist-7de: same flex-shrink: 0 idiom as .oc-settings-header, and just as likely
        // inert for the same reason (min-height:auto already pins this row at its content
        // height since nothing sets overflow on it) — cheap defense now that #oc-lists-panel
        // is the scroll container, kept honest rather than overstated per the oculist-6cd
        // review that flagged those comments.
        '  flex-shrink: 0;',
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
        // oculist-7de: same flex-shrink: 0 as .oc-list-save-row above, and .oc-settings-grid's
        // sibling case in #oc-settings-panel — same likely-inert cheap defense, not the thing
        // actually keeping this content at natural height while #oc-lists-panel scrolls.
        '  flex-shrink: 0;',
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
        // oculist-tdj.3: after checkSiteOverride() (a separate, session-only notice
        // class — the two can coexist) and before the input.focus()/select() below,
        // which must remain the last word on where focus lands on open.
        maybeShowPackDiscoveryNotice();
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
  }

  // oculist-1gjy: registered before the chrome.storage.sync.get() read below (not inside
  // boot(), where it lived before) so a write landing in the gap between issuing that read
  // and boot() finishing is never missed -- chrome.storage.onChanged only notifies
  // listeners that are already registered when it fires, it doesn't replay to ones added
  // later. Safe to fire before boot(): every value this handler touches (settings, wrap,
  // settingsPanel, pendingSelfWrites, workListTerms) already carries its pre-boot default
  // from the top-level var declarations above, and the overlay/panel branches below are
  // gated on wrap/settingsPanel being truthy, which they aren't until boot() opens the
  // panel; injectHighlightStyles() is ungated, exactly as it already was post-boot with the
  // overlay closed. A pre-boot foreign write is NOT simply superseded by the read below,
  // though: that read's own snapshot can be OLDER than a write this listener already
  // applied (the read was issued before the write landed, but the write's onChanged
  // fired -- and was applied live, below -- before the read's callback got around to
  // running its own snapshot merge). awaitingBootRead/pendingPreBootChange record that
  // latest pre-boot write so the read callback below can replay it, through this same
  // applyForeignSettingsChange(), AFTER its own snapshot merge -- making the newest known
  // value win no matter which one's callback happens to finish first. Added exactly once
  // per content-script injection: boot() itself only runs from the single call site
  // below, and the `if (window.__ocDestroy) { ...; return; }` guard at the top of this
  // file keeps a re-injected script from reaching here a second time.
  var awaitingBootRead = true;
  var pendingPreBootChange;

  function applyForeignSettingsChange(nv) {
    if (!nv) return;
    // oculist-tuy: refresh writeOcSettings()'s three-way-merge base (see
    // OculistSettingsMigration.rememberOcSettings()/mergeOcSettings() in
    // settings-migration.js) from every foreign write, not just this tab's own.
    // Without this, `base` stays frozen at the boot snapshot: two foreign writes to the
    // same key straddling a local save would have this tab's next saveSettings() diff
    // its in-memory value (adopted from the FIRST foreign write) against the stale boot
    // base, see it differ, and treat it as a local edit that overwrites the SECOND
    // foreign write that already landed in storage.
    //   - Placed here, before the self-echo check below: `nv` is the full newValue of
    //     'oc-settings', i.e. exactly what storage now holds, on every path — self-echo
    //     included. On the echo of our own write this equals the `merged` object
    //     writeOcSettings() already remembers in its own set() callback, so remembering
    //     it here again is a same-value no-op that just removes an ordering dependency
    //     on that async callback; on a coalesced write the echo branch below splices
    //     several queued entries, but `nv` is still the latest stored state either way.
    //   - Remembered as the FULL `nv`, not just the SETTINGS_KEYS subset applied to
    //     `settings` below: `base` must mean the same "what storage held" thing here as
    //     it does at the boot read at the bottom of this file, which also remembers the whole
    //     stored object. This carries the same pre-existing hazard documented at
    //     mergeOcSettings()'s own header comment (an unmodelled key surviving in storage only
    //     while also absent from `base`) — unchanged by this fix, and guarded against by
    //     SETTINGS_KEYS round-tripping every key any surface writes (see the note on
    //     seededDefaultBlocklist in the settings defaults at the top of this file).
    //   - This only ever ADVANCES `base` to a value `settings` already reflects (see the
    //     unconditional `settings[k] = incoming;` a few lines below, which runs outside
    //     the `changed` check) or is about to be given the exact same value — base never
    //     moves ahead of what the in-memory object holds, so a genuine local edit made
    //     after this can't be turned into a no-op by it.
    //   - One asymmetry this creates: the 'effect' key below normalises a stale/unknown
    //     incoming value to 'hud' before storing it in `settings`, so after that,
    //     settings.effect ('hud') and base.effect (still the raw stale value, e.g.
    //     'lens') diverge. The next merge then treats 'hud' as a local edit and persists
    //     it — which heals the stale value rather than losing anything, so it's fine.
    //   - Semantic change worth knowing: if a foreign write DELETES a modelled key,
    //     `base` loses it too, so this tab's copy then reads as a local edit and gets
    //     re-persisted, where before the deletion propagated. No writer deletes
    //     modelled keys today (they all write whole objects) and re-persisting is the
    //     self-healing direction, but a future factory-reset-by-deletion would need
    //     this revisited.
    //   - Out of scope: `if (!nv) return;` above (the key was deleted entirely) leaves
    //     `base` stale relative to an empty store; left alone here.
    OculistSettingsMigration.rememberOcSettings(nv);
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
    // scrollBehavior, performanceMode, displayPreset, ...) is either handled by its own
    // branch below or never read by the active-match overlays, so redrawing on it would
    // just be unnecessary DOM churn on an unrelated change.
    var OVERLAY_AFFECTING_KEYS = { visionSettings: 1, matchColor: 1, activeColor: 1, beaconColor: 1 };
    var overlaysAffected = false;
    SETTINGS_KEYS.forEach(function(k) {
      if (!(k in nv)) return;
      // Compare the normalised value, not the raw stored one: a stale/removed effect
      // key (e.g. 'lens' from an old build) always normalises to the same 'hud' that
      // is already in memory, so treating it as "changed" would force a rebuild on
      // every echo of that stale sync value forever (oculist-ais). Normalising before
      // the comparison makes that echo a no-op while a genuine change (a different
      // valid effect, or a stale value landing while memory holds something else)
      // still compares unequal and rebuilds as before.
      // oculist-tdj: routed through availableEffects() to ask "is it offered right
      // now" (a pack-disabled key is not), but the coercion itself still gates on
      // isGenuinelyUnknownEffect() (the raw registry) — a pack-disabled key must NOT
      // be rewritten to 'hud' here, or re-enabling its pack would never restore it.
      // See isGenuinelyUnknownEffect()'s header and animate() for where a
      // pack-disabled key is actually resolved to hud, at run time, without this
      // mutation.
      var effectUnavailable = k === 'effect' && !availableEffects()[nv[k]];
      var incoming = (effectUnavailable && isGenuinelyUnknownEffect(nv[k])) ? 'hud' : nv[k];
      if (stableStringify(incoming) !== stableStringify(settings[k])) {
        changed = true;
        if (k === 'performanceMode') performanceModeChanged = true;
        if (OVERLAY_AFFECTING_KEYS[k]) overlaysAffected = true;
      }
      settings[k] = incoming;
    });
    if (!changed) return;
    if (!Array.isArray(settings.disabledSites)) settings.disabledSites = [];
    // Same defensive shape as disabledSites above: availableEffects() below indexOf()s
    // into settings.enabledPacks, so a malformed stored value (not an array) must be
    // corrected before that call, not after.
    if (!Array.isArray(settings.enabledPacks)) settings.enabledPacks = [];
    // oculist-tdj: same isGenuinelyUnknownEffect()-gated coercion as above, defensive
    // re-check — a pack-disabled settings.effect is left alone here too.
    if (!availableEffects()[settings.effect] && isGenuinelyUnknownEffect(settings.effect)) {
      settings.effect = 'hud';
    }
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
      // scanned instead of the one now in effect. Gated on wrap (oculist-l6m.18): with
      // the bar closed there is no chip row/count on screen to go stale, so paying a
      // full buildPageIndex() rescan here bought nothing. The guard is also redundant in
      // practice: __ocDestroy resets workListTerms, so wrap === null implies the length
      // check below already fails. settings[...] above is updated regardless of this guard.
      if (wrap && performanceModeChanged && workListTerms.length > 0) {
        performListSearch();
      }
    }
  }

  chrome.storage.onChanged.addListener(function(changes) {
    if (!changes['oc-settings']) return;
    var nv = changes['oc-settings'].newValue;
    // Recorded raw while the boot read is still in flight (a delete records undefined,
    // i.e. nothing to replay), so the read callback below replays whatever this listener
    // last saw -- applyForeignSettingsChange() itself already no-ops on a falsy nv.
    if (awaitingBootRead) pendingPreBootChange = nv;
    applyForeignSettingsChange(nv);
  });

  chrome.storage.sync.get('oc-settings', function (data) {
    // oculist-rnr.12 (review fix): normalisation now runs through the single shared
    // OculistSettingsMigration.normalizeOcSettings() (extension/settings-migration.js),
    // applied to `saved` — the object exactly as read from chrome.storage.sync — BEFORE
    // it's merged into `settings` below. That ordering matters: `settings` already declares
    // its own default `displayPreset: null` key, so checking presence on `settings` instead
    // of on the raw `saved` payload would always look "already migrated" and silently keep
    // a stale legacy visionProfile/colorPalette value (review gap 2). normalizeOcSettings()
    // itself prefers an already-present 'displayPreset' over a legacy 'visionProfile' when
    // both exist, so a user's fresh popup/welcome choice is never reverted by a stale
    // legacy field a not-yet-updated surface re-persisted, and always deletes the legacy
    // key either way — idempotent by construction, since a normalised object never has a
    // 'visionProfile' key or a clinical colorPalette value for a later pass to re-detect.
    // oculist-xvh: base for writeOcSettings()'s three-way merge — must be recorded from
    // the raw read, before normalizeOcSettings() below mutates `saved` in place, or the
    // base would already reflect this tab's own not-yet-written migration instead of
    // what storage actually held at boot.
    OculistSettingsMigration.rememberOcSettings(data && data['oc-settings']);
    var needsMigration = false;
    if (data && data['oc-settings']) {
      var saved = data['oc-settings'];
      needsMigration = OculistSettingsMigration.normalizeOcSettings(saved);
      SETTINGS_KEYS.forEach(function (k) {
        if (k in saved) settings[k] = saved[k];
      });
      if (!Array.isArray(settings.disabledSites)) settings.disabledSites = [];
      // Same defensive shape as disabledSites above, and for the same reason as the
      // onChanged listener's own copy of this guard: availableEffects() below indexOf()s
      // into settings.enabledPacks.
      if (!Array.isArray(settings.enabledPacks)) settings.enabledPacks = [];
    }
    // oculist-tdj: same isGenuinelyUnknownEffect()-gated coercion as the onChanged
    // listener above — a pack-disabled effect surviving a restart is left alone, since
    // it may still be selectable once availableEffects() sees its pack re-enabled.
    if (!availableEffects()[settings.effect] && isGenuinelyUnknownEffect(settings.effect)) {
      settings.effect = 'hud';
    }
    if (needsMigration) {
      // Reuses saveSettings()'s own pendingSelfWrites bookkeeping so the write this
      // migration makes is recognized and swallowed as an echo by the
      // chrome.storage.onChanged listener registered above, instead of being
      // mistaken for a foreign change and tearing the (not-yet-open) panel down.
      saveSettings();
    }
    // oculist-1gjy: this read's own snapshot (merged above) can be older than a foreign
    // write the onChanged listener already applied live while this read was in flight --
    // replay that latest pre-boot write once more, through the exact same
    // applyForeignSettingsChange() (rememberOcSettings() included), so it always wins
    // over the stale snapshot rather than being clobbered by it.
    awaitingBootRead = false;
    if (pendingPreBootChange !== undefined) {
      var latestPreBootChange = pendingPreBootChange;
      pendingPreBootChange = undefined;
      applyForeignSettingsChange(latestPreBootChange);
    }
    boot();
  });

})();
