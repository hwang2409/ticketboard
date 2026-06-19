import { Moon, Sun } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

type ThemeName = 'light' | 'dark';

const THEME_STORAGE_KEY = 'ticketboard-theme';

function readInitialTheme(): ThemeName {
  if (typeof document === 'undefined') return 'light';
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'dark' || attr === 'light') return attr;
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    /* ignore */
  }
  return 'light';
}

function useTheme(): [ThemeName, () => void] {
  const [theme, setTheme] = useState<ThemeName>(readInitialTheme);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      const next = event.newValue;
      if (next === 'dark' || next === 'light') {
        setTheme(next);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const toggle = useCallback(() => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  return [theme, toggle];
}

type ThemeToggleProps = {
  className?: string;
};

export function ThemeToggle({ className = 'icon-button' }: ThemeToggleProps) {
  const [theme, toggle] = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  const label = `Switch to ${next} mode`;
  return (
    <button
      aria-label={label}
      aria-pressed={theme === 'dark'}
      className={`${className} theme-toggle`}
      data-theme-state={theme}
      onClick={toggle}
      title={label}
      type="button"
    >
      <span aria-hidden="true" className="theme-toggle-icon theme-toggle-sun">
        <Sun size={15} />
      </span>
      <span aria-hidden="true" className="theme-toggle-icon theme-toggle-moon">
        <Moon size={15} />
      </span>
    </button>
  );
}
