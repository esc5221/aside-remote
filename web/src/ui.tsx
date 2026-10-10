import type { ReactNode, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { X } from 'lucide-react';
import { motion, usePresence, useReducedMotion, useTransform, type HTMLMotionProps, type MotionValue } from 'motion/react';
import { tokens } from './tokens.stylex';

export const ICON_STROKE = 1.8;
export const SESSION_MENU_LABEL = 'Session options';
export const SESSION_MENU_TITLE = 'Session';
const DIALOG_EASE = [0.22, 1, 0.36, 1] as const;
const SHEET_CLOSED_Y = '100%';

export function IconButton({ label, children, isOutlined = false, ...props }: HTMLMotionProps<'button'> & { label: string; children: ReactNode; isOutlined?: boolean }) {
  const shouldReduceMotion = useReducedMotion();
  return <motion.button {...stylex.props(styles.iconButton, isOutlined && styles.outlined)} type="button" aria-label={label} title={label} whileTap={shouldReduceMotion ? undefined : { scale: .92 }} {...props}>{children}</motion.button>;
}

export function BrowserIcon({ size = 22 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M3 9h18" /><path d="M6.5 6.5h.01M9.5 6.5h.01M12.5 6.5h.01" strokeWidth="2" /></svg>;
}

export function Dialog({ title, children, onClose, isWide = false, isFullScreen = false, swipeY }: { title: string; children: ReactNode; onClose: () => void; isWide?: boolean; isFullScreen?: boolean; swipeY?: MotionValue<number> }) {
  const ref = useRef<HTMLDialogElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const closeRequestedRef = useRef(false);
  const isOpenRef = useRef(false);
  const hasDraggedRef = useRef(false);
  const [isPresent, safeToRemove] = usePresence();
  const shouldReduceMotion = useReducedMotion();
  const swipeProgress = useTransform(() => Math.min(1, (swipeY?.get() ?? 0) / window.innerHeight));
  const swipeScale = useTransform(swipeProgress, [0, 1], [1, .85]);
  const swipeRadius = useTransform(swipeProgress, [0, .2], [0, 28]);
  const backdropOpacity = useTransform(swipeProgress, [0, 1], [1, 0]);
  const isMobile = useMediaQuery('(max-width: 700px)');
  const closeFromSwipe = useEffectEvent(requestClose);
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || !isMobile || isFullScreen) return;
    let dragOffset = 0;
    let gesture: { id: number; x: number; y: number; lastY: number; time: number; velocity: number; isDragging: boolean } | undefined;
    function restore() {
      gesture = undefined;
      if (isOpenRef.current && surface) {
        dragOffset = 0;
        surface.style.removeProperty('translate');
      }
    }
    function start(event: TouchEvent) {
      if (event.touches.length !== 1) { if (gesture) restore(); return; }
      gesture = undefined;
      hasDraggedRef.current = false;
      const target = event.target;
      if (!surface || !isOpenRef.current || !(target instanceof Element) || target.closest('dialog') !== ref.current || target.closest('input, textarea, select, [contenteditable="true"], iframe, [data-selectable="true"]')) return;
      for (let element: Element | null = target; element && element !== surface; element = element.parentElement) {
        if (element.scrollTop > 0 && /^(auto|scroll)$/.test(getComputedStyle(element).overflowY)) return;
      }
      dragOffset = 0;
      surface.style.removeProperty('translate');
      const touch = event.touches[0];
      gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, lastY: touch.clientY, time: performance.now(), velocity: 0, isDragging: false };
    }
    function move(event: TouchEvent) {
      if (!gesture) return;
      const touch = [...event.touches].find(touch => touch.identifier === gesture?.id);
      if (!touch) { restore(); return; }
      const dy = touch.clientY - gesture.y;
      if (!gesture.isDragging) {
        if (dy > Math.abs(touch.clientX - gesture.x) && event.cancelable) event.preventDefault();
        if (Math.max(Math.abs(touch.clientX - gesture.x), Math.abs(dy)) < 8) return;
        if (dy <= Math.abs(touch.clientX - gesture.x) || !event.cancelable) { gesture = undefined; return; }
        gesture.isDragging = true;
        hasDraggedRef.current = true;
      }
      event.preventDefault();
      const now = performance.now();
      gesture.velocity = (touch.clientY - gesture.lastY) / Math.max(1, now - gesture.time) * 1000;
      gesture.lastY = touch.clientY; gesture.time = now;
      dragOffset = Math.max(0, dy);
      if (surface) surface.style.translate = `0 ${dragOffset}px`;
    }
    function finish() {
      if (!gesture) return;
      const shouldClose = gesture.isDragging && (dragOffset > 96 || performance.now() - gesture.time < 80 && gesture.velocity > 700);
      if (shouldClose) { gesture = undefined; closeFromSwipe(); }
      else restore();
    }
    surface.addEventListener('touchstart', start, { passive: true });
    surface.addEventListener('touchmove', move, { passive: false });
    surface.addEventListener('touchend', finish);
    surface.addEventListener('touchcancel', restore);
    return () => {
      surface.removeEventListener('touchstart', start); surface.removeEventListener('touchmove', move); surface.removeEventListener('touchend', finish); surface.removeEventListener('touchcancel', restore);
      surface.style.removeProperty('translate');
    };
  }, [isMobile, isFullScreen]);
  useLayoutEffect(() => {
    isOpenRef.current = false;
    if (isPresent) closeRequestedRef.current = false;
  }, [isPresent]);
  useLayoutEffect(() => {
    const dialog = ref.current;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) {
      dialog.showModal();
      focusDialogSurface(dialog);
    }
    return () => {
      if (dialog?.open) dialog.close();
      requestAnimationFrame(() => {
        const remaining = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].at(-1);
        if (remaining) {
          const captured = returnFocusRef.current;
          if (captured?.isConnected && remaining.contains(captured)) captured.focus({ preventScroll: true });
          else focusDialogSurface(remaining);
          return;
        }
        resolveDialogReturnFocus(returnFocusRef.current, title)?.focus({ preventScroll: true });
      });
    };
  }, []);
  function requestClose() {
    if (!isPresent || closeRequestedRef.current) return;
    closeRequestedRef.current = true;
    onClose();
  }
  const sheetMotion = shouldReduceMotion || isFullScreen
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: .12 } }
    : isMobile
      ? { initial: { y: SHEET_CLOSED_Y, opacity: .98 }, animate: { y: 0, opacity: 1 }, exit: { y: SHEET_CLOSED_Y, opacity: .98 }, transition: { type: 'tween' as const, duration: .32, ease: DIALOG_EASE } }
      : { initial: { opacity: 0, scale: .96, y: 10 }, animate: { opacity: 1, scale: 1, y: 0 }, exit: { opacity: 0, scale: .97, y: 8 }, transition: { duration: .2, ease: DIALOG_EASE } };
  return <motion.dialog ref={ref} tabIndex={-1} data-motion-overlay="" style={{ pointerEvents: isPresent ? 'auto' : 'none' }} {...stylex.props(styles.dialog)} aria-label={title} onKeyDown={event => { trapDialogFocus(event); event.stopPropagation(); }} onCancel={event => { event.preventDefault(); event.stopPropagation(); requestClose(); }}>
    <motion.button type="button" tabIndex={-1} data-overlay-backdrop="" aria-label={`Close ${title}`} {...stylex.props(styles.backdrop)} style={swipeY ? { opacity: backdropOpacity } : undefined} initial={swipeY ? false : { opacity: 0 }} animate={swipeY ? undefined : { opacity: isPresent ? 1 : 0 }} transition={{ duration: shouldReduceMotion ? .1 : .2 }} onClick={requestClose} />
    <motion.div ref={surfaceRef} data-dialog-surface="" {...stylex.props(styles.dialogSurface, isWide && styles.wide, isFullScreen && styles.fullSurface)} style={swipeY ? { y: swipeY, scale: swipeScale, borderRadius: swipeRadius } : undefined} initial={sheetMotion.initial} animate={isPresent ? sheetMotion.animate : sheetMotion.exit} transition={sheetMotion.transition} onAnimationComplete={() => { isOpenRef.current = isPresent; if (!isPresent) safeToRemove?.(); }} onClickCapture={event => { if (hasDraggedRef.current) { event.preventDefault(); event.stopPropagation(); hasDraggedRef.current = false; } }}>
      {!isFullScreen && <div {...stylex.props(styles.dragHandle)} aria-hidden="true"><span {...stylex.props(styles.dragHandleBar)} /></div>}
      <div {...stylex.props(styles.dialogBody, isFullScreen && styles.fullBody)}>{children}</div>
    </motion.div>
  </motion.dialog>;
}

