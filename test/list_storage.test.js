// Saved-list storage (oculist-l6m.8): named, user-curated term lists persisted under
// their own 'oc-list-<id>' chrome.storage.sync key, one key per list rather than a
// single array — sync caps a single item at 8192 bytes, and per-key writes avoid a
// read-modify-write race when two devices save at once. This bead is storage only, no
// UI; a later bead builds the list menu on top of listSavedLists/saveList/renameList/
// deleteList.
//
// Needs a real browser for the same reason as worklist_storage.test.js: these functions
// are IIFE-internal closures in content.js, invisible to page.evaluate() (isolated JS
// world). The bridge is raw CDP: attach a CDPSession, find the isolated execution
// context Chrome created for the extension's content script, and call Runtime.evaluate
// against that context directly — a real content-script-context call, not a mock.
//
// The cap/failure-message assertions also read the on-page notice element
// (#oc-wrap >> .oc-notice-text) via a normal Playwright locator, since showNotice()
// appends to wrapRoot in the real DOM/shadow-root — no CDP needed for that half.

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { POLL_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');
const PAGE = '<!doctype html><meta charset="utf-8"><p>hello quarklet world</p>';

const INPUT = '#oc-wrap >> .oc-input';
const NOTICE_TEXT = '#oc-wrap >> .oc-notice-text';

const CAP_MESSAGE = "You've saved 50 lists, the maximum. Delete one to save a new list.";
const WRITE_FAILURE_MESSAGE = "Couldn't save this list. Chrome's sync storage is full; delete a saved list and try again.";

describe('Saved list storage (oc-list-<id>)', () => {
  let server, ctx, page, client, isolatedContextId;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    // channel:'chromium' is load-bearing — the default bundled build is the headless
    // shell, which silently loads no extensions at all.
    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      viewport: { width: 1280, height: 800 },
    });

    page = await ctx.newPage();

    // Attach CDP and watch for execution-context creation *before* navigating, so the
    // event for the content script's isolated world (created once the extension injects
    // at document_idle) is never missed.
    client = await ctx.newCDPSession(page);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    client.on('Runtime.executionContextCreated', (event) => {
      const c = event.context;
      if (c.auxData && c.auxData.type === 'isolated' && c.origin && c.origin.indexOf('chrome-extension://') === 0) {
        isolatedContextId = c.id;
      }
    });

    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    // The real precondition for Control+f doing anything is the content script's isolated
    // world existing at all — poll the execution-context-created flag instead of guessing
    // how long injection takes.
    const deadline = Date.now() + 5000;
    while (!isolatedContextId) {
      if (Date.now() > deadline) throw new Error('never observed the content script isolated execution context');
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await openFinder();
    assert.ok(isolatedContextId, 'never observed the content script isolated execution context');
  });

  // isolatedContextId existing only proves the content script's realm has been created,
  // not that its synchronous top-level init has reached the keydown-listener registration
  // yet — under load there can still be a gap. Retry Control+f (a keypress a not-yet-
  // attached listener would otherwise silently swallow) until the input actually appears,
  // instead of trusting a single press.
  async function openFinder() {
    for (let attempt = 0; attempt < 20; attempt++) {
      await page.keyboard.press('Control+f');
      try {
        await page.waitForSelector(INPUT, { timeout: 250 });
        return;
      } catch (e) {
        // keep retrying
      }
    }
    await page.waitForSelector(INPUT, { timeout: POLL_TIMEOUT }); // surfaces the real timeout error
  }

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  function evalInContentScript(expression) {
    return client
      .send('Runtime.evaluate', {
        expression,
        contextId: isolatedContextId,
        awaitPromise: true,
        returnByValue: true,
      })
      .then((res) => {
        if (res.exceptionDetails) {
          throw new Error('content-script eval failed: ' + JSON.stringify(res.exceptionDetails));
        }
        return res.result.value;
      });
  }

  function clearSavedLists() {
    return evalInContentScript(
      "new Promise((resolve) => chrome.storage.sync.get(null, (data) => {" +
      "  var keys = Object.keys(data || {}).filter((k) => k.indexOf('oc-list-') === 0);" +
      "  if (keys.length === 0) { resolve(); return; }" +
      "  chrome.storage.sync.remove(keys, resolve);" +
      "}))"
    );
  }

  // Reopening the bar (destroy via Escape, rebuild via Control+f) is what resets
  // content.js's noticeDismissed flag and rebuilds wrapRoot fresh — the same mechanism
  // chip_row.test.js's beforeEach relies on — so every test here starts able to show its
  // own notice, unaffected by whatever the previous test displayed.
  beforeEach(async () => {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForFunction(() => !document.getElementById('oc-wrap'), null, { timeout: POLL_TIMEOUT });
    await clearSavedLists();
    await openFinder();
  });

  function rawGet(key) {
    return evalInContentScript(
      `new Promise((resolve) => chrome.storage.sync.get(${JSON.stringify(key)}, (data) => resolve(data[${JSON.stringify(key)}])))`
    );
  }

  function callSaveList(name, terms) {
    return evalInContentScript(
      `new Promise((resolve) => window.__ocSaveList(${JSON.stringify(name)}, ${JSON.stringify(terms)}, resolve))`
    );
  }

  function callRenameList(id, name) {
    return evalInContentScript(
      `new Promise((resolve) => window.__ocRenameList(${JSON.stringify(id)}, ${JSON.stringify(name)}, resolve))`
    );
  }

  function callDeleteList(id) {
    return evalInContentScript(
      `new Promise((resolve) => window.__ocDeleteList(${JSON.stringify(id)}, resolve))`
    );
  }

  function callListSavedLists() {
    return evalInContentScript('new Promise((resolve) => window.__ocListSavedLists(resolve))');
  }

  function seedLists(count) {
    const batch = {};
    for (let i = 0; i < count; i++) {
      batch['oc-list-seed' + i] = { id: 'seed' + i, name: 'Seed ' + i, terms: ['x'] };
    }
    return evalInContentScript(
      `new Promise((resolve) => chrome.storage.sync.set(${JSON.stringify(batch)}, resolve))`
    );
  }

  // Two categories, per oculist-dzi:
  //  - UNIDENTIFIABLE (no usable id, no usable name, or not an object at all):
  //    'oc-list-junk-string', 'oc-list-junk-null', 'oc-list-junk-bad-id' (numeric id),
  //    'oc-list-junk-no-id'. Can never be rendered meaningfully — stays out of
  //    listSavedLists() and stays uncounted by readListIndex().
  //  - IDENTIFIABLE-but-malformed-terms (usable id + name, but terms isn't an array):
  //    'oc-list-junk-bad-terms' (terms: 'nope'), 'oc-list-junk-null-terms'
  //    (terms: null), 'oc-list-junk-missing-terms' (terms field absent entirely). All
  //    three surface from listSavedLists() as zero-term entries and still count toward
  //    the cap in readListIndex() — they're visible in the panel, so the count is honest.
  function seedJunk() {
    const batch = {
      'oc-list-good': { id: 'good', name: 'Good List', terms: ['alpha', 'beta'] },
      'oc-list-junk-string': 'not-an-object',
      'oc-list-junk-null': null,
      'oc-list-junk-bad-id': { id: 42, name: 'Numeric id', terms: [] },
      'oc-list-junk-no-id': { name: 'Missing id field', terms: [] },
      'oc-list-junk-bad-terms': { id: 'jbt', name: 'Terms not array', terms: 'nope' },
      'oc-list-junk-null-terms': { id: 'jnt', name: 'Terms null', terms: null },
      'oc-list-junk-missing-terms': { id: 'jmt', name: 'Terms missing' }
    };
    return evalInContentScript(
      `new Promise((resolve) => chrome.storage.sync.set(${JSON.stringify(batch)}, resolve))`
    );
  }

  // Only the unidentifiable half of seedJunk() above — used by the cap-accounting test
  // below, which needs junk present that must NOT count toward MAX_SAVED_LISTS, without
  // any identifiable-but-malformed entries (which DO count) muddying the count.
  function seedUnidentifiableJunk() {
    const batch = {
      'oc-list-junk-string': 'not-an-object',
      'oc-list-junk-null': null,
      'oc-list-junk-bad-id': { id: 42, name: 'Numeric id', terms: [] },
      'oc-list-junk-no-id': { name: 'Missing id field', terms: [] }
    };
    return evalInContentScript(
      `new Promise((resolve) => chrome.storage.sync.set(${JSON.stringify(batch)}, resolve))`
    );
  }

  // Overrides chrome.storage.sync.set for the duration of a single saveList() call so it
  // synchronously fails with chrome.runtime.lastError set, then restores the original —
  // simulating a real quota-exceeded write failure without needing to actually fill sync
  // storage to its real quota.
  function callSaveListWithSimulatedWriteFailure(name, terms) {
    return evalInContentScript(
      `new Promise((resolve) => {
        var originalSet = chrome.storage.sync.set;
        chrome.storage.sync.set = function (items, cb) {
          chrome.runtime.lastError = { message: 'QUOTA_BYTES_PER_ITEM quota exceeded (simulated)' };
          cb();
          delete chrome.runtime.lastError;
        };
        window.__ocSaveList(${JSON.stringify(name)}, ${JSON.stringify(terms)}, function (result) {
          chrome.storage.sync.set = originalSet;
          resolve(result);
        });
      })`
    );
  }

  test('save / list / rename / delete round-trip through per-list keys, and duplicate names are allowed', async () => {
    const first = await callSaveList('First List', ['alpha', 'beta']);
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.list.name, 'First List');
    assert.deepStrictEqual(first.list.terms, ['alpha', 'beta']);
    assert.strictEqual(typeof first.list.id, 'string');
    assert.ok(first.list.id.length > 0);

    // Confirm it is genuinely sitting under its own oc-list-<id> key (not an in-memory
    // shortcut) — read it back directly, bypassing listSavedLists entirely.
    const rawFirst = await rawGet('oc-list-' + first.list.id);
    assert.deepStrictEqual(rawFirst, { id: first.list.id, name: 'First List', terms: ['alpha', 'beta'] });

    // A duplicate name is allowed; ids are the identity.
    const second = await callSaveList('First List', ['gamma']);
    assert.strictEqual(second.ok, true);
    assert.strictEqual(second.list.name, 'First List');
    assert.notStrictEqual(second.list.id, first.list.id);

    const afterTwoSaves = await callListSavedLists();
    assert.strictEqual(afterTwoSaves.length, 2);
    assert.ok(afterTwoSaves.some((l) => l.id === first.list.id && l.name === 'First List'));
    assert.ok(afterTwoSaves.some((l) => l.id === second.list.id));

    const renamed = await callRenameList(first.list.id, '  Renamed List  ');
    assert.strictEqual(renamed.ok, true);
    assert.strictEqual(renamed.list.name, 'Renamed List');
    assert.deepStrictEqual(renamed.list.terms, ['alpha', 'beta']);
    const rawRenamed = await rawGet('oc-list-' + first.list.id);
    assert.strictEqual(rawRenamed.name, 'Renamed List');

    // A rename to an empty or whitespace-only name is rejected — and does not write.
    const rejectedRename = await callRenameList(first.list.id, '   ');
    assert.strictEqual(rejectedRename.ok, false);
    assert.strictEqual(rejectedRename.reason, 'empty-name');
    const rawAfterRejectedRename = await rawGet('oc-list-' + first.list.id);
    assert.strictEqual(rawAfterRejectedRename.name, 'Renamed List');

    const deleted = await callDeleteList(first.list.id);
    assert.strictEqual(deleted.ok, true);
    const rawAfterDelete = await rawGet('oc-list-' + first.list.id);
    assert.strictEqual(rawAfterDelete, undefined);

    const afterDelete = await callListSavedLists();
    assert.strictEqual(afterDelete.length, 1);
    assert.strictEqual(afterDelete[0].id, second.list.id);
  });

  test('the 51st saved list hits the 50-list cap and shows the maximum-lists notice', async () => {
    await seedLists(50);

    const overflow = await callSaveList('Overflow List', ['x']);
    assert.strictEqual(overflow.ok, false);
    assert.strictEqual(overflow.reason, 'cap');

    // No 51st key was written.
    const afterAttempt = await callListSavedLists();
    assert.strictEqual(afterAttempt.length, 50);
    assert.ok(!afterAttempt.some((l) => l.name === 'Overflow List'));

    await page.waitForSelector(NOTICE_TEXT, { timeout: POLL_TIMEOUT });
    assert.strictEqual((await page.locator(NOTICE_TEXT).textContent()).trim(), CAP_MESSAGE);
  });

  test('a simulated chrome.runtime.lastError on write produces the sync-storage-full notice', async () => {
    const result = await callSaveListWithSimulatedWriteFailure('Will Fail', ['x']);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'write-failed');

    // Nothing was actually written under any oc-list-* key.
    const afterAttempt = await callListSavedLists();
    assert.strictEqual(afterAttempt.length, 0);

    await page.waitForSelector(NOTICE_TEXT, { timeout: POLL_TIMEOUT });
    assert.strictEqual((await page.locator(NOTICE_TEXT).textContent()).trim(), WRITE_FAILURE_MESSAGE);
  });

  // oculist-dzi amended this test (previously "listSavedLists() skips junk under the
  // prefix instead of throwing", asserting length === 1 with only 'good' surviving —
  // that assertion documented the OLD behaviour of dropping every malformed entry
  // wholesale, rather than the "does not throw" contract it was actually meant to pin.
  // Malformed-but-identifiable entries (usable id + name, garbage terms) no longer get
  // dropped: they now surface as zero-term lists, matching the same disabled/badged-0
  // treatment a legitimately empty list already gets (oculist-l6m.35). Only entries
  // that can never be rendered at all (not an object, no usable id, no usable name)
  // are still skipped outright.
  test('listSavedLists() skips unidentifiable junk under the prefix instead of throwing, and surfaces identifiable-but-malformed entries as zero-term lists', async () => {
    await seedJunk();

    const lists = await callListSavedLists();
    // 4 survive: 'good' plus the three identifiable-but-malformed-terms entries.
    // 'oc-list-junk-string', 'oc-list-junk-null', 'oc-list-junk-bad-id' (numeric id),
    // and 'oc-list-junk-no-id' are all unidentifiable and stay excluded, unchanged.
    assert.strictEqual(lists.length, 4);
    assert.deepStrictEqual(
      lists.find((l) => l.id === 'good'),
      { id: 'good', name: 'Good List', terms: ['alpha', 'beta'] }
    );
    assert.deepStrictEqual(
      lists.find((l) => l.id === 'jbt'),
      { id: 'jbt', name: 'Terms not array', terms: [] }
    );
    assert.deepStrictEqual(
      lists.find((l) => l.id === 'jnt'),
      { id: 'jnt', name: 'Terms null', terms: [] }
    );
    assert.deepStrictEqual(
      lists.find((l) => l.id === 'jmt'),
      { id: 'jmt', name: 'Terms missing', terms: [] }
    );
  });

  // The "does not consume a slot" half of oculist-dzi's done-criteria: unidentifiable
  // junk under the prefix must not silently eat into the 50-list cap. Seed junk that
  // readListIndex() cannot count (per the identifiable-entry guard above), then confirm
  // the user can still save a full 50 real lists on top of it, and only the 51st real
  // list hits the cap.
  test('unidentifiable junk under the prefix does not count toward the 50-list cap', async () => {
    await seedUnidentifiableJunk();
    await seedLists(49);

    // The 50th real list still succeeds — the junk above isn't counted, so this isn't
    // actually the 51st slot from readListIndex()'s point of view.
    const fiftieth = await callSaveList('Fiftieth List', ['x']);
    assert.strictEqual(fiftieth.ok, true);

    // The 51st real list now hits the real cap.
    const overflow = await callSaveList('Overflow List', ['x']);
    assert.strictEqual(overflow.ok, false);
    assert.strictEqual(overflow.reason, 'cap');

    // listSavedLists() itself never counted the junk either — confirms the two read
    // paths (readListIndex's cap count and listSavedLists' render list) still agree
    // with each other for what "identifiable" means, unchanged by this fix.
    const lists = await callListSavedLists();
    assert.strictEqual(lists.length, 50);
  });

  // Covers readListIndex()'s three guard clauses individually (the review follow-up
  // after the initial oculist-dzi pass grouped them into a single junk-batch test
  // above, which didn't exercise each clause on its own).
  //
  // 1. A usable id paired with a non-string name: identifiable-by-id but not by name,
  // so it still doesn't count toward the cap or render — but per the review follow-up,
  // readListIndex() now keeps its id in the collision-avoidance list regardless (the
  // count/name gate and the ids-push are no longer tied together). That collision
  // avoidance is generateListId()'s internal input, not observable from outside: none
  // of the four window.__oc* hooks (listSavedLists/saveList/renameList/deleteList)
  // exposes readListIndex() or its `ids` array directly, and ids are always generated
  // via Date.now().toString(36) + Math.random()...slice(2,10) (content.js:223), so a
  // real collision with a hand-authored id like 'x' can't be forced from a black-box
  // test without adding a new test-only hook — which the reviewer asked not to do. Not
  // asserted here for that reason; only the observable half (cap + panel exclusion) is.
  test('an entry with a usable id but a non-string name does not count toward the 50-list cap, and stays out of the saved-lists panel', async () => {
    await evalInContentScript(
      "new Promise((resolve) => chrome.storage.sync.set(" +
      "{'oc-list-badname': { id: 'x', name: 42, terms: ['a'] }}," +
      " resolve))"
    );
    await seedLists(49);

    // The 50th real list still succeeds — the malformed-name entry above isn't counted.
    const fiftieth = await callSaveList('Fiftieth List', ['y']);
    assert.strictEqual(fiftieth.ok, true);

    // The 51st real list now hits the real cap.
    const overflow = await callSaveList('Overflow List', ['z']);
    assert.strictEqual(overflow.ok, false);
    assert.strictEqual(overflow.reason, 'cap');

    // A non-string name isn't renderable either — stays out of the panel.
    const lists = await callListSavedLists();
    assert.strictEqual(lists.length, 50);
    assert.ok(!lists.some((l) => l.id === 'x'));
  });

  // 2. An empty-string id is treated the same as no id at all — unidentifiable,
  // excluded from the panel, and not counted toward the cap.
  test('an entry with an empty-string id is treated as unidentifiable: excluded from the panel and not counted toward the cap', async () => {
    await evalInContentScript(
      "new Promise((resolve) => chrome.storage.sync.set(" +
      "{'oc-list-emptyid': { id: '', name: 'Empty Id', terms: ['a'] }}," +
      " resolve))"
    );
    await seedLists(49);

    const fiftieth = await callSaveList('Fiftieth List', ['y']);
    assert.strictEqual(fiftieth.ok, true);

    const overflow = await callSaveList('Overflow List', ['z']);
    assert.strictEqual(overflow.ok, false);
    assert.strictEqual(overflow.reason, 'cap');

    const lists = await callListSavedLists();
    assert.strictEqual(lists.length, 50);
    assert.ok(!lists.some((l) => l.name === 'Empty Id'));
  });

  // 3. terms: {} — named in the comment above listSavedLists() as an example malformed
  // shape sanitizeListTerms() reduces to zero terms, but nothing exercised it directly.
  test('listSavedLists() treats a non-array object terms value ({}) the same as any other malformed terms — zero terms, no throw', async () => {
    await evalInContentScript(
      "new Promise((resolve) => chrome.storage.sync.set(" +
      "{'oc-list-objterms': { id: 'objterms', name: 'Object Terms', terms: {} }}," +
      " resolve))"
    );

    const lists = await callListSavedLists();
    assert.strictEqual(lists.length, 1);
    assert.deepStrictEqual(lists[0], { id: 'objterms', name: 'Object Terms', terms: [] });
  });

  // oculist-l6m.26: a 0-term saved list is useless to create and dangerous to load —
  // loadSavedList() has no confirmation, so loading one would silently wipe the working
  // list with no way back. The popover's own Save button is the primary guard (see
  // list_menu.test.js), but saveList() rejects it too, the same silent-by-design
  // treatment 'empty-name' already gets, for any caller that reaches this function
  // directly without going through the popover.
  test('saveList() rejects an empty (or all-whitespace) terms array without writing anything', async () => {
    const emptyArray = await callSaveList('Nothing To Save', []);
    assert.strictEqual(emptyArray.ok, false);
    assert.strictEqual(emptyArray.reason, 'empty-terms');

    // Whitespace-only entries sanitize down to zero real terms too — same rejection.
    const whitespaceOnly = await callSaveList('Still Nothing', ['   ', '']);
    assert.strictEqual(whitespaceOnly.ok, false);
    assert.strictEqual(whitespaceOnly.reason, 'empty-terms');

    // Neither attempt wrote anything under any oc-list-* key, and no notice was raised
    // ('empty-terms' is silent, matching 'empty-name').
    const afterAttempts = await callListSavedLists();
    assert.strictEqual(afterAttempts.length, 0);
    assert.strictEqual(await page.locator(NOTICE_TEXT).count(), 0);
  });
});
