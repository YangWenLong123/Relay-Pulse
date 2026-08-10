import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { ThemeMode } from '../types';
import { parseThemeMode, resolveDarkTheme, THEME_STORAGE_KEY } from '../utils/theme';

export const useThemeStore = defineStore('theme', () => {
  const mode = ref<ThemeMode>(parseThemeMode(localStorage.getItem(THEME_STORAGE_KEY)));

  const isDark = computed(() => resolveDarkTheme(mode.value));
  function setMode(value: ThemeMode): void {
    mode.value = value;
    localStorage.setItem(THEME_STORAGE_KEY, value);
  }
  return { mode, isDark, setMode };
});
