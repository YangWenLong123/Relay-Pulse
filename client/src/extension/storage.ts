export interface ExtensionStorage {
  get<T>(key: string): Promise<T | undefined>;
  set(values: Record<string, unknown>): Promise<void>;
}

interface PromiseStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

interface CallbackStorageArea {
  get(key: string, callback: (items: Record<string, unknown>) => void): void;
  set(values: Record<string, unknown>, callback: () => void): void;
}

interface ExtensionGlobals {
  browser?: { storage?: { local?: PromiseStorageArea } };
  chrome?: {
    runtime?: { lastError?: { message?: string } };
    storage?: { local?: CallbackStorageArea };
  };
}

export function createBrowserExtensionStorage(): ExtensionStorage {
  const extensionGlobals = globalThis as typeof globalThis & ExtensionGlobals;
  const browserStorage = extensionGlobals.browser?.storage?.local;
  if (browserStorage) {
    return {
      async get<T>(key: string): Promise<T | undefined> {
        const values = await browserStorage.get(key);
        return values[key] as T | undefined;
      },
      async set(values: Record<string, unknown>): Promise<void> {
        await browserStorage.set(values);
      }
    };
  }

  const chromeStorage = extensionGlobals.chrome?.storage?.local;
  if (chromeStorage) {
    return {
      get<T>(key: string): Promise<T | undefined> {
        return new Promise((resolve, reject) => {
          chromeStorage.get(key, (values) => {
            const error = extensionGlobals.chrome?.runtime?.lastError;
            if (error) reject(new Error(error.message || '读取浏览器扩展存储失败'));
            else resolve(values[key] as T | undefined);
          });
        });
      },
      set(values: Record<string, unknown>): Promise<void> {
        return new Promise((resolve, reject) => {
          chromeStorage.set(values, () => {
            const error = extensionGlobals.chrome?.runtime?.lastError;
            if (error) reject(new Error(error.message || '写入浏览器扩展存储失败'));
            else resolve();
          });
        });
      }
    };
  }

  throw new Error('浏览器扩展存储不可用，请重新加载扩展');
}
