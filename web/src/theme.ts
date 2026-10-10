export type Theme = 'light' | 'dark';
export const THEME_STORAGE_KEY = 'asideTheme';
export const TEXT_SIZE_STORAGE_KEY = 'asideTextSize';
export const TEXT_SIZES = [100, 125, 150, 175, 200];

export function loadTextSize() {
  try { const size = Number(localStorage.getItem(TEXT_SIZE_STORAGE_KEY)); return TEXT_SIZES.includes(size) ? size : TEXT_SIZES[0]; }
  catch { return TEXT_SIZES[0]; }
}

export function applyTextSize(size: number) {
  document.documentElement.style.setProperty('--text-size', size + '%');
}

export function loadTheme(): Theme {
  try { return localStorage.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light'; }
  catch { return 'light'; }
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(root).getPropertyValue('--canvas').trim());
}
