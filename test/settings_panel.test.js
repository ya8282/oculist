const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

// Helper to configure a browser-like DOM environment for each test
function createDOMEnvironment() {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="content">Some test content to search.</div></body></html>', {
    url: 'http://localhost'
  });

  const domGlobals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    chrome: {
      storage: {
        sync: {
          get: (key, cb) => cb({}),
          set: (data, cb) => cb && cb()
        },
        onChanged: { addListener: () => {} }
      },
      runtime: {
        onMessage: { addListener: () => {} }
      },
      commands: {
        onCommand: { addListener: () => {} }
      }
    }
  };

  // Assign standard browser globals to Node global space for testing browser scripts
  Object.assign(global, domGlobals);

  // Mock Web Animations API Element.prototype.animate
  dom.window.Element.prototype.animate = function(keyframes, options) {
    return {
      finished: Promise.resolve(),
      cancel: () => {},
      play: () => {},
      pause: () => {}
    };
  };

  // Mock Range.prototype.getClientRects for layout-less JSDOM
  dom.window.Range.prototype.getClientRects = function() {
    return [{ width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }];
  };

  // Mock Range.prototype.getBoundingClientRect for layout-less JSDOM
  dom.window.Range.prototype.getBoundingClientRect = function() {
    return { width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, x: 0, y: 0 };
  };

  return dom;
}

