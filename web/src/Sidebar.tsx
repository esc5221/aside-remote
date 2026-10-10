import { useEffect, useRef } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Virtuoso } from 'react-virtuoso';
import { Ellipsis, Pin, Plus, Search, Settings2, X, ChevronRight } from 'lucide-react';
import type { UseChat } from './types';
import type { SessionMenuTarget } from './SessionMenu';
import { tokens } from './tokens.stylex';
import { ICON_STROKE, BrowserIcon, IconButton, styles as ui } from './ui';

export function Sidebar({ chat, isDrawer, onClose, onNew, onOpen, onSettings, onBrowser, onMenu }: {
  chat: UseChat; isDrawer?: boolean; onClose?: () => void; onNew: () => void; onOpen: (id: string) => void; onSettings: () => void; onBrowser: () => void; onMenu: (target: SessionMenuTarget) => void;
}) {
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | undefined>(undefined);
  const hasLongPressed = useRef(false);
  useEffect(() => cancelPress, []);
  function cancelPress() { if (press.current) clearTimeout(press.current.timer); press.current = undefined; }
  function targetFor(element: EventTarget) {
    if (!(element instanceof Element)) return;
    const anchor = element.closest<HTMLElement>('button[data-session-id]');
    const session = chat.sessions.find(session => session.id === anchor?.dataset.sessionId);
    return anchor && session ? { id: session.id, title: session.title, anchor } : undefined;
  }
  let lastGroup = '';
  const rows = chat.sessions.flatMap(session => {
    const group = session.isPinned ? 'Pinned' : dateGroup(session.mtime); const hasHeading = group !== lastGroup; lastGroup = group;
    return [...(hasHeading ? [{ kind: 'heading' as const, group }] : []), { kind: 'session' as const, session }];
  });
  return <aside {...stylex.props(styles.sidebar)} aria-label="Conversations" onPointerDown={event => {
    cancelPress(); hasLongPressed.current = false;
    if (event.button !== 0 || !event.isPrimary) return;
    const target = targetFor(event.target); if (!target) return;
    const { clientX: x, clientY: y } = event;
    press.current = { x, y, timer: setTimeout(() => { hasLongPressed.current = true; window.getSelection()?.removeAllRanges(); onMenu({ ...target, point: { x, y } }); cancelPress(); }, 500) };
  }} onPointerMove={event => { if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 8) cancelPress(); }} onPointerUp={cancelPress} onPointerCancel={cancelPress} onPointerLeave={cancelPress} onClickCapture={event => { if (hasLongPressed.current) { event.preventDefault(); event.stopPropagation(); hasLongPressed.current = false; } }} onContextMenu={event => {
    const target = targetFor(event.target); if (!target) return;
    event.preventDefault(); cancelPress(); hasLongPressed.current = true; onMenu({ ...target, point: { x: event.clientX, y: event.clientY } });
  }} onKeyDown={event => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    const target = targetFor(event.target); if (!target) return;
    event.preventDefault(); onMenu(target);
  }}>
    <div {...stylex.props(styles.top)}><span {...stylex.props(styles.brand)}>Aside</span>{isDrawer && <IconButton label="Close conversations" onClick={onClose}><X size={22} strokeWidth={ICON_STROKE} /></IconButton>}</div>
    <button {...stylex.props(styles.newChat)} onClick={onNew}><Plus size={20} strokeWidth={ICON_STROKE} />New chat</button>
    <div {...stylex.props(styles.search)}><Search size={17} strokeWidth={ICON_STROKE} /><input aria-label="Search conversations" placeholder="Search" value={chat.searchQuery} onChange={event => chat.setSearchQuery(event.target.value)} {...stylex.props(styles.searchInput)} />{chat.searchQuery && <button {...stylex.props(styles.clear)} aria-label="Clear search" onClick={() => chat.setSearchQuery('')}><X size={16} /></button>}</div>
    <div {...stylex.props(styles.list)}>
      {rows.length > 0 && <Virtuoso data={rows} initialItemCount={12} defaultItemHeight={50} increaseViewportBy={150} style={{ height: '100%' }} computeItemKey={(_, row) => row.kind === 'heading' ? row.group : row.session.id} components={sessionListComponents} context={chat} itemContent={(_, row) => {
        if (row.kind === 'heading') return <h2 {...stylex.props(styles.group)}>{row.group}</h2>;
        const session = row.session;
        return <div {...stylex.props(styles.session, session.id === chat.sessionId && styles.selected)}>
          <button data-session-id={session.id} {...stylex.props(styles.sessionButton)} title={session.title || 'Untitled conversation'} aria-current={session.id === chat.sessionId ? 'page' : undefined} onClick={() => onOpen(session.id)}><span {...stylex.props(styles.sessionTitle)}>{session.title || 'Untitled conversation'}</span>{session.isPinned && <Pin {...stylex.props(styles.pin)} size={13} strokeWidth={ICON_STROKE} aria-label="Pinned" />}{(session.status === 'running' || session.unread && session.id !== chat.sessionId) && <span {...stylex.props(styles.indicator)} role="img" aria-label={session.status === 'running' ? 'Running' : 'Unread'} />}</button>
          <button type="button" {...stylex.props(styles.options)} aria-label={'Options for ' + (session.title || 'conversation')} aria-haspopup="menu" onClick={event => onMenu({ id: session.id, title: session.title, anchor: event.currentTarget })}><Ellipsis size={17} strokeWidth={ICON_STROKE} aria-hidden="true" /></button>
        </div>;
      }} />}
      {!chat.sessions.length && <p role="status" {...stylex.props(styles.empty)}>{chat.isLoadingSessions ? 'Loading conversations…' : chat.authError ? 'Connect in Settings to see your conversations.' : chat.searchQuery ? 'No matching conversations' : 'Your conversations will appear here.'}</p>}
    </div>
    <div {...stylex.props(styles.bottom)}><button {...stylex.props(styles.nav)} onClick={onBrowser}><BrowserIcon size={19} />Browser</button><button {...stylex.props(styles.nav)} onClick={onSettings}><Settings2 size={19} strokeWidth={ICON_STROKE} />Settings<span {...stylex.props(styles.connection, chat.isConnected && styles.connected)} role="img" aria-label={chat.isConnected ? 'Connected' : 'Disconnected'} /></button></div>
  </aside>;
}

