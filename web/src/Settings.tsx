import { useEffect, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Check, RefreshCw } from 'lucide-react';
import type { UseChat } from './types';
import { ICON_STROKE, CloseButton, styles as ui } from './ui';
import { tokens } from './tokens.stylex';

type Health = { asideApp: boolean; daemon?: { ready?: boolean; error?: string }; mcp: { alive: boolean } };

export function Settings({ chat, onClose, notify, isDarkMode, onThemeToggle }: { chat: UseChat; onClose: () => void; notify: (text: string, kind?: 'error' | 'success') => void; isDarkMode: boolean; onThemeToggle: () => void }) {
  const [token, setToken] = useState(''); const [isSaving, setSaving] = useState(false); const [health, setHealth] = useState<Health>(); const [error, setError] = useState('');
  async function refresh() { try { const response = await chat.request('/api/health'); setHealth(await response.json()); setError(''); } catch { setError('Could not check the connection.'); } }
  useEffect(() => { void refresh(); }, []);
  return <div {...stylex.props(styles.content)}><div {...stylex.props(styles.header)}><h2 {...stylex.props(ui.title)}>Settings</h2><CloseButton onClick={onClose} /></div>
    <section><h3 {...stylex.props(styles.heading)}>Connection</h3><div {...stylex.props(styles.statusRow)}><span>Bridge</span><span {...stylex.props(ui.muted)}>{chat.isConnected ? 'Connected' : 'Reconnecting…'}</span></div>
      <div {...stylex.props(styles.statusRow)}><span>Aside</span><span {...stylex.props(ui.muted)}>{health ? health.asideApp ? 'Running' : 'Not running' : 'Checking…'}</span></div>
      <div {...stylex.props(styles.statusRow)}><span>Browser</span><span {...stylex.props(ui.muted)}>{health ? health.mcp.alive ? 'Connected' : 'Not connected' : 'Checking…'}</span></div>
      {error && <p role="alert" {...stylex.props(ui.muted)}>{error}</p>}
      <div {...stylex.props(styles.actions)}><button {...stylex.props(ui.button)} onClick={() => void refresh()}><RefreshCw size={16} />Refresh</button>{health && !health.asideApp && <button {...stylex.props(ui.button)} onClick={async () => { try { await chat.request('/api/aside/launch', { method: 'POST' }); await refresh(); notify('Aside opened.', 'success'); } catch { notify('Could not open Aside.', 'error'); } }}>Open Aside</button>}</div>
    </section>
    <section><h3 {...stylex.props(styles.heading)}>Access token</h3><p {...stylex.props(ui.muted)}>Only needed when your connection does not sign you in automatically.</p>
      <form onSubmit={async event => { event.preventDefault(); setSaving(true); try { if (await chat.saveToken(token)) setToken(''); } finally { setSaving(false); } }}><input {...stylex.props(ui.field)} type="password" value={token} autoComplete="off" aria-label="Access token" placeholder="Paste your access token" onChange={event => setToken(event.target.value)} /><button {...stylex.props(ui.button, ui.primary, styles.save)} disabled={isSaving || !token.trim()}>{isSaving ? 'Connecting…' : 'Connect'}</button></form>
    </section>
    <section><h3 {...stylex.props(styles.heading)}>Appearance</h3><div {...stylex.props(styles.statusRow)}><span>Dark mode</span><button type="button" role="switch" aria-label="Dark mode" aria-checked={isDarkMode} onClick={onThemeToggle} {...stylex.props(styles.themeSwitch)}><span {...stylex.props(styles.switchTrack, isDarkMode && styles.switchOn)}><span {...stylex.props(styles.switchThumb, isDarkMode && styles.thumbOn)} /></span></button></div><div {...stylex.props(styles.statusRow)}><span>Wanted Sans</span><Check size={18} strokeWidth={ICON_STROKE} /></div></section>
  </div>;
}

const styles = stylex.create({
  content: { display: 'flex', flexDirection: 'column', gap: 24 },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  heading: { fontSize: 14, fontWeight: 600, margin: '0 0 12px' },
  statusRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 44, borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: tokens.border, fontSize: 14 },
  actions: { display: 'flex', gap: 8, marginTop: 16 },
  save: { width: '100%', marginTop: 12 },
  themeSwitch: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 52, height: 44, borderWidth: 0, padding: 0, backgroundColor: 'transparent' },
  switchTrack: { display: 'flex', alignItems: 'center', width: 48, height: 28, padding: 4, borderRadius: 20, backgroundColor: tokens.hover },
  switchOn: { backgroundColor: tokens.text },
  switchThumb: { width: 20, height: 20, borderRadius: '50%', backgroundColor: tokens.canvas, boxShadow: '0 1px 3px rgb(0 0 0 / .2)' },
  thumbOn: { marginLeft: 20 },
});