describe('Oculist Preference Panel Tests', () => {
  beforeEach(() => {
    // Clear global state before each test
    delete global.window;
    delete global.document;
    delete global.navigator;
    delete global.localStorage;
    delete global.chrome;
    delete global.Oculist;
    delete global.__ocToggle;
    delete global.__ocDestroy;
  });

  describe('Extension Content Script (content.js)', () => {
    test('Should toggle Oculist find bar and correctly open/close the preference panel', () => {
      createDOMEnvironment();

      // Load content.js
      const codePath = path.join(__dirname, '../extension/content.js');
      const code = fs.readFileSync(codePath, 'utf8');
      eval(code);

      assert.strictEqual(typeof global.window.__ocToggle, 'function', 'window.__ocToggle should be a function');
      
      // Toggle Oculist bar on
      global.window.__ocToggle();

      const wrap = global.document.getElementById('oc-wrap');
      assert.ok(wrap, 'Oculist wrapper wrap should be added to the document body');

      const wrapRoot = wrap.shadowRoot;
      assert.ok(wrapRoot, 'Oculist shadow root wrapRoot should be created');

      const gearBtn = wrapRoot.querySelector('button[title^="Options"]');
      assert.ok(gearBtn, 'Options (gear) button should exist inside the shadow root');

      // 1. First toggle should build and open settings panel
      gearBtn.click();
      let settingsPanel = wrapRoot.querySelector('#oc-settings-panel');
      assert.ok(settingsPanel, 'Settings panel should be visible in the shadow DOM after click');
      assert.ok(gearBtn.classList.contains('active'), 'Gear button should have the active class when settings is open');

      // 2. Second toggle should remove the settings panel
      gearBtn.click();
      settingsPanel = wrapRoot.querySelector('#oc-settings-panel');
      assert.strictEqual(settingsPanel, null, 'Settings panel should be removed from the shadow DOM on second click');
      assert.ok(!gearBtn.classList.contains('active'), 'Gear button should NOT have the active class when settings is closed');
    });

    test('Should support donation badge link presence in content.js', () => {
      createDOMEnvironment();

      const codePath = path.join(__dirname, '../extension/content.js');
      const code = fs.readFileSync(codePath, 'utf8');
      eval(code);

      global.window.__ocToggle();
      const wrapRoot = global.document.getElementById('oc-wrap').shadowRoot;
      const gearBtn = wrapRoot.querySelector('button[title^="Options"]');
      gearBtn.click();

      const donateBtn = wrapRoot.querySelector('.oc-donate-btn');
      assert.ok(donateBtn, 'Buy me a coffee button should exist');
      assert.strictEqual(donateBtn.href, 'https://buymeacoffee.com/brewsforchris', 'Donation link must match configured target URL');
    });

    test('Should implement new preferences design in content.js', () => {
      createDOMEnvironment();

      const codePath = path.join(__dirname, '../extension/content.js');
      const code = fs.readFileSync(codePath, 'utf8');
      eval(code);

      global.window.__ocToggle();
      const wrapRoot = global.document.getElementById('oc-wrap').shadowRoot;
      const gearBtn = wrapRoot.querySelector('button[title^="Options"]');
      gearBtn.click();

      const settingsPanel = wrapRoot.querySelector('#oc-settings-panel');
      assert.ok(settingsPanel, 'Settings panel should open');

      // 1. Verify Spotlight
      const spotlightItem = Array.from(settingsPanel.querySelectorAll('.oc-radio-item'))
        .find(el => el.textContent.includes('Spotlight'));
      assert.ok(spotlightItem, 'Cinematic should be renamed to Spotlight');

      // 1b. Verify Lightning and Electron Cloud exist
      const lightningItem = Array.from(settingsPanel.querySelectorAll('.oc-radio-item'))
        .find(el => el.textContent.includes('Lightning'));
      assert.ok(lightningItem, 'Lightning effect should exist in the options list');

      const electronItem = Array.from(settingsPanel.querySelectorAll('.oc-radio-item'))
        .find(el => el.textContent.includes('Electron Cloud'));
      assert.ok(electronItem, 'Electron Cloud effect should exist in the options list');

      // 2. Verify Alphabetical Sorting
      const radioLabels = Array.from(settingsPanel.querySelectorAll('.oc-radio-item'))
        .map(el => el.textContent.replace(/[●○]/g, '').trim());
      const sortedLabels = [...radioLabels].sort((a, b) => a.localeCompare(b));
      assert.deepStrictEqual(radioLabels, sortedLabels, 'Highlight effects must be in alphabetical order');

      // 3. Verify color pickers have labels and hide hex codes
      const colorBadgeTexts = Array.from(settingsPanel.querySelectorAll('.oc-color-badge-text'))
        .map(el => el.textContent.trim());
      assert.deepStrictEqual(colorBadgeTexts, ['Match', 'Active', 'Beacon'], 'Color badges must show labels and hide hex codes');

      // 4. Verify description "Interactive effect colors" exists
      const colorsFieldDesc = Array.from(settingsPanel.querySelectorAll('.oc-settings-desc'))
        .map(el => el.textContent.trim());
      assert.ok(colorsFieldDesc.includes('Interactive effect colors'), 'Should describe section as Interactive effect colors');
    });

    test('Should intercept Cmd+G, Ctrl+G, and F3 to prevent browser find and trigger findNext in content.js', () => {
      createDOMEnvironment();

      const codePath = path.join(__dirname, '../extension/content.js');
      const code = fs.readFileSync(codePath, 'utf8');
      eval(code);

      global.window.__ocToggle();

      let preventDefaultCalled = false;
      let stopPropagationCalled = false;
      
      const event = new global.window.KeyboardEvent('keydown', {
        key: 'g',
        metaKey: true,
        bubbles: true,
        cancelable: true
      });
      event.preventDefault = () => { preventDefaultCalled = true; };
      event.stopPropagation = () => { stopPropagationCalled = true; };

      global.document.dispatchEvent(event);

      assert.ok(preventDefaultCalled, 'preventDefault should be called on Cmd+G');
      assert.ok(stopPropagationCalled, 'stopPropagation should be called on Cmd+G');

      let ctrlGPreventDefault = false;
      const ctrlGEvent = new global.window.KeyboardEvent('keydown', {
        key: 'g',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      });
      ctrlGEvent.preventDefault = () => { ctrlGPreventDefault = true; };
      global.document.dispatchEvent(ctrlGEvent);
      assert.ok(ctrlGPreventDefault, 'preventDefault should be called on Ctrl+G');

      let f3PreventDefault = false;
      const f3Event = new global.window.KeyboardEvent('keydown', {
        key: 'F3',
        bubbles: true,
        cancelable: true
      });
      f3Event.preventDefault = () => { f3PreventDefault = true; };
      global.document.dispatchEvent(f3Event);
      assert.ok(f3PreventDefault, 'preventDefault should be called on F3');

      // Close Oculist find bar
      global.window.__ocDestroy();
      
      let inactivePreventDefault = false;
      const inactiveEvent = new global.window.KeyboardEvent('keydown', {
        key: 'g',
        metaKey: true,
        bubbles: true,
        cancelable: true
      });
      inactiveEvent.preventDefault = () => { inactivePreventDefault = true; };
      global.document.dispatchEvent(inactiveEvent);
      assert.ok(!inactivePreventDefault, 'preventDefault should NOT be called on Cmd+G when Oculist is closed');
    });

    test('Should allow selecting smooth and instant scroll behaviors in the preference panel in content.js', () => {
      createDOMEnvironment();

      const codePath = path.join(__dirname, '../extension/content.js');
      const code = fs.readFileSync(codePath, 'utf8');
      eval(code);

      global.window.__ocToggle();
      const wrapRoot = global.document.getElementById('oc-wrap').shadowRoot;
      const gearBtn = wrapRoot.querySelector('button[title^="Options"]');
      gearBtn.click();

      const settingsPanel = wrapRoot.querySelector('#oc-settings-panel');
      assert.ok(settingsPanel, 'Settings panel should open');

      // Verify the Scroll Behavior toggle buttons exist
      const smoothBtn = Array.from(settingsPanel.querySelectorAll('.oc-toggle-btn'))
        .find(el => el.textContent === 'Smooth');
      const instantBtn = Array.from(settingsPanel.querySelectorAll('.oc-toggle-btn'))
        .find(el => el.textContent === 'Instant');
      
      assert.ok(smoothBtn, 'Smooth scroll toggle button should exist');
      assert.ok(instantBtn, 'Instant scroll toggle button should exist');

      // Click Instant button to switch scroll behavior
      instantBtn.click();

      // Verify it re-renders and the setting is active
      const freshSettingsPanel = wrapRoot.querySelector('#oc-settings-panel');
      const freshInstantBtn = Array.from(freshSettingsPanel.querySelectorAll('.oc-toggle-btn'))
        .find(el => el.textContent === 'Instant');
      assert.ok(freshInstantBtn.classList.contains('active'), 'Instant scroll button should have active class after click');
    });

    test('Should support split-node text matching and pierce Shadow DOM in content.js', async () => {
      createDOMEnvironment();
      const document = global.document;
      document.body.innerHTML = '';
      
      const p = document.createElement('p');
      p.innerHTML = 'hello <strong>world</strong>';
      document.body.appendChild(p);

      const pAccents = document.createElement('p');
      pAccents.innerHTML = 'héllo <strong>wôrld</strong>';
      document.body.appendChild(pAccents);

      const pSpaces = document.createElement('p');
      pSpaces.innerHTML = 'multiple    spaces    here';
      document.body.appendChild(pSpaces);

      const host = document.createElement('div');
      document.body.appendChild(host);
      const shadow = host.attachShadow({ mode: 'open' });
      const shadowP = document.createElement('p');
      shadowP.textContent = 'shadow text';
      shadow.appendChild(shadowP);

      const codePath = path.join(__dirname, '../extension/content.js');
      const code = fs.readFileSync(codePath, 'utf8');
      eval(code);

      global.window.__ocToggle();
      const wrap = document.getElementById('oc-wrap');
      const input = wrap.shadowRoot.querySelector('.oc-input');

      // Test split-node matching and accent folding (should find both 'hello world' and 'héllo world')
      input.value = 'hello world';
      input.dispatchEvent(new global.window.Event('input'));
      await new Promise(resolve => setTimeout(resolve, 250));

      const wrapRoot = wrap.shadowRoot;
      const countEl = wrapRoot.querySelector('.oc-count');
      assert.strictEqual(countEl.textContent.trim(), '1 of 2', 'Should find exactly 2 matches (and select the first one) in content.js');

      // Test searching with accents (should also match both)
      input.value = 'héllo wôrld';
      input.dispatchEvent(new global.window.Event('input'));
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.strictEqual(countEl.textContent.trim(), '1 of 2', 'Should find exactly 2 matches when querying with accents in content.js');

      // Test whitespace query normalization
      input.value = 'multiple   spaces   here';
      input.dispatchEvent(new global.window.Event('input'));
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.strictEqual(countEl.textContent.trim(), '1 of 1', 'Should find exactly 1 match with normalized spaces query in content.js');

      // Test shadow DOM piercing
      input.value = 'shadow text';
      input.dispatchEvent(new global.window.Event('input'));
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.strictEqual(countEl.textContent.trim(), '1 of 1', 'Should find exactly 1 match inside Shadow DOM in content.js');
    });

    test('Should render 8px viewport shape markers for inactive matches under a color blind palette and clear them when search is emptied', async () => {
      const dom = createDOMEnvironment();
      const document = global.document;
      document.body.innerHTML = '';

      const p1 = document.createElement('p');
      p1.textContent = 'shape marker one';
      document.body.appendChild(p1);

      const p2 = document.createElement('p');
      p2.textContent = 'shape marker two';
      document.body.appendChild(p2);

      // Simulate a saved deuteranopia color blind profile being loaded on boot.
      global.chrome.storage.sync.get = (key, cb) => cb({
        'oc-settings': { visionSettings: { colorPalette: 'deuteranopia' } }
      });

      const codePath = path.join(__dirname, '../extension/content.js');
      const code = fs.readFileSync(codePath, 'utf8');
      eval(code);

      global.window.__ocToggle();
      const wrap = document.getElementById('oc-wrap');
      const input = wrap.shadowRoot.querySelector('.oc-input');

      input.value = 'shape marker';
      input.dispatchEvent(new global.window.Event('input'));
      await new Promise(resolve => setTimeout(resolve, 250));

      const countEl = wrap.shadowRoot.querySelector('.oc-count');
      assert.strictEqual(countEl.textContent.trim(), '1 of 2', 'Should find exactly 2 matches in content.js');

      const markers = document.documentElement.querySelectorAll('.oc-viewport-marker');
      assert.strictEqual(markers.length, 1, 'Should draw exactly one viewport shape marker for the inactive match');
      assert.strictEqual(markers[0].style.width, '8px', 'Viewport shape marker should be 8px per VA-03 spec');

      // Clearing the search term should remove stale viewport markers.
      input.value = '';
      input.dispatchEvent(new global.window.Event('input'));
      await new Promise(resolve => setTimeout(resolve, 250));

      const markersAfterClear = document.documentElement.querySelectorAll('.oc-viewport-marker');
      assert.strictEqual(markersAfterClear.length, 0, 'Viewport shape markers should be cleared once the search is emptied');
    });

    test('A settings.effect value for a removed effect (e.g. the deleted Lens) still renders a working beacon via animate()\'s own fallback (oculist-e9u)', async () => {
      const dom = createDOMEnvironment();
      const document = global.document;
      document.body.innerHTML = '';

      const p1 = document.createElement('p');
      p1.textContent = 'orphan beacon target';
      document.body.appendChild(p1);

      // Boot with a valid effect. Both the boot-time coercion
      // (`if (!effectsRegistry[settings.effect]) settings.effect = 'hud'`) and the
      // storage.onChanged guard added by oculist-7z3 normalise a stale/removed key back to
      // 'hud' before animate() ever sees it, so there is no longer a route from outside this
      // closure that leaves settings.effect holding a bogus key at animate()-time. Reaching
      // animate()'s own fallback (effectsRegistry[effectKey] || effectsRegistry.hud) now
      // requires writing settings.effect directly via the window.__ocTest.setEffectKey hook,
      // after boot, bypassing every guard on purpose (see that hook's comment for why).
      global.chrome.storage.sync.get = (key, cb) => cb({
        'oc-settings': { effect: 'hud' }
      });

      const codePath = path.join(__dirname, '../extension/content.js');
      const code = fs.readFileSync(codePath, 'utf8');
      eval(code);

      global.window.__ocToggle();
      const wrap = document.getElementById('oc-wrap');
      const input = wrap.shadowRoot.querySelector('.oc-input');

      input.value = 'orphan beacon';
      input.dispatchEvent(new global.window.Event('input'));
      await new Promise(resolve => setTimeout(resolve, 250));

      const countEl = wrap.shadowRoot.querySelector('.oc-count');
      assert.strictEqual(countEl.textContent.trim(), '1 of 1', 'Should find the single match in content.js');

      // Simulate a settings payload persisted before an effect was removed from the
      // registry (e.g. Lens, oculist-e9u) still being in memory at animate()-time, bypassing
      // the onChanged guard the way a bug in some other future call site might.
      assert.strictEqual(typeof global.window.__ocTest.setEffectKey, 'function', 'content.js should expose the setEffectKey test hook');
      global.window.__ocTest.setEffectKey('lens');

      // The beacon only fires on an explicit navigation (findNext), not on the initial
      // search — mirrors how trail_effect.test.js's replay() drives it via Enter too.
      global.document.dispatchEvent(new global.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await new Promise(resolve => setTimeout(resolve, 250));

      const beacons = document.documentElement.querySelectorAll('.oc-beacon');
      assert.ok(beacons.length > 0, 'A beacon should still render for a stale/unknown effect key rather than silently no-op');
    });

    test('A post-boot storage.onChanged effect value for a removed effect is normalised back to hud so the settings panel still shows a selection (oculist-7z3)', async () => {
      const dom = createDOMEnvironment();
      const document = global.document;
      document.body.innerHTML = '';

      // Boot with a *valid* effect, same rationale as the oculist-e9u test above: booting
      // with a stale value would let the boot-time coercion (content.js:6122) carry the
      // fix instead of the onChanged-path guard this test targets.
      global.chrome.storage.sync.get = (key, cb) => cb({
        'oc-settings': { effect: 'hud' }
      });

      let onChangedListener;
      global.chrome.storage.onChanged.addListener = (fn) => { onChangedListener = fn; };

      const codePath = path.join(__dirname, '../extension/content.js');
      const code = fs.readFileSync(codePath, 'utf8');
      eval(code);

      global.window.__ocToggle();
      const wrap = document.getElementById('oc-wrap');
      const wrapRoot = wrap.shadowRoot;

      const gearBtn = wrapRoot.querySelector('button[title^="Options"]');
      gearBtn.click();
      assert.ok(wrapRoot.querySelector('#oc-settings-panel'), 'Settings panel should be open before the storage change lands');

      // Simulate a stale/removed effect key (e.g. the deleted Lens, oculist-e9u) arriving
      // post-boot via chrome.storage.onChanged — the guard this test targets, unlike the
      // oculist-e9u test above which now bypasses this path via __ocTest.setEffectKey.
      assert.strictEqual(typeof onChangedListener, 'function', 'content.js should have registered a chrome.storage.onChanged listener');
      onChangedListener({ 'oc-settings': { newValue: { effect: 'lens' } } });

      // The onChanged handler rebuilds the settings panel synchronously
      // (rebuildSettingsPanelPreservingFocus -> buildSettingsPanel), so no wait is needed
      // before re-querying it.
      const settingsPanel = wrapRoot.querySelector('#oc-settings-panel');
      assert.ok(settingsPanel, 'Settings panel should still be present after the storage change rebuild');

      const effectRows = Array.from(settingsPanel.querySelectorAll('.oc-radio-item[data-oc-key^="effect:"]'));
      assert.ok(effectRows.length > 0, 'Effect picker rows should be present in the settings panel');

      const activeRows = effectRows.filter(row => row.classList.contains('active'));
      assert.strictEqual(activeRows.length, 1, 'Exactly one effect row should be marked active; without the onChanged registry guard an unknown effect value matches nothing and every row loses its selection');
      assert.strictEqual(activeRows[0].getAttribute('data-oc-key'), 'effect:hud', 'The active effect row should be HUD, since settings.effect must be normalised back to "hud" for the removed "lens" key');
    });

  });
});
