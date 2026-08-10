/**
 * Page-size preferences used by the paginated views.
 *
 * Keep these values in one place so persisted preferences cannot make a
 * pagination control render an option that it does not support.
 */
export const PAGINATION_PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;

export type PaginationPageSize = (typeof PAGINATION_PAGE_SIZE_OPTIONS)[number];

export const DEFAULT_DASHBOARD_PAGE_SIZE: PaginationPageSize = 10;
export const DEFAULT_POOL_USAGE_PAGE_SIZE: PaginationPageSize = 20;

export const DASHBOARD_PAGE_SIZE_STORAGE_KEY = 'relay-pulse-dashboard-page-size';
export const POOL_USAGE_PAGE_SIZE_STORAGE_KEY = 'relay-pulse-usage-page-size';

export function isPaginationPageSize(value: unknown): value is PaginationPageSize {
  return typeof value === 'number' && PAGINATION_PAGE_SIZE_OPTIONS.includes(value as PaginationPageSize);
}

function getLocalStorage(): Storage | undefined {
  try {
    if (typeof globalThis === 'undefined') return undefined;
    return (globalThis as typeof globalThis & { localStorage?: Storage }).localStorage;
  } catch {
    // Access can fail when storage is disabled or blocked by the browser.
    return undefined;
  }
}

export function readPageSize(key: string, fallback: PaginationPageSize): PaginationPageSize {
  const safeFallback = isPaginationPageSize(fallback) ? fallback : DEFAULT_DASHBOARD_PAGE_SIZE;
  const storage = getLocalStorage();
  if (!storage) return safeFallback;

  try {
    const stored = storage.getItem(key);
    if (stored === null) return safeFallback;
    const parsed = Number(stored);
    return isPaginationPageSize(parsed) ? parsed : safeFallback;
  } catch {
    return safeFallback;
  }
}

export function writePageSize(key: string, value: unknown): boolean {
  if (!isPaginationPageSize(value)) return false;
  const storage = getLocalStorage();
  if (!storage) return false;

  try {
    storage.setItem(key, String(value));
    return true;
  } catch {
    return false;
  }
}
