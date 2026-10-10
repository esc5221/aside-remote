import { useCallback, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Check } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import type { UseChat } from './types';
import { ICON_STROKE, CloseButton, styles as ui } from './ui';
import { tokens } from './tokens.stylex';
import { formatRequestError } from './errors';
import { TEXT_SIZES } from './theme';
import { useAutoRefresh } from './useAutoRefresh';
import type { PushNotifications } from './notifications';
import { parseHealth } from './responses';

type Health = ReturnType<typeof parseHealth>;

export function Settings({ chat, onClose, notify, notifications, isDarkMode, onThemeToggle, textSize, onTextSizeChange }: { chat: UseChat; onClose: () => void; notify: (text: string, kind?: 'error' | 'success') => void; notifications: PushNotifications; isDarkMode: boolean; onThemeToggle: () => void; textSize: number; onTextSizeChange: (size: number) => void }) {
  const shouldReduceMotion = useReducedMotion();
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
    <section><h3 {...stylex.props(styles.heading)}>Appearance</h3><div {...stylex.props(styles.statusRow)}><span>Dark mode</span><motion.button type="button" role="switch" aria-label="Dark mode" aria-checked={isDarkMode} whileTap={shouldReduceMotion ? undefined : { scale: .94 }} onClick={onThemeToggle} {...stylex.props(styles.themeSwitch)}><motion.span animate={{ backgroundColor: isDarkMode ? 'var(--text)' : 'var(--hover)' }} transition={{ duration: shouldReduceMotion ? 0 : .18 }} {...stylex.props(styles.switchTrack)}><motion.span animate={{ x: isDarkMode ? 20 : 0 }} transition={shouldReduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 520, damping: 34 }} {...stylex.props(styles.switchThumb)} /></motion.span></motion.button></div>
      <div {...stylex.props(styles.statusRow)}><label htmlFor="text-size">Text size</label><select id="text-size" value={textSize} onChange={event => onTextSizeChange(Number(event.target.value))} {...stylex.props(styles.textSize)}>{TEXT_SIZES.map(size => <option key={size} value={size}>{size}%</option>)}</select></div>
      <div {...stylex.props(styles.statusRow)}><span>Wanted Sans</span><span className="sr-only">Selected font</span><Check aria-hidden="true" size={18} strokeWidth={ICON_STROKE} /></div></section>
  </div>;
}

const styles = stylex.create({
  content: { display: 'flex', flexDirection: 'column', gap: 24 },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  heading: { fontSize: '0.875rem', fontWeight: 600, margin: '0 0 12px' },
  statusRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 44, paddingTop: 6, paddingBottom: 6, borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: tokens.border, fontSize: '0.875rem', overflowWrap: 'anywhere' },
  textSize: { minHeight: 44, maxWidth: '100%', borderWidth: 0, padding: '0 8px', borderRadius: 12, backgroundColor: tokens.surface, color: tokens.text },
  actions: { display: 'flex', gap: 8, marginTop: 16 },
  save: { width: '100%', marginTop: 12 },
  themeSwitch: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 52, height: 44, borderWidth: 0, padding: 0, backgroundColor: 'transparent' },
  switchTrack: { display: 'flex', alignItems: 'center', width: 48, height: 28, padding: 4, borderRadius: 20, backgroundColor: tokens.hover },
  switchThumb: { width: 20, height: 20, borderRadius: '50%', backgroundColor: tokens.canvas, boxShadow: '0 1px 3px rgb(0 0 0 / .2)' },
});