export function CloseButton({ onClick }: { onClick: () => void }) { return <IconButton label="Close" onClick={onClick}><X size={22} strokeWidth={ICON_STROKE} /></IconButton>; }

export function DialogBackdropReset() {
  return <style>{'dialog[data-motion-overlay]::backdrop{background:transparent!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important}'}</style>;
}

export function focusDialogSurface(dialog: HTMLDialogElement) {
  const active = document.activeElement;
  if (active instanceof HTMLElement && dialog.contains(active) && active.hasAttribute('autofocus')) return;
  const autoFocusTarget = dialog.querySelector<HTMLElement>('[data-dialog-surface] [autofocus]');
  const closeTarget = dialog.querySelector<HTMLElement>('[data-dialog-surface] button[aria-label="Close"]:not([disabled]), [data-dialog-surface] button[aria-label^="Close "]:not([disabled])');
  const fallbackTarget = dialog.querySelector<HTMLElement>('[data-dialog-surface] button:not([disabled]), [data-dialog-surface] input:not([disabled]), [data-dialog-surface] textarea:not([disabled]), [data-dialog-surface] select:not([disabled]), [data-dialog-surface] [tabindex]:not([tabindex="-1"])');
  const target = autoFocusTarget ?? closeTarget ?? fallbackTarget;
  (target ?? dialog).focus({ preventScroll: true });
}

