import { useCallback, useEffect, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Check } from 'lucide-react';
import type { UseChat } from './types';
import { ICON_STROKE, CloseButton, styles as ui } from './ui';
import { tokens } from './tokens.stylex';
import { formatRequestError } from './errors';
import { TEXT_SIZES, THEMES, FONT_STORAGE_KEY, applyFont, loadFont, type Theme, type FontOption } from './theme';
import { useAutoRefresh } from './useAutoRefresh';
import type { PushNotifications } from './notifications';
import { parseHealth } from './responses';

type Health = ReturnType<typeof parseHealth>;

export function Settings({ chat, onClose, notify, notifications, theme, onThemeChange, textSize, onTextSizeChange }: { chat: UseChat; onClose: () => void; notify: (text: string, kind?: 'error' | 'success') => void; notifications: PushNotifications; theme: Theme; onThemeChange: (theme: Theme) => void; textSize: number; onTextSizeChange: (size: number) => void }) {
  const [fonts, setFonts] = useState<FontOption[]>([]); const [font, setFont] = useState(loadFont);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/font/list', { signal: controller.signal }).then(response => response.json()).then((data: { fonts: FontOption[] }) => setFonts(data.fonts)).catch(() => {});
    return () => controller.abort();
  }, []);
  function changeFont(id: string) {
    applyFont(id, fonts); setFont(id);
    try { localStorage.setItem(FONT_STORAGE_KEY, id); }
    catch { notify('Font changed, but your browser could not save the preference.', 'error'); }
  }
  const [token, setToken] = useState(''); const [isSaving, setSaving] = useState(false); const [health, setHealth] = useState<Health>(); const [error, setError] = useState('');
  const [browserStatus, setBrowserStatus] = useState<'checking' | 'connected' | 'unavailable'>('checking');
  const refresh = useCallback(async (signal: AbortSignal) => {
    const [healthResult, browserResult] = await Promise.allSettled([
      chat.request('/api/health', { cache: 'no-store', signal }).then(response => response.json()).then(parseHealth),
      chat.request('/api/tabs?refresh=true', { cache: 'no-store', signal }),
    ]);
    if (signal.aborted) return;
    setError('');
    if (healthResult.status === 'fulfilled') setHealth(healthResult.value);
    else { setHealth(undefined); setError('Could not check the connection.'); }
    setBrowserStatus(browserResult.status === 'fulfilled' ? 'connected' : 'unavailable');
    if (browserResult.status === 'rejected') setError(formatRequestError({ message: browserResult.reason instanceof Error ? browserResult.reason.message : undefined }));
  }, [chat.request]);
  useAutoRefresh(refresh, 5_000);
  return <div {...stylex.props(styles.content)}><div {...stylex.props(styles.header)}><h2 {...stylex.props(ui.title)}>Settings</h2><CloseButton onClick={onClose} /></div>
    <section><h3 {...stylex.props(styles.heading)}>Connection</h3><div {...stylex.props(styles.statusRow)}><span>Bridge</span><span {...stylex.props(ui.muted)}>{chat.isConnected ? 'Connected' : 'Reconnecting…'}</span></div>
      <div {...stylex.props(styles.statusRow)}><span>Aside</span><span {...stylex.props(ui.muted)}>{health ? health.asideApp ? 'Running' : 'Not running' : error ? 'Unavailable' : 'Checking…'}</span></div>
      <div {...stylex.props(styles.statusRow)}><span>Browser</span><span {...stylex.props(ui.muted)}>{browserStatus === 'connected' ? 'Connected' : browserStatus === 'unavailable' ? 'Unavailable' : 'Checking…'}</span></div>
      {error && <p role="alert" {...stylex.props(ui.muted)}>{error}</p>}
      {health && !health.asideApp && <div {...stylex.props(styles.actions)}><button {...stylex.props(ui.button)} onClick={async () => { try { await chat.request('/api/aside/launch', { method: 'POST' }); notify('Aside opened.', 'success'); } catch { notify('Could not open Aside.', 'error'); } }}>Open Aside</button></div>}
    </section>
    <section><h3 {...stylex.props(styles.heading)}>Access token</h3><p id="access-token-help" {...stylex.props(ui.muted)}>Only needed when your connection does not sign you in automatically.</p>
      <form onSubmit={async event => { event.preventDefault(); setSaving(true); try { if (await chat.saveToken(token)) setToken(''); } finally { setSaving(false); } }}><input {...stylex.props(ui.field)} type="password" value={token} autoComplete="off" aria-label="Access token" aria-describedby="access-token-help" placeholder="Paste your access token" onChange={event => setToken(event.target.value)} /><button {...stylex.props(ui.button, ui.primary, styles.save)} disabled={isSaving || !token.trim()}>{isSaving ? 'Connecting…' : 'Connect'}</button></form>
    </section>
    <section><h3 {...stylex.props(styles.heading)}>Notifications</h3>
      <div {...stylex.props(styles.statusRow)}><span>Response notifications</span><span {...stylex.props(ui.muted)}>{notifications.status === 'enabled' ? 'Enabled' : notifications.status === 'checking' ? 'Checking…' : notifications.status === 'denied' ? 'Blocked' : notifications.status === 'unavailable' ? 'Unavailable' : 'Off'}</span></div>
      <p {...stylex.props(ui.muted)}>{notifications.unavailableReason || (notifications.status === 'denied' ? 'Allow notifications for Aside in your device settings.' : 'Get notified when a response finishes while you are away from the app. Tap a notification to open its conversation.')}</p>
      {notifications.status !== 'unavailable' && notifications.status !== 'denied' && <button type="button" {...stylex.props(ui.button)} disabled={notifications.isUpdating || notifications.status === 'checking' || !chat.isReady || !!chat.authError} onClick={() => { void (notifications.status === 'enabled' ? notifications.disable() : notifications.enable()); }}>{notifications.isUpdating ? 'Updating…' : notifications.status === 'enabled' ? 'Turn off notifications' : 'Enable notifications'}</button>}
    </section>
    <section><h3 {...stylex.props(styles.heading)}>Appearance</h3>
      <div role="radiogroup" aria-label="Theme" {...stylex.props(styles.themeGrid)}>{THEMES.map(option => <button key={option.id} type="button" role="radio" aria-checked={theme === option.id} onClick={() => onThemeChange(option.id)} {...stylex.props(styles.themeOption, theme === option.id && styles.themeOptionOn)}>
        <span aria-hidden="true" {...stylex.props(styles.swatches)}>{option.sw.map(color => <span key={color} style={{ backgroundColor: color }} {...stylex.props(styles.swatch)} />)}</span>{option.label}{theme === option.id && <Check aria-hidden="true" size={16} strokeWidth={ICON_STROKE} {...stylex.props(styles.themeCheck)} />}</button>)}</div>
      <div {...stylex.props(styles.statusRow)}><label htmlFor="text-size">Text size</label><select id="text-size" value={textSize} onChange={event => onTextSizeChange(Number(event.target.value))} {...stylex.props(styles.textSize)}>{TEXT_SIZES.map(size => <option key={size} value={size}>{size}%</option>)}</select></div>
      <div {...stylex.props(styles.statusRow)}><label htmlFor="body-font">Response font</label><select id="body-font" value={font} disabled={!fonts.length} onChange={event => changeFont(event.target.value)} {...stylex.props(styles.textSize)}>{(fonts.length ? fonts : [{ id: font, label: 'Wanted Sans' }]).map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></div>
      <p {...stylex.props(ui.muted, styles.hint)}>For more control, override the CSS variables in ~/.aside-remote/theme.css on the Mac running the bridge. It applies to every device; see "Themes" in the README.</p></section>
  </div>;
}

