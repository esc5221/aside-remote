import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { ArrowDown, Check, CircleAlert, SquarePen, X } from 'lucide-react';
import { useChat } from './chat';
import type { ChatSession, Toast } from './types';
import { tokens } from './tokens.stylex';
import { Sidebar } from './Sidebar';
import { Composer } from './Composer';
import { Settings } from './Settings';
import { applyTheme, THEME_STORAGE_KEY, type Theme } from './theme';
import { ICON_STROKE, BrowserIcon, CloseButton, Dialog, IconButton, styles as ui } from './ui';

const BrowserPanel = lazy(() => import('./BrowserPanel').then(module => ({ default: module.BrowserPanel })));
const Messages = lazy(() => import('./Messages').then(module => ({ default: module.Messages })));

export function App() {
  const chat = useChat();
  const [theme, setTheme] = useState<Theme>(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  const [isDrawer, setDrawer] = useState(false);
  const [panel, setPanel] = useState<'settings' | 'browser' | undefined>(() => location.pathname === '/settings' ? 'settings' : location.pathname === '/tabs' ? 'browser' : undefined);
  const [deleteTarget, setDeleteTarget] = useState<ChatSession>(); const [isDeleting, setDeleting] = useState(false);
  const [zoom, setZoom] = useState<string>();
  const [draft, setDraft] = useState(''); const [revision, setRevision] = useState(0);
  const [localToasts, setLocalToasts] = useState<Toast[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null); const contentRef = useRef<HTMLDivElement>(null);
  const shouldFollowRef = useRef(true); const [canJump, setCanJump] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const toasts = [...chat.toasts, ...localToasts].slice(-3);

  function notify(message: string, kind: 'success' | 'error' = 'success') {
    const id = crypto.randomUUID(); setLocalToasts(current => [...current, { id, message, tone: kind }]);
    setTimeout(() => setLocalToasts(current => current.filter(toast => toast.id !== id)), 4500);
  }
  function toggleTheme() {
    const next = theme === 'light' ? 'dark' : 'light';
    applyTheme(next); setTheme(next);
    try { localStorage.setItem(THEME_STORAGE_KEY, next); }
    catch { notify('Theme changed, but your browser could not save the preference.', 'error'); }
  }
  function newChat() { chat.newChat(); setDraft(''); setRevision(value => value + 1); setDrawer(false); shouldFollowRef.current = true; setCanJump(false); }
  function openSession(id: string) { void chat.openSession(id); setDraft(''); setRevision(value => value + 1); setDrawer(false); shouldFollowRef.current = true; }
  function openPanel(next: 'settings' | 'browser') { setPanel(next); setDrawer(false); history.pushState({ panel: next }, '', next === 'settings' ? '/settings' : '/tabs'); }
  function closePanel() { setPanel(undefined); history.replaceState({}, '', chat.sessionId ? '/c/' + encodeURIComponent(chat.sessionId) : '/'); }

  useEffect(() => { if (chat.recoveredDraft !== undefined) { setDraft(current => current ? current + '\n\n' + chat.recoveredDraft : chat.recoveredDraft || ''); chat.clearRecoveredDraft(); } }, [chat.recoveredDraft, chat.clearRecoveredDraft]);
  useEffect(() => {
    const onPop = () => { setPanel(location.pathname === '/settings' ? 'settings' : location.pathname === '/tabs' ? 'browser' : undefined); setDrawer(false); setDraft(''); setRevision(value => value + 1); shouldFollowRef.current = true; };
    window.addEventListener('popstate', onPop); return () => window.removeEventListener('popstate', onPop);
  }, []);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const resize = () => { const root = viewportRef.current; if (root) { root.style.height = viewport.height + 'px'; root.style.top = viewport.offsetTop + 'px'; } };
    resize(); viewport.addEventListener('resize', resize); viewport.addEventListener('scroll', resize);
    return () => { viewport.removeEventListener('resize', resize); viewport.removeEventListener('scroll', resize); };
  }, []);
  useEffect(() => {
    const content = contentRef.current; if (!content) return;
    const observer = new ResizeObserver(() => {
      const box = scrollRef.current; if (!box) return;
      if (shouldFollowRef.current) box.scrollTop = box.scrollHeight;
      setCanJump(box.scrollHeight - box.scrollTop - box.clientHeight > 80);
    });
    observer.observe(content); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    shouldFollowRef.current = true;
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [chat.sessionId]);
  useEffect(() => {
    if (chat.pendingPrompt !== undefined) {
      shouldFollowRef.current = true;
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [chat.pendingPrompt]);

  return <div ref={viewportRef} {...stylex.props(styles.app)}>
    <div {...stylex.props(styles.desktopSidebar)}><Sidebar chat={chat} onNew={newChat} onOpen={openSession} onSettings={() => openPanel('settings')} onBrowser={() => openPanel('browser')} onDelete={setDeleteTarget} /></div>
    <main {...stylex.props(styles.main)}>
      <header id="header" {...stylex.props(styles.header)}><div {...stylex.props(styles.headerLeft)}><span {...stylex.props(styles.mobileMenu)}><IconButton label="Open conversations" onClick={() => setDrawer(true)}><svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE} strokeLinecap="round" aria-hidden="true"><path d="M4 8h16M4 16h10" /></svg></IconButton></span><span {...stylex.props(styles.title)}>Aside</span></div><div {...stylex.props(styles.headerActions)}><IconButton label="Open browser" onClick={() => openPanel('browser')}><BrowserIcon /></IconButton><IconButton label="New chat" onClick={newChat}><SquarePen size={22} strokeWidth={ICON_STROKE} /></IconButton></div></header>
      {chat.authError && <div role="alert" {...stylex.props(styles.notice)}><span>Connect to load your conversations.</span><button {...stylex.props(styles.noticeAction)} onClick={() => openPanel('settings')}>Settings</button></div>}
      {chat.isReady && !chat.isConnected && !chat.authError && <div role="status" {...stylex.props(styles.connectionNotice)}>Reconnecting… You can still send a message.</div>}
      <div {...stylex.props(styles.scrollRegion)}><div id="chatScroll" ref={scrollRef} {...stylex.props(styles.scroll)} onScroll={event => { const box = event.currentTarget; const isNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80; shouldFollowRef.current = isNearBottom; setCanJump(!isNearBottom); }}><div ref={contentRef} {...stylex.props(styles.content)}>
        {chat.isOpening || !chat.isReady ? <div role="status" {...stylex.props(styles.loading)}>Loading conversation…</div> : chat.messages.length || chat.pendingPrompt !== undefined || chat.isRunning ? <Suspense fallback={<div role="status" {...stylex.props(styles.loading)}>Loading conversation…</div>}><Messages messages={chat.messages} pendingPrompt={chat.pendingPrompt} pendingImages={chat.pendingAttachments.map(attachment => attachment.url)} isRunning={chat.isRunning} notify={notify} onZoom={setZoom} /></Suspense> : <div {...stylex.props(styles.empty)}><h1 {...stylex.props(styles.emptyTitle)}>What’s on your mind?</h1></div>}
      </div></div>{canJump && <button aria-label="Scroll to latest message" {...stylex.props(styles.jump)} onClick={() => { shouldFollowRef.current = true; scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); }}><ArrowDown size={19} strokeWidth={ICON_STROKE} /></button>}</div>
      <Composer chat={chat} onBrowser={() => openPanel('browser')} draft={draft} setDraft={setDraft} revision={revision} notify={notify} />
    </main>
    {isDrawer && <Drawer onClose={() => setDrawer(false)}><Sidebar chat={chat} isDrawer onClose={() => setDrawer(false)} onNew={newChat} onOpen={openSession} onSettings={() => openPanel('settings')} onBrowser={() => openPanel('browser')} onDelete={session => { setDrawer(false); setDeleteTarget(session); }} /></Drawer>}
    {panel && <Dialog title={panel === 'browser' ? 'Browser' : 'Settings'} isWide={panel === 'browser'} onClose={closePanel}>{panel === 'settings' ? <Settings chat={chat} notify={notify} onClose={closePanel} isDarkMode={theme === 'dark'} onThemeToggle={toggleTheme} /> : <Suspense fallback={<p {...stylex.props(ui.muted)}>Loading browser…</p>}><BrowserPanel request={chat.request} notify={notify} onClose={closePanel} onStart={prompt => { closePanel(); newChat(); setDraft(prompt); }} /></Suspense>}</Dialog>}
    {deleteTarget && <Dialog title="Delete conversation?" onClose={() => { if (!isDeleting) setDeleteTarget(undefined); }}><div {...stylex.props(styles.dialogHeader)}><h2 {...stylex.props(ui.title)}>Delete conversation?</h2><CloseButton onClick={() => { if (!isDeleting) setDeleteTarget(undefined); }} /></div><p {...stylex.props(styles.deleteTitle)}>{deleteTarget.title}</p><p {...stylex.props(ui.muted)}>This also deletes the original conversation and its files in Aside. This cannot be undone.</p><div {...stylex.props(styles.dialogActions)}><button {...stylex.props(ui.button)} disabled={isDeleting} autoFocus onClick={() => setDeleteTarget(undefined)}>Cancel</button><button {...stylex.props(ui.button, ui.danger)} disabled={isDeleting} onClick={async () => { setDeleting(true); try { if (await chat.deleteSession(deleteTarget.id)) setDeleteTarget(undefined); } finally { setDeleting(false); } }}>{isDeleting ? 'Deleting…' : 'Delete'}</button></div></Dialog>}
    {zoom && <Dialog title="Image" isWide onClose={() => setZoom(undefined)}><div {...stylex.props(styles.zoomHeader)}><CloseButton onClick={() => setZoom(undefined)} /></div><img src={zoom} alt="Expanded attachment" {...stylex.props(styles.zoomImage)} /></Dialog>}
    <ToastStack toasts={toasts} onDismiss={id => { chat.dismissToast(id); setLocalToasts(current => current.filter(item => item.id !== id)); }} />
  </div>;
}

