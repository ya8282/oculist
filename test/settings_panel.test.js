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

  describe('Bookmarklet Script (oculist.js)', () => {
    test('Should toggle Oculist find bar and correctly open/close the preference panel', () => {
      createDOMEnvironment();

      // Load oculist.js
      const codePath = path.join(__dirname, '../oculist.js');
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

    test('Should allow selecting light and dark themes in the preference panel', () => {
      createDOMEnvironment();

      const codePath = path.join(__dirname, '../oculist.js');
      const code = fs.readFileSync(codePath, 'utf8');
      eval(code);

      global.window.__ocToggle();
      const wrapRoot = global.document.getElementById('oc-wrap').shadowRoot;
      const gearBtn = wrapRoot.querySelector('button[title^="Options"]');
      gearBtn.click();

      const settingsPanel = wrapRoot.querySelector('#oc-settings-panel');
      assert.ok(settingsPanel, 'Settings panel should open');

      // Find the Light Theme button in option group
      const lightThemeBtn = Array.from(settingsPanel.querySelectorAll('.oc-toggle-btn'))
        .find(el => el.textContent === 'Light');
      assert.ok(lightThemeBtn, 'Light Theme toggle button should exist');

      // Click it to switch to light theme
      lightThemeBtn.click();

      // Check that preference panel re-opens and theme has been persisted/applied
      const freshSettingsPanel = wrapRoot.querySelector('#oc-settings-panel');
      assert.ok(freshSettingsPanel, 'Settings panel should re-open after theme switch');
      
      // Verify wrap style is light theme background
      const wrap = global.document.getElementById('oc-wrap');
      assert.strictEqual(wrap.style.background, 'rgba(255, 255, 255, 0.94)', 'Wrapper background should match light theme setting');
    });

    test('Should support donation badge link presence and correct URL', () => {
      createDOMEnvironment();

      const codePath = path.join(__dirname, '../oculist.js');
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

    test('Should implement new preferences design (alphabetical effects, Spotlight, color picker labels)', () => {
      createDOMEnvironment();

      const codePath = path.join(__dirname, '../oculist.js');
      const code = fs.readFileSync(codePath, 'utf8');
      eval(code);

      global.window.__ocToggle();
      const wrapRoot = global.document.getElementById('oc-wrap').shadowRoot;
      const gearBtn = wrapRoot.querySelector('button[title^="Options"]');
      gearBtn.click();

      const settingsPanel = wrapRoot.querySelector('#oc-settings-panel');
      assert.ok(settingsPanel, 'Settings panel should open');

      // 1. Verify that 'Cinematic' is renamed to 'Spotlight'
      const spotlightItem = Array.from(settingsPanel.querySelectorAll('.oc-radio-item'))
        .find(el => el.textContent.includes('Spotlight'));
      assert.ok(spotlightItem, 'Cinematic should be renamed to Spotlight');

      // 1b. Verify that Lightning and Electron Cloud effects exist
      const lightningItem = Array.from(settingsPanel.querySelectorAll('.oc-radio-item'))
        .find(el => el.textContent.includes('Lightning'));
      assert.ok(lightningItem, 'Lightning effect should exist in the options list');

      const electronItem = Array.from(settingsPanel.querySelectorAll('.oc-radio-item'))
        .find(el => el.textContent.includes('Electron Cloud'));
      assert.ok(electronItem, 'Electron Cloud effect should exist in the options list');

      // 2. Verify that highlight effects are sorted alphabetically
      const radioLabels = Array.from(settingsPanel.querySelectorAll('.oc-radio-item'))
        .map(el => el.textContent.replace(/[●○]/g, '').trim());
      const sortedLabels = [...radioLabels].sort((a, b) => a.localeCompare(b));
      assert.deepStrictEqual(radioLabels, sortedLabels, 'Highlight effects must be in alphabetical order');

      // 3. Verify color pickers have labels and hide hex codes
      const colorBadgeTexts = Array.from(settingsPanel.querySelectorAll('.oc-color-badge-text'))
        .map(el => el.textContent.trim());
      assert.deepStrictEqual(colorBadgeTexts, ['Match', 'Active', 'Beacon'], 'Color badges must show labels and hide hex codes');

      // 4. Verify description "Interactive effect colors" exists instead of "Interactive hex swatches"
      const colorsFieldDesc = Array.from(settingsPanel.querySelectorAll('.oc-settings-desc'))
        .map(el => el.textContent.trim());
      assert.ok(colorsFieldDesc.includes('Interactive effect colors'), 'Should describe section as Interactive effect colors');
      assert.ok(!colorsFieldDesc.includes('Interactive hex swatches'), 'Should not mention Interactive hex swatches');
    });

    test('Should intercept Cmd+G, Ctrl+G, and F3 to prevent browser find and trigger findNext', () => {
      createDOMEnvironment();

      const codePath = path.join(__dirname, '../oculist.js');
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

    test('Should allow selecting smooth and instant scroll behaviors in the preference panel', () => {
      createDOMEnvironment();

      const codePath = path.join(__dirname, '../oculist.js');
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

    test('Should support split-node text matching and pierce Shadow DOM', async () => {
      createDOMEnvironment();
      const document = global.document;
      document.body.innerHTML = '';
      
      const p = document.createElement('p');
      p.innerHTML = 'hello <strong>world</strong>';
      document.body.appendChild(p);

      const host = document.createElement('div');
      document.body.appendChild(host);
      const shadow = host.attachShadow({ mode: 'open' });
      const shadowP = document.createElement('p');
      shadowP.textContent = 'shadow text';
      shadow.appendChild(shadowP);

      const codePath = path.join(__dirname, '../oculist.js');
      const code = fs.readFileSync(codePath, 'utf8');
      eval(code);

      global.window.__ocToggle();
      const wrap = document.getElementById('oc-wrap');
      const input = wrap.shadowRoot.querySelector('.oc-input');

      // Test split-node matching
      input.value = 'hello world';
      input.dispatchEvent(new global.window.Event('input'));
      await new Promise(resolve => setTimeout(resolve, 250));

      const wrapRoot = wrap.shadowRoot;
      const countEl = wrapRoot.querySelector('.oc-count');
      assert.strictEqual(countEl.textContent.trim(), '1 of 1', 'Should find exactly 1 split-node match');

      // Test shadow DOM piercing
      input.value = 'shadow text';
      input.dispatchEvent(new global.window.Event('input'));
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.strictEqual(countEl.textContent.trim(), '1 of 1', 'Should find exactly 1 match inside Shadow DOM');
    });

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

      // Test split-node matching
      input.value = 'hello world';
      input.dispatchEvent(new global.window.Event('input'));
      await new Promise(resolve => setTimeout(resolve, 250));

      const wrapRoot = wrap.shadowRoot;
      const countEl = wrapRoot.querySelector('.oc-count');
      assert.strictEqual(countEl.textContent.trim(), '1 of 1', 'Should find exactly 1 split-node match in content.js');

      // Test shadow DOM piercing
      input.value = 'shadow text';
      input.dispatchEvent(new global.window.Event('input'));
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.strictEqual(countEl.textContent.trim(), '1 of 1', 'Should find exactly 1 match inside Shadow DOM in content.js');
    });

  });
});
