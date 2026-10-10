import * as stylex from '@stylexjs/stylex';
import { Maximize2, Minus, X } from 'lucide-react';
import { AnimatePresence, motion, useDragControls, useMotionValue, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { isTabResponse } from './browser';
import type { BrowserTab } from './types';
import { tokens } from './tokens.stylex';
import { BrowserIcon, ICON_STROKE } from './ui';
import { useAutoRefresh } from './useAutoRefresh';

const KEYBOARD_MOVE_STEP = 20;

export function BrowserLive({ sessionId, request, onOpen, isVisible, isBrowserOpen }: {
  sessionId: string;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  onOpen: (targetId: string) => void;
  isVisible: boolean;
  isBrowserOpen: boolean;
}) {
  const [tab, setTab] = useState<BrowserTab>();
  const [imageUrl, setImageUrl] = useState<string>();
  const [isConnected, setConnected] = useState(false);
  const [isMinimized, setMinimized] = useState(false);
  const [dismissedTarget, setDismissedTarget] = useState<string>();
  const boundsRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const dragControls = useDragControls();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const shouldReduceMotion = useReducedMotion();
  const imageRef = useRef<string | undefined>(undefined);
  const sessionQuery = `&session=${encodeURIComponent(sessionId)}`;
  const targetId = tab?.targetId;
  const shouldShow = isVisible && !!targetId && dismissedTarget !== targetId;

  useEffect(() => {
    if (isBrowserOpen) setDismissedTarget(undefined);
  }, [isBrowserOpen]);

  useLayoutEffect(() => {
    const bounds = boundsRef.current;
    const preview = previewRef.current;
    if (!bounds || !preview || !shouldShow) return;
    const observer = new ResizeObserver(() => {
      dragControls.cancel();
      constrainPosition();
    });
    constrainPosition();
    observer.observe(bounds);
    observer.observe(preview);
    return () => { observer.disconnect(); dragControls.cancel(); };
  }, [shouldShow, dragControls, x, y]);

  function constrainPosition() {
    const bounds = boundsRef.current;
    const preview = previewRef.current;
    if (!bounds || !preview) return;
    x.set(Math.max(Math.min(0, preview.offsetWidth - bounds.clientWidth), Math.min(0, x.get())));
    y.set(Math.max(Math.min(0, preview.offsetHeight - bounds.clientHeight), Math.min(0, y.get())));
  }

  function startDrag(event: PointerEvent) {
    isDraggingRef.current = false;
    dragControls.start(event);
  }

  function moveWithKeyboard(event: KeyboardEvent) {
    isDraggingRef.current = false;
    const delta = { ArrowLeft: [-KEYBOARD_MOVE_STEP, 0], ArrowRight: [KEYBOARD_MOVE_STEP, 0], ArrowUp: [0, -KEYBOARD_MOVE_STEP], ArrowDown: [0, KEYBOARD_MOVE_STEP] }[event.key];
    if (!delta) return;
    event.preventDefault();
    x.set(x.get() + delta[0]);
    y.set(y.get() + delta[1]);
    constrainPosition();
  }

  function openPreview() {
    if (tab && !isDraggingRef.current) onOpen(tab.targetId);
  }

  const loadTabs = useCallback(async (signal: AbortSignal) => {
    try {
      const response = await request(`/api/tabs?refresh=true${sessionQuery}`, { cache: 'no-store', signal });
      const value: unknown = await response.json();
      if (signal.aborted) return;
      if (!isTabResponse(value)) throw new Error('Invalid browser response.');
      setTab(value.tabs.find(tab => tab.active) ?? [...value.tabs].sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0]);
    } catch {
      if (!signal.aborted) setConnected(false);
    }
  }, [request, sessionQuery]);
  useAutoRefresh(loadTabs, 2_000, isVisible);

  const capture = useCallback(async (signal: AbortSignal) => {
    if (!targetId) return;
    try {
      const response = await request(`/api/tabs/${encodeURIComponent(targetId)}/shot?fresh=true${sessionQuery}`, { cache: 'no-store', signal });
      const blob = await response.blob();
      if (signal.aborted) return;
      if (!blob.type.startsWith('image/')) throw new Error('Invalid preview.');
      const nextUrl = URL.createObjectURL(blob);
      const previousUrl = imageRef.current;
      imageRef.current = nextUrl;
      setImageUrl(nextUrl);
      setConnected(true);
      if (previousUrl) URL.revokeObjectURL(previousUrl);
    } catch {
      if (!signal.aborted) setConnected(false);
    }
  }, [request, sessionQuery, targetId]);
  useEffect(() => {
    setImageUrl(undefined);
    setConnected(false);
    return () => {
      if (imageRef.current) URL.revokeObjectURL(imageRef.current);
      imageRef.current = undefined;
    };
  }, [targetId]);
  useAutoRefresh(capture, 1_000, shouldShow && !isMinimized && tab?.loaded !== false);

  return <div ref={boundsRef} {...stylex.props(styles.bounds)}><AnimatePresence>{shouldShow && tab && <motion.div ref={previewRef} role="region" aria-label="Live browser preview" {...stylex.props(styles.preview)} style={{ x, y }} initial={{ opacity: 0, scale: shouldReduceMotion ? 1 : .92 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: shouldReduceMotion ? 1 : .92 }} transition={{ duration: .18 }} drag dragControls={dragControls} dragListener={false} dragConstraints={boundsRef} dragElastic={0} dragMomentum={false} onDragStart={() => { isDraggingRef.current = true; }}>
    <div {...stylex.props(styles.top)}>
      <button type="button" aria-label={`Open live browser preview: ${tab.title || 'Browser'}`} aria-description="Drag to move, or use the arrow keys." aria-haspopup="dialog" {...stylex.props(styles.handle)} onPointerDown={startDrag} onKeyDown={moveWithKeyboard} onClick={openPreview}><BrowserIcon size={15} /><span {...stylex.props(styles.title)}>{tab.title || 'Browser'}</span></button>
      <button type="button" aria-label={isMinimized ? 'Restore browser preview' : 'Minimize browser preview'} aria-expanded={!isMinimized} {...stylex.props(styles.control)} onClick={() => setMinimized(current => !current)}>{isMinimized ? <Maximize2 size={15} strokeWidth={ICON_STROKE} aria-hidden="true" /> : <Minus size={17} strokeWidth={ICON_STROKE} aria-hidden="true" />}</button>
      <button type="button" aria-label="Close browser preview" {...stylex.props(styles.control)} onClick={() => { setDismissedTarget(tab.targetId); document.querySelector<HTMLButtonElement>('button[aria-label="Open browser"]')?.focus({ preventScroll: true }); }}><X size={17} strokeWidth={ICON_STROKE} aria-hidden="true" /></button>
    </div>
    {!isMinimized && <>
      <button type="button" aria-label="Expand live browser preview" aria-haspopup="dialog" {...stylex.props(styles.frame)} onPointerDown={startDrag} onClick={openPreview}>{imageUrl ? <img src={imageUrl} alt="" draggable={false} {...stylex.props(styles.image)} /> : <span {...stylex.props(styles.placeholder)}>{tab.loaded === false ? 'Tab asleep' : 'Connecting…'}</span>}</button>
      <span {...stylex.props(styles.status)}><span {...stylex.props(styles.dot, isConnected && styles.connected)} />{isConnected ? 'Live' : 'Connecting…'}</span>
    </>}
  </motion.div>}</AnimatePresence></div>;
}

