const extensionApi = globalThis.browser ?? globalThis.chrome;
const pageUrl = extensionApi.runtime.getURL('index.html#/');
const fallbackLink = document.querySelector('#fallback-link');

if (fallbackLink) fallbackLink.href = pageUrl;

async function openDashboard() {
  try {
    const pendingTab = extensionApi.tabs.create({ url: pageUrl });
    if (pendingTab && typeof pendingTab.then === 'function') await pendingTab;
    window.close();
  } catch {
    document.body.dataset.launchFailed = 'true';
  }
}

void openDashboard();
