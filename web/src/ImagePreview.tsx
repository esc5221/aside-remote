import { useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { animate, motion, useMotionValue, useReducedMotion } from 'motion/react';
import { Minus, Plus, X } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { tokens } from './tokens.stylex';
import { Dialog, IconButton, ICON_STROKE } from './ui';
import { OPEN_IN_BROWSER_LABEL } from './browser';

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const ZOOM_STEP = 1.5;
const KEYBOARD_PAN_STEP = 48;
const PERCENT_SCALE = 100;
const SWIPE_THRESHOLD = 8;

export function ImagePreview({ src, title = 'Image', url, kind = 'image', onClose }: { src: string; title?: string; url?: string; kind?: 'image' | 'browser'; onClose: () => void }) {
  const isBrowser = kind === 'browser';
  const dialogTitle = isBrowser ? 'Browser preview' : 'Image';
  const viewerRef = useRef<HTMLElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const pointersRef = useRef<{ id: number; x: number; y: number; isViewport: boolean }[]>([]);
  const gestureRef = useRef<{ x: number; y: number; distance: number; scale: number; offsetX: number; offsetY: number; mode: 'pending' | 'pan' | 'dismiss'; canDismiss: boolean; lastY: number; time: number; velocity: number } | undefined>(undefined);
  const isDismissingRef = useRef(false);
  const swipeY = useMotionValue(0);
  const shouldReduceMotion = useReducedMotion();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const scale = useMotionValue(MIN_ZOOM);
  const [zoom, setZoom] = useState(MIN_ZOOM * PERCENT_SCALE);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => applyTransform(scale.get(), x.get(), y.get()));
    observer.observe(viewport);
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomAt(scale.get() * Math.exp(-event.deltaY * .002), event.clientX, event.clientY);
    };
    viewport.addEventListener('wheel', wheel, { passive: false });
    return () => { swipeY.stop(); observer.disconnect(); viewport.removeEventListener('wheel', wheel); };
  }, [scale, x, y, swipeY]);

  return <Dialog title={dialogTitle} isFullScreen swipeY={swipeY} onClose={onClose}>
    <section ref={viewerRef} {...stylex.props(styles.viewer)}
        onPointerDown={event => {
          if (isDismissingRef.current || event.button !== 0 || pointersRef.current.length >= 2 || event.target instanceof Element && event.target.closest('button, a')) return;
          swipeY.stop();
          swipeY.set(0);
          event.currentTarget.setPointerCapture(event.pointerId);
          pointersRef.current.push({ id: event.pointerId, x: event.clientX, y: event.clientY, isViewport: event.target instanceof Node && !!viewportRef.current?.contains(event.target) });
          beginGesture();
        }} onPointerMove={event => {
          const pointer = pointersRef.current.find(point => point.id === event.pointerId);
          const gesture = gestureRef.current;
          if (!pointer || !gesture) return;
          pointer.x = event.clientX; pointer.y = event.clientY;
          const current = readPointers();
          const dx = current.x - gesture.x;
          const dy = current.y - gesture.y;
          if (gesture.mode === 'pending') {
            if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_THRESHOLD) return;
            gesture.mode = gesture.canDismiss && dy > Math.abs(dx) ? 'dismiss' : 'pan';
          }
          if (gesture.mode === 'dismiss') {
            const now = performance.now();
            gesture.velocity = (current.y - gesture.lastY) / Math.max(1, now - gesture.time) * 1000;
            gesture.lastY = current.y; gesture.time = now;
            swipeY.set(Math.max(0, dy));
            return;
          }
          if (!pointersRef.current.every(point => point.isViewport)) return;
          const nextScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, gesture.distance ? gesture.scale * current.distance / gesture.distance : gesture.scale));
          const ratio = nextScale / gesture.scale;
          const bounds = viewportRef.current!.getBoundingClientRect();
          applyTransform(nextScale, current.x - bounds.left - bounds.width / 2 - (gesture.x - bounds.left - bounds.width / 2 - gesture.offsetX) * ratio, current.y - bounds.top - bounds.height / 2 - (gesture.y - bounds.top - bounds.height / 2 - gesture.offsetY) * ratio);
        }} onPointerUp={endGesture} onPointerCancel={endGesture} onLostPointerCapture={endGesture}
      >
      <header {...stylex.props(styles.header)}><div {...stylex.props(styles.identity)}><h2 {...stylex.props(styles.title)}>{title}</h2>{url && <a href={url} target="_blank" rel="noopener noreferrer external" aria-label={OPEN_IN_BROWSER_LABEL} {...stylex.props(styles.url)}>{url}</a>}</div><IconButton label={`Close ${dialogTitle.toLowerCase()}`} onClick={onClose}><X size={22} strokeWidth={ICON_STROKE} /></IconButton></header>
      <div ref={viewportRef} role="region" aria-label={isBrowser ? 'Zoomable browser view' : 'Zoomable image'} aria-description="Pinch to zoom, drag to move. Swipe down at 100% or from the title to close. Use plus and minus to zoom, arrow keys to move, or zero to reset." tabIndex={0} {...stylex.props(styles.viewport)}
        onKeyDown={event => {
          if (event.key === '+' || event.key === '=') zoomAt(scale.get() * ZOOM_STEP);
          else if (event.key === '-') zoomAt(scale.get() / ZOOM_STEP);
          else if (event.key === '0') applyTransform(MIN_ZOOM, 0, 0);
          else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) applyTransform(scale.get(), x.get() + (event.key === 'ArrowLeft' ? KEYBOARD_PAN_STEP : event.key === 'ArrowRight' ? -KEYBOARD_PAN_STEP : 0), y.get() + (event.key === 'ArrowUp' ? KEYBOARD_PAN_STEP : event.key === 'ArrowDown' ? -KEYBOARD_PAN_STEP : 0));
          else return;
          event.preventDefault(); event.stopPropagation();
        }}>
        <motion.img ref={imageRef} src={src} alt={isBrowser ? `Current view of ${title}` : 'Expanded attachment'} draggable={false} {...stylex.props(styles.image)} style={{ x, y, scale }} onLoad={() => applyTransform(scale.get(), x.get(), y.get())} />
      </div>
      <footer {...stylex.props(styles.controls)}><IconButton label="Zoom out" disabled={zoom === MIN_ZOOM * PERCENT_SCALE} onClick={() => zoomAt(scale.get() / ZOOM_STEP)}><Minus size={22} strokeWidth={ICON_STROKE} /></IconButton><button type="button" aria-label={`Reset zoom, ${zoom}%`} {...stylex.props(styles.reset)} onClick={() => applyTransform(MIN_ZOOM, 0, 0)}>{zoom}%</button><IconButton label="Zoom in" disabled={zoom === MAX_ZOOM * PERCENT_SCALE} onClick={() => zoomAt(scale.get() * ZOOM_STEP)}><Plus size={22} strokeWidth={ICON_STROKE} /></IconButton></footer>
    </section>
  </Dialog>;

  function applyTransform(nextScale: number, nextX: number, nextY: number) {
    const viewport = viewportRef.current;
    const image = imageRef.current;
    if (!viewport || !image) return;
    const clampedScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextScale));
    const fit = image.naturalWidth && image.naturalHeight ? Math.min(viewport.clientWidth / image.naturalWidth, viewport.clientHeight / image.naturalHeight) : 1;
    const limitX = Math.max(0, (image.naturalWidth * fit * clampedScale - viewport.clientWidth) / 2);
    const limitY = Math.max(0, (image.naturalHeight * fit * clampedScale - viewport.clientHeight) / 2);
    scale.set(clampedScale);
    x.set(Math.max(-limitX, Math.min(limitX, nextX)));
    y.set(Math.max(-limitY, Math.min(limitY, nextY)));
    setZoom(Math.round(clampedScale * PERCENT_SCALE));
  }

  function zoomAt(nextScale: number, clientX?: number, clientY?: number) {
    const bounds = viewportRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const anchorX = clientX === undefined ? 0 : clientX - bounds.left - bounds.width / 2;
    const anchorY = clientY === undefined ? 0 : clientY - bounds.top - bounds.height / 2;
    const ratio = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextScale)) / scale.get();
    applyTransform(nextScale, anchorX - (anchorX - x.get()) * ratio, anchorY - (anchorY - y.get()) * ratio);
  }

  function readPointers() {
    const [first, second = first] = pointersRef.current;
    return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2, distance: Math.hypot(first.x - second.x, first.y - second.y) };
  }

  function beginGesture(isContinuing = false) {
    const pointers = pointersRef.current;
    gestureRef.current = pointers.length ? { ...readPointers(), scale: scale.get(), offsetX: x.get(), offsetY: y.get(), mode: isContinuing || pointers.length > 1 ? 'pan' : 'pending', canDismiss: pointers.length === 1 && (!pointers[0].isViewport || scale.get() === MIN_ZOOM), lastY: pointers[0].y, time: performance.now(), velocity: 0 } : undefined;
  }

  function endGesture(event: ReactPointerEvent<HTMLElement>) {
    if (!pointersRef.current.some(point => point.id === event.pointerId)) return;
    const gesture = gestureRef.current;
    pointersRef.current = pointersRef.current.filter(point => point.id !== event.pointerId);
    if (!pointersRef.current.length && gesture?.mode === 'dismiss') {
      const offset = swipeY.get();
      const height = viewerRef.current?.clientHeight ?? window.innerHeight;
      const shouldClose = event.type === 'pointerup' && (offset > Math.min(160, height * .2) || offset > 40 && performance.now() - gesture.time < 100 && gesture.velocity > 900);
      if (shouldClose) {
        isDismissingRef.current = true;
        if (shouldReduceMotion) onClose();
        else animate(swipeY, height, { duration: .2, ease: [.22, 1, .36, 1], onComplete: onClose });
      } else if (shouldReduceMotion) swipeY.set(0);
      else animate(swipeY, 0, { type: 'spring', stiffness: 420, damping: 40 });
    }
    beginGesture(true);
  }
}

const styles = stylex.create({
  viewer: { display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0, overflow: 'hidden', backgroundColor: tokens.canvas, touchAction: 'none' },
  header: { display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0, padding: 'max(8px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) 8px max(16px, env(safe-area-inset-left))' },
  identity: { minWidth: 0, flex: 1 },
  title: { margin: 0, fontSize: '0.9375rem', lineHeight: 1.4, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  url: { display: 'block', fontSize: '0.6875rem', lineHeight: 1.5, color: tokens.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: 'none' },
  viewport: { flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden', position: 'relative', touchAction: 'none', overscrollBehavior: 'none', cursor: 'grab' },
  image: { display: 'block', width: '100%', height: '100%', objectFit: 'contain', touchAction: 'none', pointerEvents: 'none', willChange: 'transform' },
  controls: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, flexShrink: 0, padding: '8px 12px max(12px, env(safe-area-inset-bottom))' },
  reset: { minWidth: 64, minHeight: 44, borderWidth: 0, borderRadius: 22, backgroundColor: tokens.surface, color: tokens.text, fontSize: '0.8125rem', fontVariantNumeric: 'tabular-nums' },
});
