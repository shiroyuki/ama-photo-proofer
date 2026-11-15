import type { ThemePreference } from '../shared/model';
const storageKey = 'photo-proofer-theme';
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
const valid = (value: unknown): value is ThemePreference => value === 'system' || value === 'light' || value === 'dark';
let preference: ThemePreference = 'system';
try { const stored = localStorage.getItem(storageKey); if (valid(stored)) preference = stored; } catch { /* Native settings remain available. */ }
export const themePreference = () => preference;
function apply() {
  const dark = preference === 'dark' || (preference === 'system' && systemTheme.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  document.querySelectorAll<HTMLSelectElement>('[data-theme-switcher]').forEach(select => { select.value = preference; });
}
function remember(value: ThemePreference) {
  preference = value;
  try { localStorage.setItem(storageKey, preference); } catch { /* Electron also persists this setting on disk. */ }
  apply();
}
export async function setThemePreference(value: string) {
  if (!valid(value)) return;
  if (window.desktop) await window.desktop.setTheme(value);
  else localStorage.setItem(storageKey, value);
  remember(value);
}
systemTheme.addEventListener('change', () => { if (preference === 'system') apply(); });
apply();
if (window.desktop) void window.desktop.getTheme().then(remember).catch(() => { /* Keep the last known appearance if preferences cannot be read. */ });
