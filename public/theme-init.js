// Apply appearance before the renderer loads to avoid a light flash in dark mode.
(() => {
  let preference = 'system';
  try {
    const saved = localStorage.getItem('photo-proofer-theme');
    if (saved === 'light' || saved === 'dark') preference = saved;
  } catch { /* Follow the system when storage is unavailable. */ }
  const dark = preference === 'dark' || (preference === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
})();
