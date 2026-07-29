(() => {
  try {
    const saved = localStorage.getItem('relay-pulse-theme');
    const mode = ['light', 'dark', 'system'].includes(saved) ? saved : 'light';
    const dark = mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#151918' : '#f5f7f6');
  } catch {
    document.documentElement.dataset.theme = 'light';
  }
})();
