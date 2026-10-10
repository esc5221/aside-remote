import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { VirtuosoHandle } from 'react-virtuoso';
import * as stylex from '@stylexjs/stylex';
import { ArrowDown, Check, CircleAlert, Ellipsis, Menu, SquarePen, X } from 'lucide-react';
import { AnimatePresence, MotionConfig, motion, usePresence, useReducedMotion } from 'motion/react';
import { useChat } from './chat';
import { usePushNotifications } from './notifications';
import type { ChatSession, Toast } from './types';
import { tokens } from './tokens.stylex';
import { Sidebar } from './Sidebar';
import { Composer } from './Composer';
import { BrowserLive } from './BrowserLive';
import { Settings } from './Settings';
import { RenameConversation, SessionMenu, type SessionMenuTarget } from './SessionMenu';
import { applyTheme, THEME_STORAGE_KEY, applyTextSize, loadTextSize, TEXT_SIZE_STORAGE_KEY, type Theme } from './theme';
import { ICON_STROKE, SESSION_MENU_LABEL, CloseButton, Dialog, DialogBackdropReset, IconButton, focusDialogSurface, resolveDialogReturnFocus, trapDialogFocus, styles as ui } from './ui';

const BrowserPanel = lazy(() => import('./BrowserPanel').then(module => ({ default: module.BrowserPanel })));
const Messages = lazy(() => import('./Messages').then(module => ({ default: module.Messages })));
const ZOOM_GESTURE_EVENTS = ['gesturestart', 'gesturechange'];
const TOAST_STACK_LIMIT = 3;
const TOAST_DURATION = 3_000;
const TOAST_ERROR_DURATION = 6_000;
const TOAST_HIDDEN = { opacity: 0, y: -16, scale: .96 };
const latestMessage = { index: 'LAST', align: 'end' } as const;
const SWIPE_AXIS_THRESHOLD = 10;
const DRAWER_SWIPE_DISTANCE = 48;
const HORIZONTAL_GESTURE_RATIO = 1.25;

