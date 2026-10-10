export const VISUAL_MESSAGE_PREFIX = 'aside.visual.';

export function visualTheme() {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const color = (name: string) => style.getPropertyValue(name).trim();
  const isDark = root.dataset.theme === 'dark';
  const success = isDark ? '#a7d6a7' : '#36713b';
  return {
    scheme: isDark ? 'dark' : 'light',
    variables: {
      '--background': color('--canvas'), '--foreground': color('--text'),
      '--muted-foreground': color('--muted'), '--border': color('--border'),
      '--surface-primary': color('--surface'), '--surface-secondary': color('--bubble'),
      '--primary': color('--text'), '--primary-foreground': color('--canvas'),
      '--destructive': color('--danger'), '--ring': color('--control-border'),
      '--chart-1': isDark ? '#9ec4ff' : '#205cc9', '--chart-2': success,
      '--chart-3': isDark ? '#e5c07b' : '#855b00', '--chart-4': isDark ? '#dda5df' : '#a626a4',
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
    let lastHeight = 0;
    let frame = 0;
    const resize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const height = Math.ceil(Math.max(document.body.scrollHeight, document.body.getBoundingClientRect().height));
        if (height !== lastHeight) { lastHeight = height; parent.postMessage({ type: prefix + 'resize', id, height }, '*'); }
      });
    };
    addEventListener('message', event => {
      const data = event.data;
      if (event.source !== parent || data?.type !== prefix + 'theme' || data.id !== id) return;
      for (const [name, value] of Object.entries(data.variables)) document.documentElement.style.setProperty(name, value);
      document.documentElement.style.colorScheme = data.scheme;
      resize();
    });
    addEventListener('DOMContentLoaded', () => {
      new ResizeObserver(resize).observe(document.body);
      document.fonts.ready.then(resize);
      parent.postMessage({ type: prefix + 'ready', id }, '*');
      resize();
    }, { once: true });
    addEventListener('resize', resize);
    addEventListener('load', resize);
  })();`;
  doc.body.append(script);
  return '<!doctype html>\n' + doc.documentElement.outerHTML;
}
