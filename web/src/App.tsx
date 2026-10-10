import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as stylex from '@stylexjs/stylex';
import { ArrowDown, Check, CircleAlert, Ellipsis, SquarePen, X } from 'lucide-react';
import { AnimatePresence, MotionConfig, motion, usePresence, useReducedMotion } from 'motion/react';
import { useChat } from './chat';
import type { ChatSession, Toast } from './types';
import { tokens } from './tokens.stylex';
import { Sidebar } from './Sidebar';
import { Composer } from './Composer';
import { BrowserLive } from './BrowserLive';
import { Settings } from './Settings';
import { SessionMenu } from './SessionMenu';
import { applyTheme, THEME_STORAGE_KEY, applyTextSize, loadTextSize, TEXT_SIZE_STORAGE_KEY, type Theme } from './theme';
import { ICON_STROKE, SESSION_MENU_LABEL, SESSION_MENU_TITLE, BrowserIcon, CloseButton, Dialog, DialogBackdropReset, IconButton, focusDialogSurface, resolveDialogReturnFocus, trapDialogFocus, styles as ui } from './ui';

const BrowserPanel = lazy(() => import('./BrowserPanel').then(module => ({ default: module.BrowserPanel })));
const Messages = lazy(() => import('./Messages').then(module => ({ default: module.Messages })));
const ZOOM_GESTURE_EVENTS = ['gesturestart', 'gesturechange'];
const TOAST_STACK_LIMIT = 3;
const TOAST_DURATION = 3_000;
const TOAST_ERROR_DURATION = 6_000;
const TOAST_HIDDEN = { opacity: 0, y: -100, scale: .96 };

