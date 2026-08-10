import { describe, expect, it } from 'vitest';
import { parseThemeMode, resolveDarkTheme } from '../src/utils/theme';

describe('theme preference', () => {
  it('validates persisted values', () => {
    expect(parseThemeMode('dark')).toBe('dark');
    expect(parseThemeMode('light')).toBe('light');
    expect(parseThemeMode('system')).toBe('light');
    expect(parseThemeMode('unexpected')).toBe('light');
    expect(parseThemeMode(null)).toBe('light');
  });

  it('resolves explicit themes', () => {
    expect(resolveDarkTheme('dark')).toBe(true);
    expect(resolveDarkTheme('light')).toBe(false);
  });
});
