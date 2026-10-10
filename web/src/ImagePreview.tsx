import { useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { motion, useMotionValue } from 'motion/react';
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

export function ImagePreview({ src, title = 'Image', url, kind = 'image', onClose }: { src: string; title?: string; url?: string; kind?: 'image' | 'browser'; onClose: () => void }) {
  const isBrowser = kind === 'browser';
  const dialogTitle = isBrowser ? 'Browser preview' : 'Image';
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const pointersRef = useRef<{ id: number; x: number; y: number }[]>([]);
  const gestureRef = useRef<{ x: number; y: number; distance: number; scale: number; offsetX: number; offsetY: number } | undefined>(undefined);
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
    return () => { observer.disconnect(); viewport.removeEventListener('wheel', wheel); };
  }, [scale, x, y]);

  return <Dialog title={dialogTitle} isFullScreen onClose={onClose}>
    <section {...stylex.props(styles.viewer)}>
      <header {...stylex.props(styles.header)}><div {...stylex.props(styles.identity)}><h2 {...stylex.props(styles.title)}>{title}</h2>{url && <a href={url} target="_blank" rel="noopener noreferrer external" aria-label={OPEN_IN_BROWSER_LABEL} {...stylex.props(styles.url)}>{url}</a>}</div><IconButton label={`Close ${dialogTitle.toLowerCase()}`} onClick={onClose}><X size={22} strokeWidth={ICON_STROKE} /></IconButton></header>
      <div ref={viewportRef} role="region" aria-label={isBrowser ? 'Zoomable browser view' : 'Zoomable image'} aria-description="Pinch to zoom, drag to move. Use plus and minus to zoom, arrow keys to move, or zero to reset." tabIndex={0} {...stylex.props(styles.viewport)}
        onPointerDown={event => {
          if (event.button !== 0 || pointersRef.current.length >= 2) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          pointersRef.current.push({ id: event.pointerId, x: event.clientX, y: event.clientY });
          beginGesture();
        }} onPointerMove={event => {
          const pointer = pointersRef.current.find(point => point.id === event.pointerId);
          const gesture = gestureRef.current;
          if (!pointer || !gesture) return;
          pointer.x = event.clientX; pointer.y = event.clientY;
          const current = readPointers();
          const nextScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, gesture.distance ? gesture.scale * current.distance / gesture.distance : gesture.scale));
          const ratio = nextScale / gesture.scale;
          const bounds = event.currentTarget.getBoundingClientRect();
          applyTransform(nextScale, current.x - bounds.left - bounds.width / 2 - (gesture.x - bounds.left - bounds.width / 2 - gesture.offsetX) * ratio, current.y - bounds.top - bounds.height / 2 - (gesture.y - bounds.top - bounds.height / 2 - gesture.offsetY) * ratio);
        }} onPointerUp={endGesture} onPointerCancel={endGesture} onLostPointerCapture={endGesture}
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

  function beginGesture() {
    gestureRef.current = pointersRef.current.length ? { ...readPointers(), scale: scale.get(), offsetX: x.get(), offsetY: y.get() } : undefined;
  }

  function endGesture(event: ReactPointerEvent<HTMLDivElement>) {
    pointersRef.current = pointersRef.current.filter(point => point.id !== event.pointerId);
    beginGesture();
  }
}

const styles = stylex.create({
  viewer: { display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0, overflow: 'hidden', backgroundColor: tokens.canvas },
  header: { display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0, padding: 'max(8px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) 8px max(16px, env(safe-area-inset-left))' },
  identity: { minWidth: 0, flex: 1 },
  title: { margin: 0, fontSize: '0.9375rem', lineHeight: 1.4, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  url: { display: 'block', fontSize: '0.6875rem', lineHeight: 1.5, color: tokens.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: 'none' },
  viewport: { flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden', position: 'relative', touchAction: 'none', overscrollBehavior: 'none', cursor: 'grab' },
  image: { display: 'block', width: '100%', height: '100%', objectFit: 'contain', touchAction: 'none', pointerEvents: 'none', willChange: 'transform' },
  controls: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, flexShrink: 0, padding: '8px 12px max(12px, env(safe-area-inset-bottom))' },
  reset: { minWidth: 64, minHeight: 44, borderWidth: 0, borderRadius: 22, backgroundColor: tokens.surface, color: tokens.text, fontSize: '0.8125rem', fontVariantNumeric: 'tabular-nums' },
});
