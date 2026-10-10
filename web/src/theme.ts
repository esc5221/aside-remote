// 테마는 html 의 CSS 변수 묶음이다 (global.css). 'auto' 는 저장값일 뿐이고
// <html data-theme> 에는 항상 실제로 그리는 테마(light | dark | linear)가 들어간다.
// 첫 페인트 전 적용은 index.html 의 인라인 스크립트가 같은 규칙으로 한다.
export type Theme = 'auto' | 'light' | 'dark' | 'linear';
export type ResolvedTheme = Exclude<Theme, 'auto'>;
export const THEME_STORAGE_KEY = 'asideTheme';
export const FONT_STORAGE_KEY = 'asideFont';
export const DEFAULT_FONT = 'wanted-sans';
export const TEXT_SIZE_STORAGE_KEY = 'asideTextSize';
export const TEXT_SIZES = [100, 125, 150, 175, 200];

// sw = 설정 화면 견본 (배경 · 표면 · 강조)
export const THEMES: { id: Theme; label: string; sw: string[] }[] = [
  { id: 'auto', label: 'System', sw: ['#ffffff', '#212121', '#171717'] },
  { id: 'light', label: 'Light', sw: ['#ffffff', '#f7f7f7', '#171717'] },
  { id: 'dark', label: 'Dark', sw: ['#212121', '#2f2f2f', '#f3f3f3'] },
  { id: 'linear', label: 'Linear dark', sw: ['#0f1011', '#191a1b', '#5e6ad2'] },
];

const systemDark = () => matchMedia('(prefers-color-scheme: dark)').matches;

export function loadTextSize() {
  try { const size = Number(localStorage.getItem(TEXT_SIZE_STORAGE_KEY)); return TEXT_SIZES.includes(size) ? size : TEXT_SIZES[0]; }
  catch { return TEXT_SIZES[0]; }
}

export function applyTextSize(size: number) {
  document.documentElement.style.setProperty('--text-size', size + '%');
}

export function loadTheme(): Theme {
  try { const saved = localStorage.getItem(THEME_STORAGE_KEY); return THEMES.some(theme => theme.id === saved) ? saved as Theme : 'auto'; }
  catch { return 'auto'; }
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  return theme === 'auto' ? (systemDark() ? 'dark' : 'light') : theme;
}

// 다크 여부는 테마 이름이 아니라 실제 color-scheme 에서 읽는다 — 사용자 theme.css 가 바꿔도 따라간다.
export function isDarkScheme() {
  return getComputedStyle(document.documentElement).getPropertyValue('color-scheme').includes('dark');
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(theme);
  const scheme = isDarkScheme() ? 'dark' : 'light';
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', scheme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(root).getPropertyValue('--canvas').trim());
}

// 'auto' 일 때 시스템 설정이 바뀌면 따라간다.
export function watchSystemTheme(getTheme: () => Theme, onChange: () => void) {
  const query = matchMedia('(prefers-color-scheme: dark)');
  const listener = () => { if (getTheme() === 'auto') { applyTheme('auto'); onChange(); } };
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

export type FontOption = { id: string; label: string; kind: string; webfont: boolean; stack: string };

export function loadFont() {
  try { return localStorage.getItem(FONT_STORAGE_KEY) || DEFAULT_FONT; }
  catch { return DEFAULT_FONT; }
}

// 본문(대화 답변) 폰트. UI 는 Wanted Sans, 코드는 D2Coding 으로 고정이다.
export function applyFont(id: string, fonts: FontOption[]) {
  const font = fonts.find(option => option.id === id);
  if (!font) return;
  document.documentElement.style.setProperty('--font-body', font.stack);
  let link = document.getElementById('body-font-css') as HTMLLinkElement | null;
  if (!font.webfont) { link?.remove(); return; }
  if (!link) { link = document.createElement('link'); link.id = 'body-font-css'; link.rel = 'stylesheet'; document.head.append(link); }
  const href = '/api/font/css/' + encodeURIComponent(font.id);
  if (link.getAttribute('href') !== href) link.href = href;
}
