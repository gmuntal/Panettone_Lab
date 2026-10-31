const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../app/static/theme.js'), 'utf8');

function mount({ dark = false, saved = null, mode = null } = {}) {
  const storage = new Map(saved ? [['panettone-lab-theme', saved]] : []);
  if (mode) storage.set('panettone-lab-ui-mode', mode);
  const root = { dataset: {} };
  const meta = { content: '', setAttribute(name, value) { if (name === 'content') this.content = value; } };
  const listeners = {};
  const dispatched = [];
  const mediaListeners = [];
  const select = { value: '', addEventListener(name, callback) { listeners[`select:${name}`] = callback; } };
  const modeSelect = { id: 'ui-mode-preference', value: '', addEventListener(name, callback) { listeners[`mode-select:${name}`] = callback; } };
  const domListeners = {};
  const context = vm.createContext({
    document: {
      documentElement: root,
      querySelector: () => meta,
      getElementById: id => id === 'theme-preference' ? select : id === 'ui-mode-preference' ? modeSelect : null,
      addEventListener: (name, callback) => { domListeners[name] = callback; }
    },
    window: {
      localStorage: {
        getItem: key => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value)
      },
      matchMedia: () => ({ matches: dark, addEventListener: (name, callback) => mediaListeners.push(callback) }),
      addEventListener: (name, callback) => { listeners[`window:${name}`] = callback; },
      dispatchEvent: event => { dispatched.push(event.type); listeners[`window:${event.type}`]?.(event); }
    }
    ,Event
  });
  vm.runInContext(source, context);
  return { context, root, meta, storage, select, modeSelect, listeners, mediaListeners, domListeners, dispatched };
}

test('automatic theme follows the system and updates the browser chrome color', () => {
  const ui = mount({ dark: true });
  assert.equal(ui.root.dataset.theme, 'dark');
  assert.equal(ui.root.dataset.themePreference, 'auto');
  assert.equal(ui.meta.content, '#111a16');
  ui.mediaListeners[0]();
  assert.equal(ui.root.dataset.theme, 'dark');
});

test('manual theme preference persists and overrides automatic mode', () => {
  const ui = mount({ dark: true });
  assert.equal(ui.context.window.PanettoneTheme.setPreference('light'), true);
  assert.equal(ui.storage.get('panettone-lab-theme'), 'light');
  assert.equal(ui.root.dataset.theme, 'light');
  assert.equal(ui.meta.content, '#f6f8f5');
  assert.equal(ui.context.window.PanettoneTheme.setPreference('invalid'), false);
});

test('settings selector reflects a saved preference and updates it', () => {
  const ui = mount({ saved: 'dark' });
  ui.domListeners.DOMContentLoaded();
  assert.equal(ui.select.value, 'dark');
  ui.select.value = 'auto';
  ui.listeners['select:change']();
  assert.equal(ui.storage.get('panettone-lab-theme'), 'auto');
});

test('a saved preference is used on the next page load', () => {
  const ui = mount({ dark: false, saved: 'dark' });
  assert.equal(ui.root.dataset.theme, 'dark');
  assert.equal(ui.root.dataset.themePreference, 'dark');
});

test('the actual mode selector switches immediately, persists, and restores after reload', () => {
  const ui = mount();
  assert.equal(ui.root.dataset.uiMode, 'simple');
  ui.domListeners.DOMContentLoaded();
  assert.equal(ui.modeSelect.value, 'simple');
  ui.modeSelect.value = 'advanced';
  ui.domListeners.change({ target: ui.modeSelect });
  assert.equal(ui.root.dataset.uiMode, 'advanced');
  assert.ok(ui.dispatched.includes('panettone:modechange'));
  assert.equal(ui.storage.get('panettone-lab-ui-mode'), 'advanced');
  assert.equal(mount({ mode: ui.storage.get('panettone-lab-ui-mode') }).root.dataset.uiMode, 'advanced');
  ui.modeSelect.value = 'simple';
  ui.domListeners.change({ target: ui.modeSelect });
  assert.equal(ui.root.dataset.uiMode, 'simple');
  assert.equal(ui.modeSelect.value, 'simple');
  assert.equal(ui.storage.get('panettone-lab-ui-mode'), 'simple');
  assert.equal(ui.context.window.PanettoneUI.setMode('unknown'), false);
  assert.equal(mount({ mode: 'advanced' }).root.dataset.uiMode, 'advanced');
});
