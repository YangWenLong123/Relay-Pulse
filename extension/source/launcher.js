const extensionApi = globalThis.browser ?? globalThis.chrome;
const pageUrl = extensionApi.runtime.getURL('index.html#/');
const fallbackLink = document.querySelector('#fallback-link');
const statusText = document.querySelector('#launch-status');
const dataMode = document.querySelector('meta[name="relay-pulse-data-mode"]')?.getAttribute('content')?.trim().toLowerCase();
const standaloneMode = dataMode === 'standalone';

const LAUNCH_TIMEOUT_MS = 30_000;

if (fallbackLink) fallbackLink.href = pageUrl;

function messageFrom(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : fallback;
}

function setStatus(value, failed = false) {
  if (statusText) statusText.textContent = value;
  document.body.dataset.launchFailed = failed ? 'true' : 'false';
}

function withTimeout(promise) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('启动本机服务超时')), LAUNCH_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function dashboardUrl(backendState) {
  const url = new URL(pageUrl);
  if (standaloneMode) return url.toString();

  if (backendState?.apiUrl) url.searchParams.set('relayPulseBackendApiUrl', backendState.apiUrl);
  url.searchParams.set('relayPulseBackendReady', backendState?.ok === true ? '1' : '0');
  if (backendState?.error?.message) {
    url.searchParams.set('relayPulseBackendError', messageFrom(backendState.error.message, '本机服务不可用'));
  }
  return url.toString();
}

async function openDashboard(backendState) {
  try {
    const pendingTab = extensionApi.tabs.create({ url: dashboardUrl(backendState) });
    if (pendingTab && typeof pendingTab.then === 'function') await pendingTab;
    window.close();
  } catch {
    document.body.dataset.launchFailed = 'true';
  }
}

async function launch() {
  if (standaloneMode) {
    setStatus('正在打开 Relay Pulse…');
    await openDashboard();
    return;
  }

  let backendState;
  try {
    setStatus('正在启动本机服务…');
    if (!globalThis.RelayPulseNativeBackend?.ensureBackend) {
      throw new Error('扩展本机服务组件未加载');
    }
    backendState = await withTimeout(globalThis.RelayPulseNativeBackend.ensureBackend());
    if (backendState?.ok === true) {
      setStatus('本机服务已就绪，正在打开…');
    } else {
      setStatus(`本机服务未就绪：${messageFrom(backendState?.error?.message, '请安装本机服务组件')}`, true);
    }
  } catch (error) {
    backendState = {
      ok: false,
      apiUrl: 'http://127.0.0.1:3100/api',
      error: { message: messageFrom(error?.message, '请安装本机服务组件') }
    };
    setStatus(`本机服务未就绪：${backendState.error.message}`, true);
  }

  // Keep opening the UI so a manually started legacy backend remains usable.
  await openDashboard(backendState);
}

void launch();
