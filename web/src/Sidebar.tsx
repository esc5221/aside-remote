import * as stylex from '@stylexjs/stylex';
import { Plus, Search, Settings2, Trash2, X, ChevronRight } from 'lucide-react';
import type { UseChat, ChatSession } from './types';
import { tokens } from './tokens.stylex';
import { ICON_STROKE, BrowserIcon, IconButton, styles as ui } from './ui';

export function Sidebar({ chat, isDrawer, onClose, onNew, onOpen, onSettings, onBrowser, onDelete }: {
  chat: UseChat; isDrawer?: boolean; onClose?: () => void; onNew: () => void; onOpen: (id: string) => void; onSettings: () => void; onBrowser: () => void; onDelete: (session: ChatSession) => void;
}) {
  let lastGroup = '';
  return <aside {...stylex.props(styles.sidebar)} aria-label="Conversations">
    <div {...stylex.props(styles.top)}><span {...stylex.props(styles.brand)}>Aside</span>{isDrawer && <IconButton label="Close conversations" onClick={onClose}><X size={22} strokeWidth={ICON_STROKE} /></IconButton>}</div>
    <button {...stylex.props(styles.newChat)} onClick={onNew}><Plus size={20} strokeWidth={ICON_STROKE} />New chat</button>
    <div {...stylex.props(styles.search)}><Search size={17} strokeWidth={ICON_STROKE} /><input aria-label="Search conversations" placeholder="Search" value={chat.searchQuery} onChange={event => chat.setSearchQuery(event.target.value)} {...stylex.props(styles.searchInput)} />{chat.searchQuery && <button {...stylex.props(styles.clear)} aria-label="Clear search" onClick={() => chat.setSearchQuery('')}><X size={16} /></button>}</div>
    <div {...stylex.props(styles.list)}>
      {chat.sessions.map(session => { const group = dateGroup(session.mtime); const heading = group !== lastGroup; lastGroup = group;
        return <div key={session.id}>{heading && <h2 {...stylex.props(styles.group)}>{group}</h2>}<div {...stylex.props(styles.session, session.id === chat.sessionId && styles.selected)}>
          <button {...stylex.props(styles.sessionButton)} title={session.title || 'Untitled conversation'} aria-current={session.id === chat.sessionId ? 'page' : undefined} onClick={() => onOpen(session.id)}><span {...stylex.props(styles.sessionTitle)}>{session.title || 'Untitled conversation'}</span>{session.status === 'running' && <span {...stylex.props(styles.running)} role="img" aria-label="Running" />}</button>
          <button {...stylex.props(styles.delete)} aria-label={'Delete ' + (session.title || 'conversation')} disabled={session.status === 'running' || (session.id === chat.sessionId && chat.isRunning)} onClick={() => onDelete(session)}><Trash2 size={15} strokeWidth={ICON_STROKE} /></button>
        </div></div>;
      })}
      {!chat.sessions.length && <p role="status" {...stylex.props(styles.empty)}>{chat.isLoadingSessions ? 'Loading conversations…' : chat.authError ? 'Connect in Settings to see your conversations.' : chat.searchQuery ? 'No matching conversations' : 'Your conversations will appear here.'}</p>}
      {chat.hasMore && <button {...stylex.props(ui.button, styles.more)} onClick={() => void chat.loadMore()} disabled={chat.isLoadingMore}>{chat.isLoadingMore ? 'Loading…' : 'Show more'}<ChevronRight size={16} /></button>}
    </div>
    <div {...stylex.props(styles.bottom)}><button {...stylex.props(styles.nav)} onClick={onBrowser}><BrowserIcon size={19} />Browser</button><button {...stylex.props(styles.nav)} onClick={onSettings}><Settings2 size={19} strokeWidth={ICON_STROKE} />Settings<span {...stylex.props(styles.connection, chat.isConnected && styles.connected)} role="img" aria-label={chat.isConnected ? 'Connected' : 'Disconnected'} /></button></div>
  </aside>;
}

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
  list: { flex: 1, overflowY: 'auto', minHeight: 0, padding: '0 14px 16px', overscrollBehavior: 'contain' },
  group: { margin: '20px 12px 7px', fontSize: '0.75rem', color: tokens.muted, fontWeight: 500 },
  session: { display: 'flex', alignItems: 'center', minWidth: 0, borderRadius: 12, marginBottom: 2, backgroundColor: { default: 'transparent', ':hover': tokens.hover } },
  selected: { backgroundColor: tokens.hover },
  sessionButton: { display: 'flex', alignItems: 'center', gap: 6, textAlign: 'left', flex: 1, minWidth: 0, minHeight: 48, padding: '10px 4px 10px 12px', borderWidth: 0, backgroundColor: 'transparent', color: tokens.text, fontSize: '0.875rem' },
  sessionTitle: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  delete: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 44, flexShrink: 0, borderWidth: 0, backgroundColor: 'transparent', color: { default: tokens.muted, ':hover': tokens.danger } },
  running: { width: 6, height: 6, borderRadius: '50%', backgroundColor: tokens.text, flexShrink: 0 },
  bottom: { borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: tokens.border, padding: '10px 14px', flexShrink: 0 },
  nav: { display: 'flex', alignItems: 'center', gap: 12, minHeight: 48, width: '100%', borderWidth: 0, backgroundColor: { default: 'transparent', ':hover': tokens.hover }, color: tokens.text, padding: '0 12px', borderRadius: 12, fontSize: '0.875rem', textAlign: 'left' },
  connection: { width: 6, height: 6, borderRadius: '50%', backgroundColor: '#b0b0b0', marginLeft: 'auto' },
  connected: { backgroundColor: '#2f7b49' },
  empty: { fontSize: '0.875rem', lineHeight: 1.6, color: tokens.muted, padding: 12 },
  more: { marginTop: 12, width: '100%', backgroundColor: 'transparent' },
});
