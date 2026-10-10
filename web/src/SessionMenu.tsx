import { useEffect, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Copy, Link, Pencil, Pin, PinOff, Share2, Trash2 } from 'lucide-react';
import type { UseChat } from './types';
import { parseSessionDetails } from './responses';
import { PopoverMenu } from './PopoverMenu';
import { tokens } from './tokens.stylex';
import { CloseButton, ICON_STROKE, styles as ui } from './ui';

export type SessionMenuTarget = { id: string; title: string; anchor: HTMLElement; point?: { x: number; y: number } };
type Conversation = { id: string; title: string };

export function SessionMenu({ target, chat, onClose, onRename, onDelete, notify }: {
  target: SessionMenuTarget; chat: UseChat; onClose: () => void; onRename: (session: Conversation) => void; onDelete: (session: Conversation) => void;
  notify: (text: string, kind?: 'error' | 'success') => void;
}) {
  const [details, setDetails] = useState<ReturnType<typeof parseSessionDetails>>();
  const [error, setError] = useState(false);
  const [isActing, setActing] = useState(false);
  const url = new URL('/c/' + encodeURIComponent(target.id), location.origin).href;
  const title = details?.title ?? target.title;
  const shareText = title + '\nSession ID: ' + target.id;
  const isBusy = !details || isActing;
  useEffect(() => {
    const controller = new AbortController();
    void chat.request('/api/sessions/' + encodeURIComponent(target.id) + '/details', { signal: controller.signal })
      .then(response => response.json()).then(value => { if (!controller.signal.aborted) setDetails(parseSessionDetails(value)); })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [target.id, chat.request]);

  async function copy(text: string, message: string) {
    setActing(true);
    try { await navigator.clipboard.writeText(text); onClose(); notify(message, 'success'); }
    catch { notify('Could not copy. Try again.', 'error'); }
    finally { setActing(false); }
  }
  async function share() {
    if (!navigator.share) { await copy(shareText + '\n' + url, 'Session details copied.'); return; }
    setActing(true);
    try { await navigator.share({ title, text: shareText, url }); onClose(); }
    catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) notify('Could not share. Try copying the link.', 'error'); }
    finally { setActing(false); }
  }
  async function togglePin() {
    if (!details) return;
    setActing(true);
    try { if (await chat.updateSession(target.id, { isPinned: !details.isPinned })) onClose(); }
    finally { setActing(false); }
  }

  return <PopoverMenu anchor={target.anchor} point={target.point} label="Conversation options" onClose={onClose}>
    <p {...stylex.props(styles.title)}>{title}</p>
    {error && <p role="alert" {...stylex.props(ui.muted)}>Could not load conversation options.</p>}
    <button type="button" role="menuitem" {...stylex.props(styles.action)} disabled={isBusy} onClick={() => void togglePin()}>{details?.isPinned ? <PinOff size={20} strokeWidth={ICON_STROKE} aria-hidden="true" /> : <Pin size={20} strokeWidth={ICON_STROKE} aria-hidden="true" />}<span>{details?.isPinned ? 'Unpin conversation' : 'Pin conversation'}</span></button>
    <button type="button" role="menuitem" {...stylex.props(styles.action)} disabled={isBusy} onClick={() => { onClose(); onRename({ id: target.id, title }); }}><Pencil size={20} strokeWidth={ICON_STROKE} aria-hidden="true" /><span>Rename</span></button>
    <button type="button" role="menuitem" {...stylex.props(styles.action)} disabled={isBusy} onClick={() => void share()}><Share2 size={20} strokeWidth={ICON_STROKE} aria-hidden="true" /><span>Share session</span></button>
    <button type="button" role="menuitem" {...stylex.props(styles.action)} disabled={isBusy} onClick={() => void copy(url, 'Session link copied.')}><Link size={20} strokeWidth={ICON_STROKE} aria-hidden="true" /><span>Copy link</span></button>
    <button type="button" role="menuitem" {...stylex.props(styles.action)} disabled={isBusy} onClick={() => void copy(target.id, 'Session ID copied.')}><Copy size={20} strokeWidth={ICON_STROKE} aria-hidden="true" /><span>Copy session ID</span></button>
    <button type="button" role="menuitem" {...stylex.props(styles.action, ui.danger)} disabled={isBusy || details?.status === 'running' || (target.id === chat.sessionId && chat.isRunning)} onClick={() => { onClose(); onDelete({ id: target.id, title }); }}><Trash2 size={20} strokeWidth={ICON_STROKE} aria-hidden="true" /><span>Delete conversation</span></button>
  </PopoverMenu>;
}

export function RenameConversation({ session, chat, onClose }: { session: Conversation; chat: UseChat; onClose: () => void }) {
  const [title, setTitle] = useState(session.title);
  const [isSaving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const isMounted = useRef(true);
  useEffect(() => { isMounted.current = true; input.current?.focus({ preventScroll: true }); return () => { isMounted.current = false; }; }, []);
  return <form onSubmit={event => {
    event.preventDefault(); if (!title.trim() || isSaving) return;
    setSaving(true); void chat.updateSession(session.id, { title: title.trim() }).then(accepted => { if (accepted && isMounted.current) onClose(); }).finally(() => { if (isMounted.current) setSaving(false); });
  }}>
    <div {...stylex.props(styles.header)}><h2 {...stylex.props(ui.title)}>Rename conversation</h2><CloseButton onClick={() => { if (!isSaving) onClose(); }} /></div>
    <input ref={input} autoFocus aria-label="Conversation name" maxLength={120} value={title} disabled={isSaving} {...stylex.props(ui.field)} onChange={event => setTitle(event.target.value)} />
    <div {...stylex.props(styles.formActions)}><button type="button" {...stylex.props(ui.button)} disabled={isSaving} onClick={onClose}>Cancel</button><button type="submit" {...stylex.props(ui.button, ui.primary)} disabled={isSaving || !title.trim()}>{isSaving ? 'Saving…' : 'Save'}</button></div>
  </form>;
}

const styles = stylex.create({
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16 },
  title: { margin: '4px 12px 8px', fontSize: '0.8125rem', lineHeight: 1.4, color: tokens.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  action: { display: 'flex', alignItems: 'center', gap: 12, minHeight: 44, width: '100%', padding: '10px 12px', borderWidth: 0, borderRadius: 14, textAlign: 'left', color: tokens.text, backgroundColor: { default: 'transparent', ':hover': tokens.hover }, fontSize: '0.875rem', lineHeight: 1.4 },
  formActions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 },
});
