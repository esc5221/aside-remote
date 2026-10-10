import * as stylex from '@stylexjs/stylex';
import { ExternalLink, Maximize2, Minus, X } from 'lucide-react';
import { AnimatePresence, motion, useDragControls, useMotionValue, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { getWebsiteUrl, isTabResponse, OPEN_IN_BROWSER_LABEL } from './browser';
import type { BrowserTab } from './types';
import { tokens } from './tokens.stylex';
import { ICON_STROKE } from './ui';
import { useAutoRefresh } from './useAutoRefresh';

const KEYBOARD_MOVE_STEP = 20;
const POSITION_STORAGE_KEY = 'asideBrowserPreviewPosition';

export function BrowserLive({ sessionId, request, onOpen, isVisible, isBrowserOpen }: {
  sessionId: string;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  onOpen: (targetId: string) => void;
  isVisible: boolean;
  isBrowserOpen: boolean;
}) {
  const [tab, setTab] = useState<BrowserTab>();
  const [imageUrl, setImageUrl] = useState<string>();
  const [isMinimized, setMinimized] = useState(false);
  const [dismissedTarget, setDismissedTarget] = useState<string>();
  const boundsRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const dragControls = useDragControls();
  const [initialPosition] = useState(loadPosition);
  const positionRef = useRef(initialPosition);
  const x = useMotionValue(initialPosition?.x ?? 0);
  const y = useMotionValue(initialPosition?.y ?? 0);
  const shouldReduceMotion = useReducedMotion();
  const imageRef = useRef<string | undefined>(undefined);
  const sessionQuery = `&session=${encodeURIComponent(sessionId)}`;
  const targetId = tab?.targetId;
  const websiteUrl = tab && getWebsiteUrl(tab.url);
  const shouldShow = !!targetId && dismissedTarget !== targetId;

  useEffect(() => {
    if (isBrowserOpen) setDismissedTarget(undefined);
  }, [isBrowserOpen]);

  useLayoutEffect(() => {
    const bounds = boundsRef.current;
    const preview = previewRef.current;
    if (!bounds || !preview || !shouldShow) return;
    const restorePosition = () => {
      dragControls.cancel();
      const position = positionRef.current ?? { x: 0, y: preview.offsetHeight - bounds.clientHeight };
      x.set(position.x); y.set(position.y);
      constrainPosition();
    };
    const observer = new ResizeObserver(restorePosition);
    restorePosition();
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
    savePosition();
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
      return;
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
      if (previousUrl) URL.revokeObjectURL(previousUrl);
    } catch {
      return;
    }
  }, [request, sessionQuery, targetId]);
  useEffect(() => {
    setImageUrl(undefined);
    return () => {
      if (imageRef.current) URL.revokeObjectURL(imageRef.current);
      imageRef.current = undefined;
    };
  }, [targetId]);
  useAutoRefresh(capture, 1_000, isVisible && shouldShow && !isMinimized && tab?.loaded !== false);

  return <div ref={boundsRef} inert={!isVisible} style={{ visibility: isVisible ? 'visible' : 'hidden' }} {...stylex.props(styles.bounds)}><AnimatePresence>{shouldShow && tab && <motion.div ref={previewRef} role="region" aria-label="Live browser preview" {...stylex.props(styles.preview)} style={{ x, y }} initial={{ scale: shouldReduceMotion ? 1 : .92 }} animate={{ scale: 1 }} exit={{ scale: shouldReduceMotion ? 1 : .92 }} transition={{ duration: .18 }} drag dragControls={dragControls} dragListener={false} dragConstraints={boundsRef} dragElastic={0} dragMomentum={false} onDragStart={() => { isDraggingRef.current = true; }} onDragEnd={savePosition}>
    <div {...stylex.props(styles.top)}>
      <button type="button" aria-label={`Open live browser preview: ${tab.title || 'Browser'}`} aria-description="Drag to move, or use the arrow keys." aria-haspopup="dialog" {...stylex.props(styles.handle)} onPointerDown={startDrag} onKeyDown={moveWithKeyboard} onClick={openPreview}><span {...stylex.props(styles.title)}>{tab.title || 'Browser'}</span></button>
      {websiteUrl && <a href={websiteUrl} target="_blank" rel="noopener noreferrer external" aria-label={OPEN_IN_BROWSER_LABEL} title={OPEN_IN_BROWSER_LABEL} {...stylex.props(styles.control)}><ExternalLink size={15} strokeWidth={ICON_STROKE} aria-hidden="true" /></a>}
      <button type="button" aria-label={isMinimized ? 'Restore browser preview' : 'Minimize browser preview'} aria-expanded={!isMinimized} {...stylex.props(styles.control)} onClick={() => setMinimized(current => !current)}>{isMinimized ? <Maximize2 size={15} strokeWidth={ICON_STROKE} aria-hidden="true" /> : <Minus size={17} strokeWidth={ICON_STROKE} aria-hidden="true" />}</button>
      <button type="button" aria-label="Close browser preview" {...stylex.props(styles.control)} onClick={() => { setDismissedTarget(tab.targetId); document.querySelector<HTMLButtonElement>('button[aria-label="Open conversations"]')?.focus({ preventScroll: true }); }}><X size={17} strokeWidth={ICON_STROKE} aria-hidden="true" /></button>
    </div>
    {!isMinimized &&
      <button type="button" aria-label="Expand live browser preview" aria-haspopup="dialog" {...stylex.props(styles.frame)} onPointerDown={startDrag} onClick={openPreview}>{imageUrl ? <img src={imageUrl} alt="" draggable={false} {...stylex.props(styles.image)} /> : <span {...stylex.props(styles.placeholder)}>{tab.loaded === false ? 'Tab asleep' : 'Connecting…'}</span>}</button>
    }
  </motion.div>}</AnimatePresence></div>;

  function savePosition() {
    constrainPosition();
    positionRef.current = { x: x.get(), y: y.get() };
    try { localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(positionRef.current)); }
    catch { }
  }

  function loadPosition() {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(POSITION_STORAGE_KEY) ?? 'null');
      if (typeof value === 'object' && value !== null) {
        const x = Reflect.get(value, 'x'); const y = Reflect.get(value, 'y');
        if (typeof x === 'number' && Number.isFinite(x) && x <= 0 && typeof y === 'number' && Number.isFinite(y) && y <= 0) return { x, y };
      }
    } catch { }
  }
}

