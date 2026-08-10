(() => {
  try {
    const saved = localStorage.getItem('relay-pulse-theme');
    const mode = saved === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = mode;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', mode === 'dark' ? '#151918' : '#f5f7f6');
  } catch {
    document.documentElement.dataset.theme = 'light';
  }
})();