function SessionListFooter({ context: chat }: { context?: UseChat }) {
  return chat?.hasMore ? <button {...stylex.props(ui.button, styles.more)} onClick={() => void chat.loadMore()} disabled={chat.isLoadingMore}>{chat.isLoadingMore ? 'Loading…' : 'Show more'}<ChevronRight size={16} /></button> : undefined;
}
const sessionListComponents = { Footer: SessionListFooter };

function dateGroup(seconds: number) {
  const date = new Date(seconds * 1000); const today = new Date(); today.setHours(0, 0, 0, 0);
  const difference = today.getTime() - date.getTime();
  if (difference < 0) return 'Today'; if (difference < 86_400_000) return 'Yesterday'; if (difference < 6 * 86_400_000) return 'Previous 7 days';
  return date.toLocaleDateString('en-US', { month: 'long', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

const styles = stylex.create({
  sidebar: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, width: '100%', backgroundColor: tokens.surface, paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)', minWidth: 0 },
  top: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 68, padding: '8px 16px 8px 24px', flexShrink: 0 },
  brand: { fontSize: '1.3125rem', fontWeight: 650, letterSpacing: '-.5px' },
  newChat: { display: 'flex', alignItems: 'center', gap: 12, minHeight: 48, flexShrink: 0, margin: '0 14px 12px', padding: '0 14px', borderWidth: 0, borderRadius: 14, backgroundColor: { default: tokens.canvas, ':hover': tokens.hover }, color: tokens.text, fontSize: '0.875rem', fontWeight: 550 },
  search: { display: 'flex', alignItems: 'center', gap: 9, margin: '0 22px 10px', padding: '0 2px', color: tokens.muted, minHeight: 44, flexShrink: 0 },
  searchInput: { borderWidth: 0, backgroundColor: 'transparent', color: tokens.text, width: '100%', minWidth: 0, fontSize: '1rem', padding: '10px 0' },
  clear: { display: 'flex', alignItems: 'center', justifyContent: 'center', borderWidth: 0, color: tokens.muted, backgroundColor: 'transparent', minWidth: 32, minHeight: 44 },
  list: { flex: 1, overflow: 'hidden', minHeight: 0, padding: '0 14px 16px', overscrollBehavior: 'contain' },
  group: { minHeight: 50, margin: 0, padding: '20px 12px 7px', fontSize: '0.75rem', color: tokens.muted, fontWeight: 500 },
  session: { display: 'flex', alignItems: 'center', minWidth: 0, borderRadius: 12, marginBottom: 2, backgroundColor: { default: 'transparent', ':hover': tokens.hover } },
  selected: { backgroundColor: tokens.hover },
  sessionButton: { display: 'flex', alignItems: 'center', gap: 6, textAlign: 'left', flex: 1, minWidth: 0, minHeight: 48, padding: '10px 4px 10px 12px', borderWidth: 0, backgroundColor: 'transparent', color: tokens.text, fontSize: '0.875rem' },
  sessionTitle: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  options: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 44, flexShrink: 0, borderWidth: 0, backgroundColor: 'transparent', color: tokens.muted },
  pin: { color: tokens.primary, flexShrink: 0 },
  indicator: { width: 6, height: 6, borderRadius: '50%', backgroundColor: tokens.primary, flexShrink: 0 },
  bottom: { borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: tokens.border, padding: '10px 14px', flexShrink: 0 },
  nav: { display: 'flex', alignItems: 'center', gap: 12, minHeight: 48, width: '100%', borderWidth: 0, backgroundColor: { default: 'transparent', ':hover': tokens.hover }, color: tokens.text, padding: '0 12px', borderRadius: 12, fontSize: '0.875rem', textAlign: 'left' },
  connection: { width: 6, height: 6, borderRadius: '50%', backgroundColor: 'var(--status-off)', marginLeft: 'auto' },
  connected: { backgroundColor: 'var(--status-ok)' },
  empty: { fontSize: '0.875rem', lineHeight: 1.6, color: tokens.muted, padding: 12 },
  more: { marginTop: 12, width: '100%', backgroundColor: 'transparent' },
});