export function App() {
  const chat = useChat();
  const [theme, setTheme] = useState<Theme>(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  const [textSize, setTextSize] = useState(loadTextSize);
  const [announcement, setAnnouncement] = useState('');
  const announcedRunRef = useRef({ sessionId: chat.sessionId, isRunning: false });
  const [isDrawer, setDrawer] = useState(false);
  const [menuSession, setMenuSession] = useState<{ id: string; title: string }>();
  const [panel, setPanel] = useState<'settings' | 'browser' | undefined>(() => location.pathname === '/settings' ? 'settings' : location.pathname === '/tabs' ? 'browser' : undefined);
  const [browserTarget, setBrowserTarget] = useState<string>();
  const [deleteTarget, setDeleteTarget] = useState<ChatSession>(); const [isDeleting, setDeleting] = useState(false);
  const [zoom, setZoom] = useState<string>();
  const [draft, setDraft] = useState(''); const [revision, setRevision] = useState(0);
  const [localToasts, setLocalToasts] = useState<Toast[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null); const contentRef = useRef<HTMLDivElement>(null);
  const shouldFollowRef = useRef(true); const [canJump, setCanJump] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const toasts = [...chat.toasts, ...localToasts].sort((first, second) => first.createdAt - second.createdAt);

  function notify(message: string, kind: 'success' | 'error' = 'success') {
    const id = crypto.randomUUID(); setLocalToasts(current => [...current, { id, createdAt: Date.now(), message, tone: kind }]);
  }
  const dismissToast = useCallback((id: string) => { chat.dismissToast(id); setLocalToasts(current => current.filter(toast => toast.id !== id)); }, [chat.dismissToast]);
  function changeTextSize(size: number) {
    applyTextSize(size); setTextSize(size);
    try { localStorage.setItem(TEXT_SIZE_STORAGE_KEY, String(size)); }
    catch { notify('Text size changed, but your browser could not save the preference.', 'error'); }
  }
  function toggleTheme() {
    const next = theme === 'light' ? 'dark' : 'light';
    applyTheme(next); setTheme(next);
    try { localStorage.setItem(THEME_STORAGE_KEY, next); }
    catch { notify('Theme changed, but your browser could not save the preference.', 'error'); }
  }
  function newChat() { chat.newChat(); setDraft(''); setRevision(value => value + 1); setDrawer(false); setMenuSession(undefined); shouldFollowRef.current = true; setCanJump(false); }
  function openSession(id: string) { void chat.openSession(id); setDraft(''); setRevision(value => value + 1); setDrawer(false); setMenuSession(undefined); shouldFollowRef.current = true; }
  function openPanel(next: 'settings' | 'browser', targetId?: string) { setBrowserTarget(targetId); setPanel(next); setDrawer(false); history.pushState({ panel: next }, '', next === 'settings' ? '/settings' : '/tabs'); }
  function closePanel() { setPanel(undefined); setBrowserTarget(undefined); history.replaceState({}, '', chat.sessionId ? '/c/' + encodeURIComponent(chat.sessionId) : '/'); }

  useEffect(() => { if (chat.recoveredDraft !== undefined) { setDraft(current => current ? current + '\n\n' + chat.recoveredDraft : chat.recoveredDraft || ''); chat.clearRecoveredDraft(); } }, [chat.recoveredDraft, chat.clearRecoveredDraft]);
  useEffect(() => {
    const previous = announcedRunRef.current;
    setAnnouncement(chat.isRunning ? 'Response in progress.' : previous.isRunning && previous.sessionId === chat.sessionId ? 'Response ended.' : '');
    announcedRunRef.current = { sessionId: chat.sessionId, isRunning: chat.isRunning };
  }, [chat.isRunning, chat.sessionId]);
  useEffect(() => {
    const preventZoom = (event: Event) => event.preventDefault();
    ZOOM_GESTURE_EVENTS.forEach(event => document.addEventListener(event, preventZoom, { passive: false }));
    return () => ZOOM_GESTURE_EVENTS.forEach(event => document.removeEventListener(event, preventZoom));
  }, []);
  useEffect(() => {
    const onPop = () => { setPanel(location.pathname === '/settings' ? 'settings' : location.pathname === '/tabs' ? 'browser' : undefined); setDrawer(false); setMenuSession(undefined); setDraft(''); setRevision(value => value + 1); shouldFollowRef.current = true; };
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

  return <MotionConfig reducedMotion="user"><div ref={viewportRef} {...stylex.props(styles.app)}><DialogBackdropReset />
    <div {...stylex.props(styles.desktopSidebar)}><Sidebar chat={chat} onNew={newChat} onOpen={openSession} onSettings={() => openPanel('settings')} onBrowser={() => openPanel('browser')} onDelete={setDeleteTarget} /></div>
    <main aria-label="Chat" {...stylex.props(styles.main)}>
      <div className="sr-only" role="status" aria-atomic="true">{announcement}</div>
      <header id="header" {...stylex.props(styles.header)}><div {...stylex.props(styles.headerLeft)}><span {...stylex.props(styles.mobileMenu)}><IconButton label="Open conversations" aria-haspopup="dialog" aria-expanded={isDrawer} onClick={() => setDrawer(true)}><svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE} strokeLinecap="round" aria-hidden="true"><path d="M4 8h16M4 16h10" /></svg></IconButton></span><span {...stylex.props(styles.title)}>Aside</span></div><div {...stylex.props(styles.headerActions)}><IconButton label="Open browser" aria-haspopup="dialog" onClick={() => openPanel('browser')}><BrowserIcon /></IconButton>{chat.sessionId && chat.isReady && !chat.isOpening && !chat.authError && <IconButton label={SESSION_MENU_LABEL} aria-haspopup="dialog" aria-expanded={menuSession?.id === chat.sessionId} onClick={() => { const id = chat.sessionId; if (id) setMenuSession({ id, title: chat.sessions.find(session => session.id === id)?.title || 'Conversation' }); }}><Ellipsis aria-hidden="true" size={23} strokeWidth={ICON_STROKE} /></IconButton>}<IconButton label="New chat" onClick={newChat}><SquarePen size={22} strokeWidth={ICON_STROKE} /></IconButton></div></header>
      {chat.authError && <div role="alert" {...stylex.props(styles.notice)}><span>Connect to load your conversations.</span><button {...stylex.props(styles.noticeAction)} onClick={() => openPanel('settings')}>Settings</button></div>}
      {chat.isReady && !chat.isConnected && !chat.authError && <div role="status" {...stylex.props(styles.connectionNotice)}>Reconnecting… You can still send a message.</div>}
      <div {...stylex.props(styles.scrollRegion)}><div id="chatScroll" ref={scrollRef} role="region" aria-label="Conversation" tabIndex={0} {...stylex.props(styles.scroll)} onScroll={event => { const box = event.currentTarget; const isNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80; shouldFollowRef.current = isNearBottom; setCanJump(!isNearBottom); }}><div ref={contentRef} {...stylex.props(styles.content)}>
        {chat.isOpening || !chat.isReady ? <div role="status" {...stylex.props(styles.loading)}>Loading conversation…</div> : chat.messages.length || chat.pendingPrompt !== undefined || chat.isRunning || chat.liveAssistant?.text ? <Suspense fallback={<div role="status" {...stylex.props(styles.loading)}>Loading conversation…</div>}><Messages key={chat.sessionId} messages={chat.messages} liveAssistant={chat.liveAssistant} pendingPrompt={chat.pendingPrompt} pendingImages={chat.pendingAttachments.map(attachment => attachment.url)} isRunning={chat.isRunning} notify={notify} onZoom={setZoom} /></Suspense> : <div {...stylex.props(styles.empty)}><h1 {...stylex.props(styles.emptyTitle)}>What’s on your mind?</h1></div>}
      </div></div><AnimatePresence>{canJump && <motion.button key="jump" aria-label="Scroll to latest message" {...stylex.props(styles.jump)} initial={{ opacity: 0, scale: .86, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: .9, y: 6 }} transition={{ duration: .16 }} whileTap={{ scale: .9 }} onClick={() => { shouldFollowRef.current = true; scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); }}><ArrowDown size={19} strokeWidth={ICON_STROKE} /></motion.button>}</AnimatePresence>{chat.sessionId && chat.isReady && !chat.isOpening && !chat.authError && !panel && !isDrawer && !menuSession && !deleteTarget && !zoom && <BrowserLive key={chat.sessionId} sessionId={chat.sessionId} request={chat.request} onOpen={targetId => openPanel('browser', targetId)} />}</div>
      <Composer chat={chat} onBrowser={() => openPanel('browser')} draft={draft} setDraft={setDraft} revision={revision} notify={notify} textSize={textSize} />
    </main>
    <AnimatePresence>{isDrawer && <Drawer key="drawer" onClose={() => setDrawer(false)}><Sidebar chat={chat} isDrawer onClose={() => setDrawer(false)} onNew={newChat} onOpen={openSession} onSettings={() => openPanel('settings')} onBrowser={() => openPanel('browser')} onDelete={session => { setDrawer(false); setDeleteTarget(session); }} /></Drawer>}</AnimatePresence>
    <AnimatePresence mode="wait">{panel && <Dialog key={panel === 'browser' ? `browser:${browserTarget ?? "all"}` : panel} title={panel === 'browser' ? 'Browser' : 'Settings'} isWide={panel === 'browser'} onClose={closePanel}>{panel === 'settings' ? <Settings chat={chat} notify={notify} onClose={closePanel} isDarkMode={theme === 'dark'} onThemeToggle={toggleTheme} textSize={textSize} onTextSizeChange={changeTextSize} /> : <Suspense fallback={<p role="status" {...stylex.props(ui.muted)}>Loading browser…</p>}><BrowserPanel initialTargetId={browserTarget} sessionId={browserTarget ? chat.sessionId : undefined} request={chat.request} notify={notify} onClose={closePanel} onStart={prompt => { closePanel(); if (!browserTarget) newChat(); setDraft(prompt); }} /></Suspense>}</Dialog>}</AnimatePresence>
    <AnimatePresence>{menuSession && menuSession.id === chat.sessionId && !chat.isOpening && !chat.authError && <Dialog key={menuSession.id} title={SESSION_MENU_TITLE} onClose={() => setMenuSession(undefined)}><SessionMenu sessionId={menuSession.id} title={menuSession.title} onClose={() => setMenuSession(undefined)} notify={notify} /></Dialog>}</AnimatePresence>
    <AnimatePresence>{deleteTarget && <Dialog key={deleteTarget.id} title="Delete conversation?" onClose={() => { if (!isDeleting) setDeleteTarget(undefined); }}><div {...stylex.props(styles.dialogHeader)}><h2 {...stylex.props(ui.title)}>Delete conversation?</h2><CloseButton onClick={() => { if (!isDeleting) setDeleteTarget(undefined); }} /></div><p {...stylex.props(styles.deleteTitle)}>{deleteTarget.title}</p><p {...stylex.props(ui.muted)}>This also deletes the original conversation and its files in Aside. This cannot be undone.</p><div {...stylex.props(styles.dialogActions)}><button {...stylex.props(ui.button)} disabled={isDeleting} autoFocus onClick={() => setDeleteTarget(undefined)}>Cancel</button><button {...stylex.props(ui.button, ui.danger)} disabled={isDeleting} onClick={async () => { setDeleting(true); try { if (await chat.deleteSession(deleteTarget.id)) setDeleteTarget(undefined); } finally { setDeleting(false); } }}>{isDeleting ? 'Deleting…' : 'Delete'}</button></div></Dialog>}</AnimatePresence>
    <AnimatePresence>{zoom && <Dialog key={zoom} title="Image" isWide onClose={() => setZoom(undefined)}><div {...stylex.props(styles.zoomHeader)}><CloseButton onClick={() => setZoom(undefined)} /></div><img src={zoom} alt="Expanded attachment" {...stylex.props(styles.zoomImage)} /></Dialog>}</AnimatePresence>
    <ToastStack toasts={toasts} onDismiss={dismissToast} />
  </div></MotionConfig>;
}

function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const shouldReduceMotion = useReducedMotion();
  const visibleToasts = toasts.slice(-TOAST_STACK_LIMIT);
  const [portalTarget, setPortalTarget] = useState<HTMLElement>(() => document.body);
  const countRef = useRef(toasts.length); countRef.current = toasts.length;
  useLayoutEffect(() => {
    const updateTarget = () => setPortalTarget([...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].at(-1) ?? document.body);
    updateTarget();
    const observer = new MutationObserver(updateTarget);
    observer.observe(document.body, { attributes: true, attributeFilter: ['open'], subtree: true });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const stack = ref.current;
    if (!stack || !('showPopover' in stack)) return;
    if (toasts.length && !stack.matches(':popover-open')) stack.showPopover();
  }, [toasts, portalTarget]);
  const dismissNotification = useCallback((id: string) => {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && activeElement.closest('[data-toast-id]')?.getAttribute('data-toast-id') === id) {
      const previous = returnFocusRef.current;
      if (previous?.isConnected && !previous.matches(':disabled') && previous.getClientRects().length) previous.focus({ preventScroll: true });
      else { const dialog = activeElement.closest('dialog'); if (dialog) focusDialogSurface(dialog); else document.querySelector<HTMLButtonElement>('button[aria-label="New chat"]')?.focus({ preventScroll: true }); }
    }
    onDismiss(id);
  }, [onDismiss]);
  useEffect(() => {
    const overflowCount = Math.max(0, toasts.length - TOAST_STACK_LIMIT);
    toasts.slice(0, overflowCount).forEach(toast => dismissNotification(toast.id));
    const timers = toasts.slice(overflowCount).map(toast => {
      const duration = toast.tone === 'error' ? TOAST_ERROR_DURATION : TOAST_DURATION;
      return window.setTimeout(() => dismissNotification(toast.id), Math.max(0, toast.createdAt + duration - Date.now()));
    });
    return () => timers.forEach(window.clearTimeout);
  }, [toasts, dismissNotification]);
  return createPortal(<div ref={ref} popover="manual" onFocusCapture={event => { if (!event.currentTarget.contains(event.relatedTarget) && event.relatedTarget instanceof HTMLElement) returnFocusRef.current = event.relatedTarget; }} {...stylex.props(styles.toasts)}><AnimatePresence initial={false} onExitComplete={() => { const stack = ref.current; if (stack && countRef.current === 0 && stack.matches(':popover-open')) stack.hidePopover(); }}>{visibleToasts.map((toast, index) => {
    const depth = visibleToasts.length - index - 1;
    return <motion.div key={toast.id} data-toast-id={toast.id} {...stylex.props(styles.toast)} style={{ zIndex: index + 1 }} initial={shouldReduceMotion ? { opacity: 0 } : TOAST_HIDDEN} animate={{ opacity: 1, y: depth * 8, scale: 1 - depth * .04 }} exit={shouldReduceMotion ? { opacity: 0 } : TOAST_HIDDEN} transition={{ type: 'tween', duration: shouldReduceMotion ? .12 : .28, ease: [0.22, 1, 0.36, 1] }}><span aria-hidden="true" {...stylex.props(styles.toastIcon)}>{toast.tone === 'error' ? <CircleAlert size={18} strokeWidth={ICON_STROKE} /> : <Check size={18} strokeWidth={ICON_STROKE} />}</span><span role={toast.tone === 'error' ? 'alert' : 'status'} {...stylex.props(styles.toastMessage)}>{toast.message}</span><motion.button type="button" {...stylex.props(styles.toastClose)} style={{ pointerEvents: depth ? 'none' : 'auto' }} tabIndex={depth ? -1 : 0} whileTap={{ scale: .86 }} aria-label="Dismiss notification" onClick={() => dismissNotification(toast.id)}><X size={16} /></motion.button></motion.div>;
  })}</AnimatePresence></div>, portalTarget);
}

