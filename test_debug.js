const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('fs');

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost'
});

global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.localStorage = dom.window.localStorage;

// Mock Element.prototype.animate since JSDOM doesn't support the Web Animations API
dom.window.Element.prototype.animate = function(keyframes, options) {
  console.log('MOCK: animate() called with options:', options);
  return {
    finished: Promise.resolve(),
    cancel: () => {},
    play: () => {},
    pause: () => {}
  };
};

// Mock chrome extension APIs since content.js uses chrome.storage
global.chrome = {
  storage: {
    sync: {
      get: (key, cb) => cb({}),
      set: (data, cb) => cb && cb()
    }
  }
};

console.log('Environment mocked successfully. Loading oculist.js...');

try {
  // Read and execute content.js inside our global sandbox
  const oculistCode = fs.readFileSync('/Users/ccho/Documents/Projects/oculist/repo/extension/content.js', 'utf8');
  eval(oculistCode);
  console.log('content.js loaded successfully. Initializing...');
  
  // Toggle Oculist to show UI
  if (typeof window.__ocToggle === 'function') {
    window.__ocToggle();
    console.log('Oculist toggled. UI built.');
    
    // Find options/gear button in the shadow DOM
    const wrap = document.getElementById('oc-wrap');
    if (!wrap) {
      throw new Error('Could not find #oc-wrap element in document body');
    }
    
    const wrapRoot = wrap.shadowRoot;
    if (!wrapRoot) {
      throw new Error('Shadow root wrapRoot is missing on #oc-wrap');
    }
    
    const gearBtn = wrapRoot.querySelector('button[title^="Options"]');
    if (!gearBtn) {
      throw new Error('Could not find gear button in shadow DOM');
    }
    
    console.log('Gear button found. Simulating click to open Settings Panel...');
    gearBtn.click();
    
    // Check if settings panel exists in shadow DOM
    const settingsPanel = wrapRoot.querySelector('#oc-settings-panel');
    if (settingsPanel) {
      console.log('SUCCESS: Settings Panel opened successfully and found in shadow DOM!');
    } else {
      console.log('FAILURE: Settings Panel is not present in shadow DOM after click!');
    }
  } else {
    console.log('__ocToggle is not defined!');
  }
} catch (error) {
  console.error('ERROR ENCOUNTERED:', error);
}