const styles = stylex.create({
  bounds: { position: 'absolute', top: 12, left: 'max(16px, env(safe-area-inset-left))', right: 'max(16px, env(safe-area-inset-right))', bottom: 62, pointerEvents: 'none', zIndex: 2 },
  preview: { position: 'absolute', right: 0, bottom: 0, width: 'min(168px, 100%)', maxHeight: '100%', display: 'flex', flexDirection: 'column', padding: 0, borderRadius: 16, borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, backgroundColor: tokens.canvas, color: tokens.text, overflow: 'hidden', pointerEvents: 'auto', touchAction: 'none', boxShadow: '0 6px 28px rgb(0 0 0 / .15)', textAlign: 'left', userSelect: 'none' },
  top: { display: 'flex', alignItems: 'center', minWidth: 0, minHeight: 40, flexShrink: 0, padding: '0 4px' },
  handle: { display: 'flex', flex: 1, alignItems: 'center', gap: 6, alignSelf: 'stretch', minWidth: 0, padding: '0 6px', borderWidth: 0, backgroundColor: 'transparent', color: tokens.text, touchAction: 'none', cursor: { default: 'grab', ':active': 'grabbing' } },
  control: { display: 'grid', placeItems: 'center', width: 32, height: 36, flexShrink: 0, padding: 0, borderWidth: 0, borderRadius: 10, color: tokens.text, backgroundColor: { default: 'transparent', ':hover': tokens.hover } },
  title: { flex: 1, minWidth: 0, fontSize: '0.6875rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: 600 },
  frame: { display: 'flex', width: '100%', minHeight: 0, aspectRatio: '4 / 3', padding: 0, borderWidth: 0, overflow: 'hidden', backgroundColor: tokens.surface, touchAction: 'none', cursor: 'grab' },
  image: { width: '100%', height: '100%', objectFit: 'contain', objectPosition: 'top' },
  placeholder: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', fontSize: '0.6875rem', color: tokens.muted },
  status: { display: 'flex', flexShrink: 0, alignItems: 'center', gap: 5, padding: '7px 10px', fontSize: '0.625rem', color: tokens.muted },
  dot: { width: 5, height: 5, borderRadius: '50%', backgroundColor: tokens.muted },
  connected: { backgroundColor: tokens.text },
});