function Drawer({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null); const closeRequestedRef = useRef(false); const shouldReduceMotion = useReducedMotion(); const [isPresent, safeToRemove] = usePresence();
  useLayoutEffect(() => { if (isPresent) closeRequestedRef.current = false; }, [isPresent]);
  useEffect(() => { if (isPresent || !safeToRemove) return; const timer = window.setTimeout(safeToRemove, shouldReduceMotion ? 120 : 240); return () => window.clearTimeout(timer); }, [isPresent, safeToRemove, shouldReduceMotion]);
  useLayoutEffect(() => {
    const dialog = ref.current; returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) { dialog.showModal(); focusDialogSurface(dialog); }
    return () => { if (dialog?.open) dialog.close(); requestAnimationFrame(() => { if (!document.querySelector('dialog[open]')) resolveDialogReturnFocus(returnFocusRef.current, 'Conversation menu')?.focus({ preventScroll: true }); }); };
  }, []);
  function requestClose() { if (!isPresent || closeRequestedRef.current) return; closeRequestedRef.current = true; onClose(); }
  return <motion.dialog ref={ref} tabIndex={-1} data-motion-overlay="" style={{ pointerEvents: isPresent ? 'auto' : 'none' }} aria-label="Conversation menu" {...stylex.props(styles.drawer)} onKeyDown={trapDialogFocus} onCancel={event => { event.preventDefault(); requestClose(); }}>
    <motion.button type="button" tabIndex={-1} data-overlay-backdrop="" aria-label="Close conversation menu" {...stylex.props(styles.drawerBackdrop)} initial={{ opacity: 0 }} animate={{ opacity: isPresent ? 1 : 0 }} transition={{ duration: shouldReduceMotion ? .1 : .2 }} onClick={requestClose} />
    <motion.div data-dialog-surface="" {...stylex.props(styles.drawerContent)} initial={shouldReduceMotion ? { opacity: 0 } : { x: -340 }} animate={isPresent ? shouldReduceMotion ? { opacity: 1 } : { x: 0 } : shouldReduceMotion ? { opacity: 0 } : { x: -340 }} transition={shouldReduceMotion ? { duration: .12 } : { duration: .22, ease: [0.22, 1, 0.36, 1] }}>{children}</motion.div>
  </motion.dialog>;
}