export function App() {
  const chat = useChat();
  const [theme, setTheme] = useState<Theme>(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  const [textSize, setTextSize] = useState(loadTextSize);
  const [announcement, setAnnouncement] = useState('');
  const announcedRunRef = useRef({ sessionId: chat.sessionId, isRunning: false });
  const [isDrawer, setDrawer] = useState(false);
  const [menuSession, setMenuSession] = useState<SessionMenuTarget>();
  const [renameTarget, setRenameTarget] = useState<Pick<ChatSession, 'id' | 'title'>>();
  const [panel, setPanel] = useState<'settings' | 'browser' | undefined>(() => location.pathname === '/settings' ? 'settings' : location.pathname === '/tabs' ? 'browser' : undefined);
  const [browserTarget, setBrowserTarget] = useState<string>();
  const [deleteTarget, setDeleteTarget] = useState<Pick<ChatSession, 'id' | 'title'>>(); const [isDeleting, setDeleting] = useState(false);
  const [zoom, setZoom] = useState<string>();
  const [draft, setDraft] = useState(''); const [revision, setRevision] = useState(0);
  const [isKeyboardOpen, setKeyboardOpen] = useState(false);
  const [localToasts, setLocalToasts] = useState<Toast[]>([]);
  const listRef = useRef<VirtuosoHandle>(null);
  const [canJump, setCanJump] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const sessionTitle = chat.sessions.find(session => session.id === chat.sessionId)?.title || (chat.sessionId ? 'Conversation' : 'New chat');
  const toasts = [...chat.toasts, ...localToasts].sort((first, second) => first.createdAt - second.createdAt);

  function changeAtBottom(isAtBottom: boolean) { setCanJump(!isAtBottom); }

  function notify(message: string, kind: 'success' | 'error' = 'success') {
    const id = crypto.randomUUID(); setLocalToasts(current => [...current, { id, createdAt: Date.now(), message, tone: kind }]);
  }
  const notifications = usePushNotifications(chat, notify);
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
  function newChat() { chat.newChat(); setDraft(''); setRevision(value => value + 1); setDrawer(false); setMenuSession(undefined); changeAtBottom(true); }
  function openSession(id: string) { void chat.openSession(id); setDraft(''); setRevision(value => value + 1); setDrawer(false); setMenuSession(undefined); changeAtBottom(true); }
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
    let swipe: { id: number; x: number; y: number; horizontal: boolean } | undefined;
    function startSwipe(event: TouchEvent) {
      swipe = undefined;
      const target = event.target;
      if (event.touches.length !== 1 || !(target instanceof Element) || !matchMedia('(max-width: 820px)').matches) return;
      if (target.closest('input, textarea, select, [contenteditable="true"], [data-selectable="true"], [aria-label="Live browser preview"], [popover]') || horizontalScroller(target)) return;
      const dialog = target.closest('dialog');
      if (dialog ? dialog.getAttribute('aria-label') !== 'Conversation menu' : !target.closest('main[aria-label="Chat"]')) return;
      const touch = event.touches[0];
      swipe = { id: touch.identifier, x: touch.clientX, y: touch.clientY, horizontal: false };
    }
    function moveSwipe(event: TouchEvent) {
      if (!swipe) return;
      if (event.touches.length !== 1) { swipe = undefined; return; }
      const touch = [...event.touches].find(touch => touch.identifier === swipe?.id);
      if (!touch) return;
      const dx = Math.abs(touch.clientX - swipe.x);
      const dy = Math.abs(touch.clientY - swipe.y);
      if (!swipe.horizontal) {
        if (Math.max(dx, dy) < SWIPE_AXIS_THRESHOLD) return;
        if (dx <= dy * HORIZONTAL_GESTURE_RATIO) { swipe = undefined; return; }
        swipe.horizontal = true;
      }
      if (event.cancelable) event.preventDefault();
    }
    function finishSwipe(event: TouchEvent) {
      const current = swipe; swipe = undefined;
      if (!current?.horizontal || event.type === 'touchcancel') return;
      const touch = [...event.changedTouches].find(touch => touch.identifier === current.id);
      if (!touch) return;
      const dx = touch.clientX - current.x;
      if (Math.abs(dx) < DRAWER_SWIPE_DISTANCE || document.querySelector('[popover]:popover-open')) return;
      if (dx > 0 && !isDrawer && !document.querySelector('dialog[open]')) setDrawer(true);
      else if (dx < 0 && isDrawer) { setMenuSession(undefined); setDrawer(false); }
    }
    function preventHorizontalNavigation(event: WheelEvent) {
      if (event.ctrlKey || Math.abs(event.deltaX) <= Math.abs(event.deltaY) * HORIZONTAL_GESTURE_RATIO) return;
      const scroller = event.target instanceof Element ? horizontalScroller(event.target) : undefined;
      if (scroller && (event.deltaX < 0 ? scroller.scrollLeft > 0 : scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1)) return;
      if (event.cancelable) event.preventDefault();
    }
    function horizontalScroller(target: Element) {
      for (let element: Element | null = target; element; element = element.parentElement) {
        if (element.scrollWidth > element.clientWidth + 1 && /^(auto|scroll)$/.test(getComputedStyle(element).overflowX)) return element;
      }
    }
    document.addEventListener('touchstart', startSwipe, { passive: true, capture: true });
    document.addEventListener('touchmove', moveSwipe, { passive: false, capture: true });
    document.addEventListener('touchend', finishSwipe, true);
    document.addEventListener('touchcancel', finishSwipe, true);
    document.addEventListener('wheel', preventHorizontalNavigation, { passive: false, capture: true });
    return () => {
      document.removeEventListener('touchstart', startSwipe, true);
      document.removeEventListener('touchmove', moveSwipe, true);
      document.removeEventListener('touchend', finishSwipe, true);
      document.removeEventListener('touchcancel', finishSwipe, true);
      document.removeEventListener('wheel', preventHorizontalNavigation, true);
    };
  }, [isDrawer]);
  useEffect(() => {
    const onPop = () => { setPanel(location.pathname === '/settings' ? 'settings' : location.pathname === '/tabs' ? 'browser' : undefined); setDrawer(false); setMenuSession(undefined); setDraft(''); setRevision(value => value + 1); changeAtBottom(true); };
    window.addEventListener('popstate', onPop); return () => window.removeEventListener('popstate', onPop);
  }, []);
  useEffect(() => {
    if (!chat.isReady || !('serviceWorker' in navigator)) return;
    function openNotification(event: MessageEvent<unknown>) {
      if (typeof event.data !== 'object' || event.data === null || Reflect.get(event.data, 'type') !== 'open-conversation') return;
      const url = Reflect.get(event.data, 'url');
      if (typeof url !== 'string') return;
      let target: URL;
      try { target = new URL(url, location.origin); } catch { return; }
      if (target.origin !== location.origin || !/^\/c\/[A-Za-z0-9]{12,32}$/.test(target.pathname)) return;
      if (location.pathname !== target.pathname) history.pushState({}, '', target.pathname);
      setPanel(undefined); setBrowserTarget(undefined); setDrawer(false); setMenuSession(undefined); setRenameTarget(undefined); setDeleteTarget(undefined); setZoom(undefined);
      openSession(target.pathname.slice(3));
      event.ports[0]?.postMessage(target.pathname);
    }
    navigator.serviceWorker.addEventListener('message', openNotification);
    return () => navigator.serviceWorker.removeEventListener('message', openNotification);
  }, [chat.isReady, chat.openSession]);
  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const updateHeight = () => header.parentElement?.style.setProperty('--header-height', header.getBoundingClientRect().height + 'px');
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let expandedHeight = viewport.height;
    let viewportWidth = viewport.width;
    const resize = () => {
      if (viewport.width !== viewportWidth) { expandedHeight = viewport.height; viewportWidth = viewport.width; }
      expandedHeight = Math.max(expandedHeight, viewport.height);
      const root = viewportRef.current;
      if (!root) return;
      const isKeyboardVisible = document.activeElement?.id === 'draft' && matchMedia('(pointer: coarse)').matches && expandedHeight - viewport.height > 150;
      setKeyboardOpen(isKeyboardVisible);
      root.style.height = viewport.height + 'px';
      root.style.top = viewport.offsetTop + 'px';
      root.style.setProperty('--keyboard-tools-display', isKeyboardVisible ? 'flex' : 'none');
      if (isKeyboardVisible) root.style.setProperty('--composer-bottom-padding', '6px');
      else root.style.removeProperty('--composer-bottom-padding');
    };
    resize(); viewport.addEventListener('resize', resize); viewport.addEventListener('scroll', resize);
    document.addEventListener('focusin', resize); document.addEventListener('focusout', resize);
    return () => { viewport.removeEventListener('resize', resize); viewport.removeEventListener('scroll', resize); document.removeEventListener('focusin', resize); document.removeEventListener('focusout', resize); };
  }, []);
  useEffect(() => {
    let frame = 0;
    const returnToLatest = () => {
      if (document.visibilityState === 'hidden') return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => listRef.current?.scrollToIndex(latestMessage));
    };
    document.addEventListener('visibilitychange', returnToLatest);
    window.addEventListener('focus', returnToLatest);
    window.addEventListener('pageshow', returnToLatest);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', returnToLatest); window.removeEventListener('focus', returnToLatest); window.removeEventListener('pageshow', returnToLatest); };
  }, []);

  return <MotionConfig reducedMotion="user"><div ref={viewportRef} {...stylex.props(styles.app)}><DialogBackdropReset />
    <div {...stylex.props(styles.desktopSidebar)}><Sidebar chat={chat} onNew={newChat} onOpen={openSession} onSettings={() => openPanel('settings')} onBrowser={() => openPanel('browser')} onMenu={setMenuSession} /></div>
    <main aria-label="Chat" {...stylex.props(styles.main)}>
      <div className="sr-only" role="status" aria-atomic="true">{announcement}</div>
      <header ref={headerRef} id="header" {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.headerLeft)}><span {...stylex.props(ui.glass, styles.mobileMenu)}><IconButton label="Open conversations" style={{ width: 40, height: 40 }} aria-haspopup="dialog" aria-expanded={isDrawer} onClick={() => setDrawer(true)}><Menu size={24} strokeWidth={ICON_STROKE} aria-hidden="true" /></IconButton></span><div {...stylex.props(styles.heading)}><span title={sessionTitle} {...stylex.props(styles.title)}>{sessionTitle}</span><span {...stylex.props(styles.subtitle)}>{chat.isRunning ? 'Aside · Working…' : 'Aside'}</span></div></div>
        <div {...stylex.props(ui.glass, styles.headerActions)}><IconButton label="New chat" style={{ height: 40 }} onClick={newChat}><SquarePen size={23} strokeWidth={ICON_STROKE} aria-hidden="true" /></IconButton>{chat.sessionId && !chat.authError && <IconButton disabled={!chat.isReady || chat.isOpening} label={SESSION_MENU_LABEL} style={{ height: 40 }} aria-haspopup="menu" aria-expanded={menuSession?.id === chat.sessionId} onClick={event => { const id = chat.sessionId; if (menuSession) setMenuSession(undefined); else if (id) setMenuSession({ id, title: sessionTitle, anchor: event.currentTarget }); }}><Ellipsis aria-hidden="true" size={23} strokeWidth={ICON_STROKE} /></IconButton>}</div>
      </header>
      {chat.authError && <div role="alert" {...stylex.props(styles.notice)}><span>Connect to load your conversations.</span><button {...stylex.props(styles.noticeAction)} onClick={() => openPanel('settings')}>Settings</button></div>}
      {chat.isReady && !chat.isConnected && !chat.authError && <div role="status" {...stylex.props(styles.connectionNotice)}>Reconnecting… You can still send a message.</div>}
      <div {...stylex.props(styles.scrollRegion)}>
        {chat.isOpening || !chat.isReady ? <ConversationLoading /> : chat.messages.length || chat.pendingPrompt !== undefined || chat.isRunning || chat.liveAssistant?.text ? <Suspense fallback={<ConversationLoading />}><Messages key={chat.sessionId} chat={chat} listRef={listRef} onAtBottomChange={changeAtBottom} notify={notify} onZoom={setZoom} /></Suspense> : <div {...stylex.props(styles.empty)}><h1 {...stylex.props(styles.emptyTitle)}>What’s on your mind?</h1></div>}
        <AnimatePresence>{canJump && !chat.isOpening && <motion.button key="jump" aria-label="Scroll to latest message" {...stylex.props(styles.jump, ui.glass)} initial={{ opacity: 0, scale: .86, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: .9, y: 6 }} transition={{ duration: .16 }} whileTap={{ scale: .9 }} onClick={() => listRef.current?.scrollToIndex(latestMessage)}><ArrowDown size={19} strokeWidth={ICON_STROKE} /></motion.button>}</AnimatePresence>
        {chat.sessionId && chat.isReady && !chat.isOpening && !chat.authError && <BrowserLive key={chat.sessionId} sessionId={chat.sessionId} request={chat.request} isVisible={!panel && !isDrawer && !menuSession && !deleteTarget && !zoom} onOpen={targetId => openPanel('browser', targetId)} />}
      </div>
      <Composer chat={chat} onBrowser={() => openPanel('browser')} draft={draft} setDraft={setDraft} revision={revision} notify={notify} textSize={textSize} isKeyboardOpen={isKeyboardOpen} />
    </main>
    <AnimatePresence>{isDrawer && <Drawer key="drawer" onClose={() => { setMenuSession(undefined); setDrawer(false); }}><Sidebar chat={chat} isDrawer onClose={() => { setMenuSession(undefined); setDrawer(false); }} onNew={newChat} onOpen={openSession} onSettings={() => openPanel('settings')} onBrowser={() => openPanel('browser')} onMenu={setMenuSession} /></Drawer>}</AnimatePresence>
    <AnimatePresence mode="wait">{panel && <Dialog key={panel === 'browser' ? `browser:${browserTarget ?? "all"}` : panel} title={panel === 'browser' ? 'Browser' : 'Settings'} isWide={panel === 'browser'} onClose={closePanel}>{panel === 'settings' ? <Settings chat={chat} notifications={notifications} notify={notify} onClose={closePanel} isDarkMode={theme === 'dark'} onThemeToggle={toggleTheme} textSize={textSize} onTextSizeChange={changeTextSize} /> : <Suspense fallback={<p role="status" {...stylex.props(ui.muted)}>Loading browser…</p>}><BrowserPanel initialTargetId={browserTarget} sessionId={browserTarget ? chat.sessionId : undefined} request={chat.request} notify={notify} onClose={closePanel} onStart={prompt => { closePanel(); if (!browserTarget) newChat(); setDraft(prompt); }} /></Suspense>}</Dialog>}</AnimatePresence>
    {menuSession && !chat.authError && <SessionMenu key={menuSession.id} target={menuSession} chat={chat} onClose={() => setMenuSession(undefined)} notify={notify} onRename={setRenameTarget} onDelete={session => { setDrawer(false); setDeleteTarget(session); }} />}
    <AnimatePresence>{renameTarget && <Dialog key={renameTarget.id} title="Rename conversation" onClose={() => setRenameTarget(undefined)}><RenameConversation session={renameTarget} chat={chat} onClose={() => setRenameTarget(undefined)} /></Dialog>}</AnimatePresence>
    <AnimatePresence>{deleteTarget && <Dialog key={deleteTarget.id} title="Delete conversation?" onClose={() => { if (!isDeleting) setDeleteTarget(undefined); }}><div {...stylex.props(styles.dialogHeader)}><h2 {...stylex.props(ui.title)}>Delete conversation?</h2><CloseButton onClick={() => { if (!isDeleting) setDeleteTarget(undefined); }} /></div><p {...stylex.props(styles.deleteTitle)}>{deleteTarget.title}</p><p {...stylex.props(ui.muted)}>This also deletes the original conversation and its files in Aside. This cannot be undone.</p><div {...stylex.props(styles.dialogActions)}><button {...stylex.props(ui.button)} disabled={isDeleting} autoFocus onClick={() => setDeleteTarget(undefined)}>Cancel</button><button {...stylex.props(ui.button, ui.danger)} disabled={isDeleting} onClick={async () => { setDeleting(true); try { if (await chat.deleteSession(deleteTarget.id)) setDeleteTarget(undefined); } finally { setDeleting(false); } }}>{isDeleting ? 'Deleting…' : 'Delete'}</button></div></Dialog>}</AnimatePresence>
    <AnimatePresence>{zoom && <Dialog key={zoom} title="Image" isWide onClose={() => setZoom(undefined)}><div {...stylex.props(styles.zoomHeader)}><CloseButton onClick={() => setZoom(undefined)} /></div><img src={zoom} alt="Expanded attachment" {...stylex.props(styles.zoomImage)} /></Dialog>}</AnimatePresence>
    <ToastStack toasts={toasts} onDismiss={dismissToast} />
  </div></MotionConfig>;
}

