// applyTheme — the style projection. The brand/look is DATA in the cassette (theme.palette /
// fonts / radius); here we write it onto :root as CSS custom properties. Those inline properties
// beat the stylesheet, so the model becomes the source of truth for every VALUE while the CSS keeps
// only structure + a neutral fallback residue. The palette tokens are exactly the Tier-1 semantic
// tokens the S layer keys on (--surface, --ink, --accent, --state-*, …), so nothing downstream
// changes: a new brand is a new cassette, not a CSS rewrite. Re-called on light/dark switch.

import type { Cassette } from '@app/core-runtime';

export type ThemeMode = 'light' | 'dark';

export function applyTheme(theme: Cassette['theme'], mode: ThemeMode): void {
  const root = document.documentElement;
  root.dataset.theme = mode;
  root.style.setProperty('color-scheme', mode);
  if (!theme) return;
  const set = (k: string, v?: string): void => {
    if (v) root.style.setProperty(k, v);
  };
  for (const [tok, stack] of Object.entries(theme.fonts ?? {})) set(`--font-${tok}`, stack);
  for (const [tok, len] of Object.entries(theme.radius ?? {})) set(`--radius-${tok}`, len);
  for (const [tok, color] of Object.entries(theme.palette?.[mode] ?? {})) set(`--${tok}`, color);
}

/** The starting mode: a saved choice, else the OS preference. */
export function initialMode(): ThemeMode {
  try {
    const saved = localStorage.getItem('fk-theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* private mode — fall through to the OS preference */
  }
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
