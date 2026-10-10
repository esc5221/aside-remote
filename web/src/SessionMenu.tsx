import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Copy, Link, Share2 } from 'lucide-react';
import { tokens } from './tokens.stylex';
import { CloseButton, ICON_STROKE, SESSION_MENU_TITLE, styles as ui } from './ui';

export function SessionMenu({ sessionId, title, onClose, notify }: {
  sessionId: string; title: string; onClose: () => void; notify: (text: string, kind?: 'error' | 'success') => void;
}) {
  const [isBusy, setBusy] = useState(false);
  const url = new URL('/c/' + encodeURIComponent(sessionId), location.origin).href;
  const shareText = title + '\nSession ID: ' + sessionId;

  async function copy(text: string, message: string) {
    setBusy(true);
    try { await navigator.clipboard.writeText(text); onClose(); notify(message, 'success'); }
    catch { notify('Could not copy. Select the session details to copy them.', 'error'); }
    finally { setBusy(false); }
  }

  async function share() {
    if (!navigator.share) { await copy(shareText + '\n' + url, 'Session details copied.'); return; }
    setBusy(true);
    try { await navigator.share({ title, text: shareText, url }); onClose(); }
    catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) notify('Could not share. Try copying the link.', 'error'); }
    finally { setBusy(false); }
  }

  return <div {...stylex.props(styles.content)}>
    <div {...stylex.props(styles.header)}><h2 {...stylex.props(ui.title)}>{SESSION_MENU_TITLE}</h2><CloseButton onClick={onClose} /></div>
    <p {...stylex.props(styles.sessionTitle)}>{title}</p>
    <dl {...stylex.props(styles.details)}><dt {...stylex.props(styles.label)}>Session ID</dt><dd {...stylex.props(styles.value)}>{sessionId}</dd><dt {...stylex.props(styles.label)}>Link</dt><dd {...stylex.props(styles.value)}>{url}</dd></dl>
    <div {...stylex.props(styles.actions)}>
      <button type="button" {...stylex.props(styles.action)} disabled={isBusy} onClick={() => void share()}><Share2 aria-hidden="true" size={21} strokeWidth={ICON_STROKE} /><span>Share session</span></button>
      <button type="button" {...stylex.props(styles.action)} disabled={isBusy} onClick={() => void copy(url, 'Session link copied.')}><Link aria-hidden="true" size={21} strokeWidth={ICON_STROKE} /><span>Copy link</span></button>
      <button type="button" {...stylex.props(styles.action)} disabled={isBusy} onClick={() => void copy(sessionId, 'Session ID copied.')}><Copy aria-hidden="true" size={21} strokeWidth={ICON_STROKE} /><span>Copy session ID</span></button>
    </div>
  </div>;
}

const styles = stylex.create({
  content: { display: 'flex', flexDirection: 'column', minWidth: 0, gap: 16 },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  sessionTitle: { margin: 0, fontSize: '1rem', lineHeight: 1.5, fontWeight: 550, overflowWrap: 'anywhere' },
  details: { margin: 0, display: 'flex', flexDirection: 'column', gap: 6, padding: 16, borderRadius: 16, backgroundColor: tokens.surface, minWidth: 0 },
  label: { fontSize: '0.75rem', lineHeight: 1.5, color: tokens.muted },
  value: { margin: '0 0 8px', fontSize: '0.875rem', lineHeight: 1.5, overflowWrap: 'anywhere', userSelect: 'text', ':last-child': { marginBottom: 0 } },
  actions: { display: 'flex', flexDirection: 'column', gap: 2 },
  action: { display: 'flex', alignItems: 'center', gap: 14, minHeight: 52, padding: '12px 14px', borderWidth: 0, borderRadius: 14, textAlign: 'left', color: tokens.text, backgroundColor: { default: 'transparent', ':hover': tokens.hover }, fontSize: '1rem', lineHeight: 1.5 },
});