const styles = stylex.create({
  app: { display: 'flex', width: '100%', height: '100dvh', overflow: 'hidden', position: 'fixed', top: 0, left: 0, color: tokens.text, backgroundColor: tokens.canvas },
  desktopSidebar: { width: 288, flexShrink: 0, height: '100%', borderRightWidth: 1, borderRightStyle: 'solid', borderRightColor: tokens.border, '@media (max-width: 820px)': { display: 'none' } },
  main: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, minWidth: 0, flex: 1 },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0, minHeight: 64, padding: 'calc(8px + env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) 8px max(12px, env(safe-area-inset-left))', backgroundColor: tokens.canvas, zIndex: 1 },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 },
  headerActions: { display: 'flex', alignItems: 'center', gap: 4 },
  mobileMenu: { display: 'none', '@media (max-width: 820px)': { display: 'inline-flex' } },
  title: { fontSize: '1.1875rem', fontWeight: 650, letterSpacing: '-.35px', marginLeft: 4 },
  scrollRegion: { position: 'relative', flex: 1, minHeight: 0, minWidth: 0 },
  scroll: { height: '100%', overflowY: 'auto', overflowX: 'hidden', minWidth: 0, overscrollBehaviorY: 'contain', scrollbarWidth: 'thin', padding: '0 max(20px, env(safe-area-inset-right)) 0 max(20px, env(safe-area-inset-left))' },
  content: { width: '100%', minWidth: 0, maxWidth: 736, margin: '0 auto', minHeight: '100%', display: 'flex', flexDirection: 'column' },
  empty: { display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 70, textAlign: 'center' },
  emptyTitle: { fontSize: '1.6875rem', lineHeight: 1.3, letterSpacing: '-.7px', fontWeight: 600, margin: 0, '@media (max-width: 375px)': { fontSize: '1.5rem' } },
  loading: { display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, fontSize: '0.875rem', color: tokens.muted },
  jump: { position: 'absolute', right: 'max(24px, env(safe-area-inset-right))', bottom: 14, width: 40, height: 40, borderRadius: '50%', borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, backgroundColor: tokens.canvas, color: tokens.text, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 6px rgb(0 0 0 / .06)' },
  notice: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, margin: '0 16px 8px', padding: '10px 14px', borderRadius: 14, backgroundColor: tokens.surface, fontSize: '0.8125rem', lineHeight: 1.5, flexShrink: 0 },
  noticeAction: { backgroundColor: 'transparent', color: tokens.text, borderWidth: 0, minHeight: 32, fontSize: '0.8125rem', textDecoration: 'underline' },
  connectionNotice: { fontSize: '0.75rem', lineHeight: 1.5, textAlign: 'center', color: tokens.muted, padding: '0 16px 8px', flexShrink: 0 },
  drawer: { position: 'fixed', inset: 0, padding: 0, margin: 0, borderWidth: 0, backgroundColor: 'transparent', width: '100%', height: '100dvh', maxWidth: '100%', maxHeight: '100%', overflow: 'hidden' },
  drawerBackdrop: { position: 'absolute', inset: 0, width: '100%', height: '100%', padding: 0, borderWidth: 0, backgroundColor: 'rgb(0 0 0 / .28)' },
  drawerContent: { position: 'relative', zIndex: 1, width: 'min(320px, 87vw)', height: '100%', boxShadow: '8px 0 32px rgb(0 0 0 / .08)' },
  dialogHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  deleteTitle: { fontSize: '1rem', fontWeight: 550, lineHeight: 1.5, overflowWrap: 'anywhere' },
  dialogActions: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, marginTop: 22 },
  zoomHeader: { display: 'flex', justifyContent: 'flex-end', marginBottom: 8 },
  zoomImage: { display: 'block', maxWidth: '100%', maxHeight: '70dvh', margin: '0 auto', objectFit: 'contain', borderRadius: 12 },
  toasts: { position: 'fixed', top: 'calc(env(safe-area-inset-top) + 72px)', right: 16, left: 16, bottom: 'auto', margin: 0, width: 'auto', height: 'auto', borderWidth: 0, padding: 0, overflow: 'visible', backgroundColor: 'transparent', display: 'grid', justifyItems: 'center', zIndex: 10, pointerEvents: 'none' },
  toast: { gridArea: '1 / 1', transformOrigin: 'top center', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px 10px 16px', minHeight: 48, width: '100%', maxWidth: 440, boxSizing: 'border-box', backgroundColor: tokens.text, color: tokens.canvas, borderRadius: 18, boxShadow: '0 4px 20px rgb(0 0 0 / .14)', pointerEvents: 'none' },
  toastMessage: { flex: 1, fontSize: '0.8125rem', lineHeight: 1.45, overflowWrap: 'anywhere', minWidth: 0, display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 3, overflow: 'hidden' },
  toastIcon: { display: 'flex', flexShrink: 0 },
  toastClose: { backgroundColor: 'transparent', color: 'inherit', borderWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, flexShrink: 0, pointerEvents: 'auto' },
});