function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const stack = ref.current;
    if (!stack || !('showPopover' in stack)) return;
    stack.hidePopover();
    if (toasts.length) stack.showPopover();
  }, [toasts]);
  return <div ref={ref} popover="manual" aria-live="polite" aria-atomic="false" {...stylex.props(styles.toasts)}>{toasts.map(toast => <div key={toast.id} role={toast.tone === 'error' ? 'alert' : 'status'} {...stylex.props(styles.toast)}>{toast.tone === 'error' ? <CircleAlert size={18} strokeWidth={ICON_STROKE} /> : <Check size={18} strokeWidth={ICON_STROKE} />}<span {...stylex.props(styles.toastMessage)}>{toast.message}</span><button {...stylex.props(styles.toastClose)} aria-label="Dismiss notification" onClick={() => onDismiss(toast.id)}><X size={16} /></button></div>)}</div>;
}

function Drawer({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} aria-label="Conversation menu" {...stylex.props(styles.drawer)} onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}><div {...stylex.props(styles.drawerContent)}>{children}</div></dialog>;
}

const styles = stylex.create({
  app: { display: 'flex', width: '100%', height: '100dvh', overflow: 'hidden', position: 'fixed', top: 0, left: 0, color: tokens.text, backgroundColor: tokens.canvas },
  desktopSidebar: { width: 288, flexShrink: 0, height: '100%', borderRightWidth: 1, borderRightStyle: 'solid', borderRightColor: tokens.border, '@media (max-width: 820px)': { display: 'none' } },
  main: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, minWidth: 0, flex: 1 },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0, minHeight: 64, padding: 'calc(8px + env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) 8px max(12px, env(safe-area-inset-left))', backgroundColor: tokens.canvas, zIndex: 1 },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 },
  headerActions: { display: 'flex', alignItems: 'center', gap: 4 },
  mobileMenu: { display: 'none', '@media (max-width: 820px)': { display: 'inline-flex' } },
  title: { fontSize: 19, fontWeight: 650, letterSpacing: '-.35px', marginLeft: 4 },
  scrollRegion: { position: 'relative', flex: 1, minHeight: 0, minWidth: 0 },
  scroll: { height: '100%', overflowY: 'auto', overflowX: 'hidden', minWidth: 0, overscrollBehaviorY: 'contain', scrollbarWidth: 'thin', padding: '0 max(20px, env(safe-area-inset-right)) 0 max(20px, env(safe-area-inset-left))' },
  content: { width: '100%', minWidth: 0, maxWidth: 736, margin: '0 auto', minHeight: '100%', display: 'flex', flexDirection: 'column' },
  empty: { display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 70, textAlign: 'center' },
  emptyTitle: { fontSize: 27, lineHeight: 1.3, letterSpacing: '-.7px', fontWeight: 600, margin: 0, '@media (max-width: 375px)': { fontSize: 24 } },
  loading: { display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, fontSize: 14, color: tokens.muted },
  jump: { position: 'absolute', right: 'max(24px, env(safe-area-inset-right))', bottom: 14, width: 40, height: 40, borderRadius: '50%', borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, backgroundColor: tokens.canvas, color: tokens.text, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 6px rgb(0 0 0 / .06)' },
  notice: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, margin: '0 16px 8px', padding: '10px 14px', borderRadius: 14, backgroundColor: tokens.surface, fontSize: 13, lineHeight: 1.5, flexShrink: 0 },
  noticeAction: { backgroundColor: 'transparent', color: tokens.text, borderWidth: 0, minHeight: 32, fontSize: 13, textDecoration: 'underline' },
  connectionNotice: { fontSize: 12, lineHeight: 1.5, textAlign: 'center', color: tokens.muted, padding: '0 16px 8px', flexShrink: 0 },
  drawer: { padding: 0, margin: 0, borderWidth: 0, backgroundColor: 'transparent', width: '100%', height: '100dvh', maxWidth: '100%', maxHeight: '100%', overflow: 'hidden' },
  drawerContent: { width: 'min(320px, 87vw)', height: '100%', boxShadow: '8px 0 32px rgb(0 0 0 / .08)' },
  dialogHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  deleteTitle: { fontSize: 16, fontWeight: 550, lineHeight: 1.5, overflowWrap: 'anywhere' },
  dialogActions: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, marginTop: 22 },
  zoomHeader: { display: 'flex', justifyContent: 'flex-end', marginBottom: 8 },
  zoomImage: { display: 'block', maxWidth: '100%', maxHeight: '70dvh', margin: '0 auto', objectFit: 'contain', borderRadius: 12 },
  toasts: { position: 'fixed', top: 'calc(env(safe-area-inset-top) + 72px)', right: 16, left: 16, bottom: 'auto', margin: 0, width: 'auto', height: 'auto', borderWidth: 0, padding: 0, overflow: 'visible', backgroundColor: 'transparent', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, zIndex: 10, pointerEvents: 'none' },
  toast: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px 10px 16px', minHeight: 48, width: 'fit-content', maxWidth: 440, backgroundColor: tokens.text, color: tokens.canvas, borderRadius: 18, boxShadow: '0 4px 20px rgb(0 0 0 / .14)', pointerEvents: 'auto' },
  toastMessage: { fontSize: 13, lineHeight: 1.45, overflowWrap: 'anywhere', minWidth: 0 },
  toastClose: { backgroundColor: 'transparent', color: 'inherit', borderWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, flexShrink: 0 },
});
