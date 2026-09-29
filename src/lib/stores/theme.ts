// Theme store.
// Applies theme colors to CSS custom properties on :root.

import type { Theme } from '$lib/types';

/** Apply a theme's colors to the document root CSS custom properties.
 *  Theme keys already include the `--` prefix (e.g. "--color-background"). */
/** Track which custom properties the last-applied theme set, so switching to
 *  a theme that defines fewer keys cannot inherit stale colors. */
let appliedKeys: string[] = [];

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  // Remove keys the previous theme set but this one doesn't define.
  for (const key of appliedKeys) {
    if (!(key in theme.colors)) root.style.removeProperty(key);
  }
  appliedKeys = [];
  for (const [key, value] of Object.entries(theme.colors)) {
    root.style.setProperty(key, value);
    appliedKeys.push(key);
  }
}
