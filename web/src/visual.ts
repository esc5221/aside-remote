export const VISUAL_MESSAGE_PREFIX = 'aside.visual.';

export function visualTheme() {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const color = (name: string) => style.getPropertyValue(name).trim();
  // 다크 여부와 차트 색은 테마 변수에서 온다 — 프리셋과 사용자 theme.css 를 그대로 따라간다.
  const isDark = style.getPropertyValue('color-scheme').includes('dark');
  const success = color('--syntax-string');
  return {
    scheme: isDark ? 'dark' : 'light',
    variables: {
      '--background': color('--canvas'), '--foreground': color('--text'),
      '--muted-foreground': color('--muted'), '--border': color('--border'),
      '--surface-primary': color('--surface'), '--surface-secondary': color('--bubble'),
      '--primary': color('--primary'), '--primary-foreground': color('--primary-foreground'),
      '--destructive': color('--danger'), '--ring': color('--primary'),
      '--chart-1': color('--syntax-title'), '--chart-2': success,
      '--chart-3': color('--syntax-number'), '--chart-4': color('--syntax-keyword'),
      '--chart-5': color('--danger'), '--success': success,
      '--font-sans': '"Wanted Sans Variable", "Wanted Sans", sans-serif', '--radius': '12px',
    },
  };
}

export function visualDocument(source: string, id: string) {
  const doc = new DOMParser().parseFromString(source, 'text/html');
  doc.querySelectorAll('base, meta[http-equiv]').forEach(node => node.remove());
  doc.querySelectorAll('style').forEach(node => {
    node.textContent = node.textContent?.replace(/minmax\(\s*(\d*\.?\d+(?:px|rem|em))\s*,\s*1fr\s*\)/gi, 'minmax(min($1, 100%), 1fr)') ?? '';
  });
  const policy = doc.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = `default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; style-src 'unsafe-inline' ${location.origin}/api/font/css/; font-src ${location.origin}/api/font/file/; img-src data: blob: https:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  const viewport = doc.createElement('meta');
  viewport.name = 'viewport'; viewport.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no';
  const font = doc.createElement('link');
  font.rel = 'stylesheet'; font.href = location.origin + '/api/font/css/wanted-sans';
  const style = doc.createElement('style');
  const theme = visualTheme();
  style.textContent = `:root{${Object.entries(theme.variables).map(([name, value]) => `${name}:${value}`).join(';')};color-scheme:${theme.scheme}}html{margin:0;width:100%;min-width:0;overflow-x:hidden;-webkit-text-size-adjust:100%;background:var(--background);color:var(--foreground)}body{margin:0;padding:16px;min-width:0;max-width:100%;font:14px/1.6 var(--font-sans);overflow-wrap:anywhere}*{box-sizing:border-box;font-family:var(--font-sans)!important;touch-action:pan-x pan-y}img,svg,video,canvas{max-width:100%}pre{max-width:100%;overflow:auto}button,input,textarea,select{font:inherit}:focus,:focus-visible{outline:none}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}`;
  doc.head.prepend(policy, viewport, font, style);
  const script = doc.createElement('script');
  script.textContent = `(() => {
    const id = ${JSON.stringify(id)};
    const prefix = ${JSON.stringify(VISUAL_MESSAGE_PREFIX)};
    addEventListener('message', event => {
      const data = event.data;
      if (event.source !== parent || data?.type !== prefix + 'theme' || data.id !== id) return;
      for (const [name, value] of Object.entries(data.variables)) document.documentElement.style.setProperty(name, value);
      document.documentElement.style.colorScheme = data.scheme;
    });
    addEventListener('DOMContentLoaded', () => {
      parent.postMessage({ type: prefix + 'ready', id }, '*');
    }, { once: true });
  })();`;
  doc.body.append(script);
  return '<!doctype html>\n' + doc.documentElement.outerHTML;
}