export function trapDialogFocus(event: ReactKeyboardEvent<HTMLDialogElement>) {
  if (event.key !== 'Tab') return;
  const dialog = event.currentTarget;
  const targets = [...dialog.querySelectorAll<HTMLElement>('button:not([data-overlay-backdrop]), a[href], input, textarea, select, summary, [tabindex]')]
    .filter(target => target.tabIndex >= 0 && !target.matches(':disabled') && target.getClientRects().length && getComputedStyle(target).visibility === 'visible');
  const first = targets[0]; const last = targets.at(-1); const active = document.activeElement;
  if (!first || !last) { event.preventDefault(); dialog.focus(); return; }
  if (active === dialog || !dialog.contains(active) || (event.shiftKey ? active === first : active === last)) {
    event.preventDefault(); (event.shiftKey ? last : first).focus({ preventScroll: false });
  }
}

export function resolveDialogReturnFocus(captured: HTMLElement | null, title: string) {
  const preferredLabel = title === 'Browser' ? 'Open browser' : title === SESSION_MENU_TITLE ? SESSION_MENU_LABEL : 'Open conversations';
  return [captured,
    document.querySelector<HTMLElement>(`button[aria-label="${preferredLabel}"]`),
    document.querySelector<HTMLElement>('button[aria-label="New chat"]'),
  ].find(isAvailable);

  function isAvailable(target: HTMLElement | null): target is HTMLElement {
    if (!target?.isConnected || target.matches(':disabled') || !target.getClientRects().length) return false;
    if (target.tabIndex < 0 && !target.hasAttribute('tabindex')) return false;
    const style = getComputedStyle(target);
    return style.visibility !== 'hidden' && style.visibility !== 'collapse';
  }
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query);
    const update = () => setMatches(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
}