const styles = stylex.create({
  content: { display: 'flex', flexDirection: 'column', gap: 24 },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  heading: { fontSize: '0.875rem', fontWeight: 600, margin: '0 0 12px' },
  statusRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 44, paddingTop: 6, paddingBottom: 6, borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: tokens.border, fontSize: '0.875rem', overflowWrap: 'anywhere' },
  check: { color: tokens.primary },
  textSize: { minHeight: 44, maxWidth: '100%', borderWidth: 0, padding: '0 8px', borderRadius: 12, backgroundColor: tokens.surface, color: tokens.text },
  actions: { display: 'flex', gap: 8, marginTop: 16 },
  save: { width: '100%', marginTop: 12 },
  themeGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 6 },
  themeOption: { display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, padding: '0 12px', borderRadius: 12, borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, backgroundColor: 'transparent', color: tokens.text, fontSize: '0.875rem', textAlign: 'left' },
  themeOptionOn: { borderColor: tokens.text },
  themeCheck: { marginLeft: 'auto', flexShrink: 0 },
  swatches: { display: 'flex', flexShrink: 0, borderRadius: 6, overflow: 'hidden', borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border },
  swatch: { width: 8, height: 18 },
  hint: { fontSize: '0.8125rem', margin: '10px 0 0' },
});
