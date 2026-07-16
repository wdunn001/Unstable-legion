/**
 * useTheme — light/dark preference for the Legion visual identity (see
 * styles.css's module doc comment). Stamps `data-theme="light"|"dark"`
 * on `<html>`, which overrides the `@media (prefers-color-scheme)`
 * fallback in BOTH directions. Persisted to localStorage so a returning
 * visitor's explicit choice sticks; a first-time visitor gets the OS
 * preference until they toggle.
 */
import { useCallback, useEffect, useState } from 'react';

export type ThemePreference = 'light' | 'dark';

const STORAGE_KEY = 'unstable-legion-chat:theme-v1';

function systemPrefersDark(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;
}

function loadStoredTheme(): ThemePreference | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === 'light' || raw === 'dark' ? raw : null;
  } catch {
    return null;
  }
}

export interface UseThemeHandle {
  theme: ThemePreference;
  toggle: () => void;
}

export function useTheme(): UseThemeHandle {
  const [theme, setTheme] = useState<ThemePreference>(() => loadStoredTheme() ?? (systemPrefersDark() ? 'dark' : 'light'));

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: ThemePreference = prev === 'dark' ? 'light' : 'dark';
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(STORAGE_KEY, next);
        } catch {
          /* quota / privacy — silent */
        }
      }
      return next;
    });
  }, []);

  return { theme, toggle };
}