export const styles = stylex.create({
  glass: { backgroundColor: tokens.glass, borderWidth: 1, borderStyle: 'solid', borderColor: tokens.glassBorder, backdropFilter: 'blur(20px) saturate(160%)', boxShadow: tokens.glassShadow },
  iconButton: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, width: 44, height: 44, borderRadius: '50%', borderWidth: 0, padding: 0, backgroundColor: { default: 'transparent', ':hover': tokens.hover }, color: tokens.text },
  outlined: { borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border },
  dialog: { position: 'fixed', inset: 0, width: '100%', height: '100dvh', maxWidth: 'none', maxHeight: 'none', margin: 0, padding: 0, borderWidth: 0, overflow: 'clip', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'transparent', '@media (max-width: 700px)': { alignItems: 'flex-end' } },
  backdrop: { position: 'absolute', inset: 0, width: '100%', height: '100%', padding: 0, borderWidth: 0, backgroundColor: 'rgb(0 0 0 / .28)' },
  dialogSurface: { position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', width: 'calc(100% - 24px)', maxWidth: 420, maxHeight: 'calc(100dvh - 32px)', overflow: 'hidden', borderRadius: 28, backgroundColor: tokens.canvas, boxShadow: '0 12px 60px rgb(0 0 0 / .14)', '@media (max-width: 700px)': { width: '100%', maxWidth: 680, maxHeight: 'calc(100dvh - 8px)', borderBottomLeftRadius: 0, borderBottomRightRadius: 0 } },
  wide: { maxWidth: 680, height: 'min(760px, calc(100dvh - 32px))', '@media (max-width: 700px)': { height: 'min(820px, calc(100dvh - 8px))' } },
  fullSurface: { width: '100%', maxWidth: 'none', height: '100%', maxHeight: '100%', borderRadius: 0, '@media (max-width: 700px)': { maxWidth: 'none', maxHeight: '100%', borderRadius: 0 } },
  fullBody: { display: 'flex', flex: 1, minHeight: 0, padding: 0, maxHeight: 'none', overflow: 'hidden', '@media (max-width: 700px)': { padding: 0, maxHeight: 'none' } },
  dragHandle: { display: 'none', height: 24, flexShrink: 0, alignItems: 'center', justifyContent: 'center', touchAction: 'none', cursor: 'grab', '@media (max-width: 700px)': { display: 'flex' } },
  dragHandleBar: { width: 36, height: 5, borderRadius: 999, backgroundColor: tokens.controlBorder },
  dialogBody: { padding: 22, maxHeight: 'calc(100dvh - 32px)', overflowY: 'auto', overscrollBehavior: 'contain', minWidth: 0, '@media (max-width: 700px)': { padding: '8px 18px max(18px, env(safe-area-inset-bottom))', maxHeight: 'calc(100dvh - 32px)' } },
  title: { fontSize: '1.3125rem', fontWeight: 650, lineHeight: 1.3, margin: 0 },
  row: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 },
  field: { width: '100%', minWidth: 0, borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, borderRadius: 14, padding: '12px 14px', backgroundColor: tokens.surface, color: tokens.text, fontSize: '1rem', lineHeight: 1.5 },
  button: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, borderRadius: 14, minHeight: 44, padding: '10px 16px', fontSize: '0.875rem', fontWeight: 550, backgroundColor: { default: tokens.canvas, ':hover': tokens.surface }, color: tokens.text },
  primary: { backgroundColor: { default: tokens.primary, ':hover': tokens.primaryHover }, color: tokens.primaryForeground, borderColor: tokens.primary },
  danger: { color: tokens.danger },
  muted: { fontSize: '0.875rem', lineHeight: 1.6, color: tokens.muted },
});