const styles = stylex.create({
  bounds: { position: 'absolute', top: 'calc(var(--header-height) + 12px)', left: 'max(16px, env(safe-area-inset-left))', right: 'max(16px, env(safe-area-inset-right))', bottom: 'calc(var(--composer-height) + 62px)', pointerEvents: 'none', zIndex: 2 },
  preview: { position: 'absolute', right: 0, bottom: 0, width: 'min(220px, 100%)', maxHeight: '100%', display: 'flex', flexDirection: 'column', padding: 0, borderRadius: 16, borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, backgroundColor: tokens.canvas, color: tokens.text, overflow: 'hidden', pointerEvents: 'auto', touchAction: 'none', boxShadow: '0 6px 28px rgb(0 0 0 / .15)', textAlign: 'left', userSelect: 'none' },
  top: { display: 'flex', alignItems: 'center', minWidth: 0, minHeight: 40, flexShrink: 0, padding: '2px 6px 2px 10px', backgroundColor: tokens.canvas },
  handle: { display: 'flex', flex: 1, alignItems: 'center', alignSelf: 'stretch', minWidth: 0, padding: '0 6px 0 0', borderWidth: 0, backgroundColor: 'transparent', color: tokens.text, touchAction: 'none', cursor: { default: 'grab', ':active': 'grabbing' } },
  control: { display: 'grid', placeItems: 'center', width: 32, height: 36, flexShrink: 0, padding: 0, borderWidth: 0, borderRadius: 10, color: tokens.text, backgroundColor: { default: 'transparent', ':hover': tokens.hover }, textDecoration: 'none' },
  title: { flex: 1, minWidth: 0, fontSize: '0.625rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: 600 },
  frame: { display: 'flex', width: '100%', minHeight: 0, aspectRatio: '4 / 3', padding: 0, borderWidth: 0, overflow: 'hidden', backgroundColor: tokens.surface, touchAction: 'none', cursor: 'grab' },
  image: { width: '100%', height: '100%', objectFit: 'contain', objectPosition: 'top' },
  placeholder: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', fontSize: '0.6875rem', color: tokens.muted },
});
