import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DASHBOARD_PAGE_SIZE_STORAGE_KEY,
  DEFAULT_DASHBOARD_PAGE_SIZE,
  PAGINATION_PAGE_SIZE_OPTIONS,
  isPaginationPageSize,
  readPageSize,
  writePageSize
} from '../src/utils/pagination';

function createStorage(initial?: Record<string, string>): Storage {
  const values = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    }
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pagination page-size preference', () => {
  it('accepts only the configured page-size options', () => {
    expect(PAGINATION_PAGE_SIZE_OPTIONS).toEqual([10, 20, 50, 100]);
    expect(isPaginationPageSize(20)).toBe(true);
    expect(isPaginationPageSize(15)).toBe(false);
    expect(isPaginationPageSize('20')).toBe(false);
  });

  it('persists a selected size and reads it on the next initialization', () => {
    const storage = createStorage();
    vi.stubGlobal('localStorage', storage);

    expect(readPageSize(DASHBOARD_PAGE_SIZE_STORAGE_KEY, DEFAULT_DASHBOARD_PAGE_SIZE)).toBe(10);
    expect(writePageSize(DASHBOARD_PAGE_SIZE_STORAGE_KEY, 50)).toBe(true);
    expect(readPageSize(DASHBOARD_PAGE_SIZE_STORAGE_KEY, DEFAULT_DASHBOARD_PAGE_SIZE)).toBe(50);
  });

  it('falls back safely for malformed cache values or storage failures', () => {
    const storage = createStorage({ [DASHBOARD_PAGE_SIZE_STORAGE_KEY]: 'not-a-size' });
    vi.stubGlobal('localStorage', storage);
    expect(readPageSize(DASHBOARD_PAGE_SIZE_STORAGE_KEY, DEFAULT_DASHBOARD_PAGE_SIZE)).toBe(10);
    expect(writePageSize(DASHBOARD_PAGE_SIZE_STORAGE_KEY, 15)).toBe(false);

    vi.stubGlobal('localStorage', {
      getItem(): string | null {
        throw new Error('storage blocked');
      },
      setItem(): void {
        throw new Error('storage blocked');
      }
    });
    expect(readPageSize(DASHBOARD_PAGE_SIZE_STORAGE_KEY, DEFAULT_DASHBOARD_PAGE_SIZE)).toBe(10);
    expect(writePageSize(DASHBOARD_PAGE_SIZE_STORAGE_KEY, 20)).toBe(false);
  });
});
