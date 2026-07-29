import { computed, onBeforeUnmount, ref } from 'vue';
import { defineStore } from 'pinia';
import type { ThemeMode } from '../types';
import { parseThemeMode, resolveDarkTheme, THEME_STORAGE_KEY } from '../utils/theme';

export const useThemeStore = defineStore('theme', () => {
  const mode = ref<ThemeMode>(parseThemeMode(localStorage.getItem(THEME_STORAGE_KEY)));
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const systemDark = ref(media.matches);
  const onSystemChange = (event: MediaQueryListEvent) => (systemDark.value = event.matches);
  media.addEventListener('change', onSystemChange);
  onBeforeUnmount(() => media.removeEventListener('change', onSystemChange));

  const isDark = computed(() => resolveDarkTheme(mode.value, systemDark.value));
  function setMode(value: ThemeMode): void {
    mode.value = value;
    localStorage.setItem(THEME_STORAGE_KEY, value);
  }
  return { mode, isDark, setMode };
});
