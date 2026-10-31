(() => {
  const storageKey = 'panettone-lab-theme';
  const modeStorageKey = 'panettone-lab-ui-mode';
  const root = document.documentElement;
  const systemTheme = window.matchMedia?.('(prefers-color-scheme: dark)');

  function getPreference() {
    try {
      const saved = window.localStorage.getItem(storageKey);
      return ['light', 'dark', 'auto'].includes(saved) ? saved : 'auto';
    } catch {
      return 'auto';
    }
  }

  function applyPreference(preference = getPreference()) {
    const previous = root.dataset.theme;
    const resolved = preference === 'auto'
      ? (systemTheme?.matches ? 'dark' : 'light')
      : preference;
    root.dataset.theme = resolved;
    root.dataset.themePreference = preference;
    const color = resolved === 'dark' ? '#111a16' : '#f6f8f5';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
    if (previous && previous !== resolved) {
      window.dispatchEvent(new Event('panettone:themechange'));
    }
    return resolved;
  }

  function setPreference(preference) {
    if (!['light', 'dark', 'auto'].includes(preference)) return false;
    try {
      window.localStorage.setItem(storageKey, preference);
    } catch {
      // Keep the current-tab preference even when browser storage is unavailable.
    }
    applyPreference(preference);
    return true;
  }

  function getMode() {
    try { return window.localStorage.getItem(modeStorageKey) === 'advanced' ? 'advanced' : 'simple'; }
    catch { return 'simple'; }
  }
  function setMode(mode) {
    if (!['simple', 'advanced'].includes(mode)) return false;
    try { window.localStorage.setItem(modeStorageKey, mode); } catch { /* Browser-only preference. */ }
    root.dataset.uiMode = mode;
    window.dispatchEvent(new Event('panettone:modechange'));
    return true;
  }

  applyPreference();
  window.PanettoneTheme = { getPreference, setPreference, applyPreference };
  root.dataset.uiMode = getMode();
  window.PanettoneUI = { getMode, setMode };
  systemTheme?.addEventListener?.('change', () => {
    if (getPreference() === 'auto') applyPreference('auto');
  });
  window.addEventListener('storage', event => {
    if (event.key === storageKey) applyPreference();
    if (event.key === modeStorageKey) {
      root.dataset.uiMode = getMode();
      window.dispatchEvent(new Event('panettone:modechange'));
    }
  });
  document.addEventListener('DOMContentLoaded', () => {
    const select = document.getElementById('theme-preference');
    if (!select) return;
    select.value = getPreference();
    select.addEventListener('change', () => setPreference(select.value));
  });
})();
