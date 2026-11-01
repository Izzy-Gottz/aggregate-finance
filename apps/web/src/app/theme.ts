import type { Preferences } from '../api/types.ts'

const KEY = 'agfn.theme'

/** Light (default) / dark / system. Stored per browser so the first paint is right; Preferences saves it on the server too. */
export function applyTheme(t: Preferences['theme']): void {
  const root = document.documentElement
  // Light unless dark is chosen; "System" follows the device only for people who pick it.
  const dark = t === 'dark' || (t === 'system' && typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches)
  root.setAttribute('data-theme', dark ? 'dark' : 'light')
  try {
    localStorage.setItem(KEY, t)
  } catch {
    /* private mode: fine */
  }
}

export function initialTheme(): Preferences['theme'] {
  const q = new URLSearchParams(location.search).get('theme')
  if (q === 'light' || q === 'dark' || q === 'system') return q
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    /* ignore */
  }
  return 'light'
}
