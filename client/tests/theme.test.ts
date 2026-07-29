import { describe, expect, it } from 'vitest';
import { parseThemeMode, resolveDarkTheme } from '../src/utils/theme';

describe('theme preference', () => {
  it('validates persisted values', () => {
    expect(parseThemeMode('dark')).toBe('dark');
    expect(parseThemeMode('unexpected')).toBe('light');
    expect(parseThemeMode(null)).toBe('light');
  });

  it('resolves explicit and system themes', () => {
    expect(resolveDarkTheme('dark', false)).toBe(true);
    expect(resolveDarkTheme('light', true)).toBe(false);
    expect(resolveDarkTheme('system', true)).toBe(true);
  });
});
