import type { ThemeMode } from '../types';

export const THEME_STORAGE_KEY = 'relay-pulse-theme';
const MODES: ThemeMode[] = ['light', 'dark', 'system'];

export function parseThemeMode(value: string | null): ThemeMode {
  return MODES.includes(value as ThemeMode) ? (value as ThemeMode) : 'light';
}

export function resolveDarkTheme(mode: ThemeMode, systemDark: boolean): boolean {
  return mode === 'dark' || (mode === 'system' && systemDark);
}
