import { bus } from './events.js';

// Light / dark theme. Follows the system setting until the user picks one with
// the sun/moon button; the choice is remembered in this browser.
const KEY = 'minicad-theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');

let app = null;
let chosen = null; // 'light' | 'dark' | null (= follow the system)

const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const write = (v) => { try { localStorage.setItem(KEY, v); } catch { /* storage blocked */ } };

export const isDark = () => (chosen ? chosen === 'dark' : media.matches);

function apply() {
  const dark = isDark();
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  if (app) {
    app.vp.setTheme(dark);
    app.viewCube.setTheme(dark);
    app.sketch.setTheme(dark);
  }
  bus.emit('theme', { dark });
}

export function initTheme(theApp) {
  app = theApp;
  const saved = read();
  chosen = saved === 'light' || saved === 'dark' ? saved : null;
  media.addEventListener('change', () => { if (!chosen) apply(); });
  apply();
}

export function toggleTheme() {
  chosen = isDark() ? 'light' : 'dark';
  write(chosen);
  apply();
}