function ConversationLoading() {
  const shouldReduceMotion = useReducedMotion();
  return <div role="region" aria-label="Conversation" aria-busy="true" {...stylex.props(styles.conversationLoading)}>
    <span className="sr-only" role="status">Loading messages…</span>
    <motion.div aria-hidden="true" {...stylex.props(styles.messageSkeleton)} animate={shouldReduceMotion ? undefined : { opacity: [.45, .8, .45] }} transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}>
      {[88, 72, 48].map(width => <div key={width} style={{ width: `${width}%` }} {...stylex.props(styles.skeletonLine)} />)}
    </motion.div>
  </div>;
}

function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const shouldReduceMotion = useReducedMotion();
  const visibleToasts = toasts.slice(-TOAST_STACK_LIMIT);
  const [portalTarget, setPortalTarget] = useState<HTMLElement>(() => document.body);
  useLayoutEffect(() => {
    const updateTarget = () => setPortalTarget([...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].at(-1) ?? document.body);
    updateTarget();
    const observer = new MutationObserver(updateTarget);
    observer.observe(document.body, { attributes: true, attributeFilter: ['open'], subtree: true });
    return () => observer.disconnect();
  }, []);
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
  return createPortal(<div data-toast-stack="" onFocusCapture={event => { if (!event.currentTarget.contains(event.relatedTarget) && event.relatedTarget instanceof HTMLElement) returnFocusRef.current = event.relatedTarget; }} {...stylex.props(styles.toasts)}><AnimatePresence initial={false}>{visibleToasts.map((toast, index) => {
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
  main: { display: 'flex', flexDirection: 'column', position: 'relative', height: '100%', minHeight: 0, minWidth: 0, flex: 1 },
  header: { position: 'absolute', top: 0, left: 0, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 68, padding: 'calc(12px + env(safe-area-inset-top)) max(18px, env(safe-area-inset-right)) 12px max(18px, env(safe-area-inset-left))', backgroundImage: 'linear-gradient(to bottom, var(--canvas), color-mix(in srgb, var(--canvas) 80%, transparent) 60%, transparent)', backdropFilter: 'blur(10px)', zIndex: 3, pointerEvents: 'none' },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: 1 },
  heading: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 },
  headerActions: { display: 'flex', alignItems: 'center', gap: 4, padding: '0 3px', borderRadius: 28, flexShrink: 0, pointerEvents: 'auto' },
  mobileMenu: { display: 'none', borderRadius: '50%', pointerEvents: 'auto', '@media (max-width: 820px)': { display: 'inline-flex' } },
  title: { fontSize: '.9375rem', lineHeight: 1.25, fontWeight: 650, letterSpacing: '-.2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  subtitle: { color: tokens.muted, fontSize: '.75rem', lineHeight: 1.25, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  scrollRegion: { position: 'relative', flex: 1, minHeight: 0, minWidth: 0 },
  empty: { display: 'flex', height: '100%', flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 'calc(var(--composer-height) + 70px)', textAlign: 'center' },
  emptyTitle: { fontSize: '1.6875rem', lineHeight: 1.3, letterSpacing: '-.7px', fontWeight: 600, margin: 0, '@media (max-width: 375px)': { fontSize: '1.5rem' } },
  conversationLoading: { display: 'flex', height: '100%', alignItems: 'flex-end', padding: '20px max(20px, env(safe-area-inset-right)) calc(var(--composer-height) + 28px) max(20px, env(safe-area-inset-left))', minWidth: 0 },
  messageSkeleton: { display: 'flex', flexDirection: 'column', gap: 12, width: '100%', maxWidth: 736, margin: '0 auto' },
  skeletonLine: { height: 12, borderRadius: 6, backgroundColor: tokens.bubble },
  jump: { position: 'absolute', left: '50%', marginLeft: -20, bottom: 'calc(var(--composer-height) + 10px)', width: 40, height: 40, borderRadius: '50%', borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, backgroundColor: tokens.canvas, color: tokens.text, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 6px rgb(0 0 0 / .06)' },
  notice: { display: 'flex', position: 'absolute', top: 'var(--header-height)', right: 16, left: 16, zIndex: 3, alignItems: 'center', justifyContent: 'space-between', gap: 10, margin: 0, padding: '10px 14px', borderRadius: 14, backgroundColor: tokens.surface, fontSize: '0.8125rem', lineHeight: 1.5, flexShrink: 0 },
  noticeAction: { backgroundColor: 'transparent', color: tokens.text, borderWidth: 0, minHeight: 32, fontSize: '0.8125rem', textDecoration: 'underline' },
  connectionNotice: { position: 'absolute', top: 'var(--header-height)', left: 0, right: 0, zIndex: 3, backgroundColor: tokens.canvas, fontSize: '0.75rem', lineHeight: 1.5, textAlign: 'center', color: tokens.muted, padding: '0 16px 8px', flexShrink: 0 },
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
