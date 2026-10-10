import type { ReactNode, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { X } from 'lucide-react';
import { motion, useDragControls, usePresence, useReducedMotion, type HTMLMotionProps, type PanInfo } from 'motion/react';
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

export function Dialog({ title, children, onClose, isWide = false }: { title: string; children: ReactNode; onClose: () => void; isWide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const closeRequestedRef = useRef(false);
  const isOpenRef = useRef(false);
  const dragControls = useDragControls();
  const [isPresent, safeToRemove] = usePresence();
  const shouldReduceMotion = useReducedMotion();
  const isMobile = useMediaQuery('(max-width: 700px)');
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
        if (document.querySelector('dialog[open]')) return;
        resolveDialogReturnFocus(returnFocusRef.current, title)?.focus({ preventScroll: true });
      });
    };
  }, []);
  function requestClose() {
    if (!isPresent || closeRequestedRef.current) return;
    closeRequestedRef.current = true;
    onClose();
  }
  function finishDrag(_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) {
    if (info.offset.y > 96 || info.velocity.y > 700) requestClose();
  }
  const sheetMotion = shouldReduceMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: .12 } }
    : isMobile
      ? { initial: { y: SHEET_CLOSED_Y, opacity: .98 }, animate: { y: 0, opacity: 1 }, exit: { y: SHEET_CLOSED_Y, opacity: .98 }, transition: { type: 'tween' as const, duration: .32, ease: DIALOG_EASE } }
      : { initial: { opacity: 0, scale: .96, y: 10 }, animate: { opacity: 1, scale: 1, y: 0 }, exit: { opacity: 0, scale: .97, y: 8 }, transition: { duration: .2, ease: DIALOG_EASE } };
  return <motion.dialog ref={ref} tabIndex={-1} data-motion-overlay="" style={{ pointerEvents: isPresent ? 'auto' : 'none' }} {...stylex.props(styles.dialog)} aria-label={title} onKeyDown={trapDialogFocus} onCancel={event => { event.preventDefault(); requestClose(); }}>
    <motion.button type="button" tabIndex={-1} data-overlay-backdrop="" aria-label={`Close ${title}`} {...stylex.props(styles.backdrop)} initial={{ opacity: 0 }} animate={{ opacity: isPresent ? 1 : 0 }} transition={{ duration: shouldReduceMotion ? .1 : .2 }} onClick={requestClose} />
    <motion.div data-dialog-surface="" {...stylex.props(styles.dialogSurface, isWide && styles.wide)} initial={sheetMotion.initial} animate={isPresent ? sheetMotion.animate : sheetMotion.exit} transition={sheetMotion.transition} onAnimationComplete={() => { isOpenRef.current = isPresent; if (!isPresent) safeToRemove?.(); }} drag={!shouldReduceMotion && isMobile ? 'y' : false} dragControls={dragControls} dragListener={false} dragConstraints={{ top: 0, bottom: 0 }} dragElastic={{ top: 0, bottom: .5 }} dragMomentum={false} onDragEnd={finishDrag}>
      <div {...stylex.props(styles.dragHandle)} aria-hidden="true" onPointerDown={event => { if (isOpenRef.current) dragControls.start(event); }}><span {...stylex.props(styles.dragHandleBar)} /></div>
      <div {...stylex.props(styles.dialogBody)}>{children}</div>
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
  iconButton: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, width: 44, height: 44, borderRadius: '50%', borderWidth: 0, padding: 0, backgroundColor: { default: 'transparent', ':hover': tokens.hover }, color: tokens.text },
  outlined: { borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border },
  dialog: { position: 'fixed', inset: 0, width: '100%', height: '100dvh', maxWidth: 'none', maxHeight: 'none', margin: 0, padding: 0, borderWidth: 0, overflow: 'clip', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'transparent', '@media (max-width: 700px)': { alignItems: 'flex-end' } },
  backdrop: { position: 'absolute', inset: 0, width: '100%', height: '100%', padding: 0, borderWidth: 0, backgroundColor: 'rgb(0 0 0 / .28)' },
  dialogSurface: { position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', width: 'calc(100% - 24px)', maxWidth: 420, maxHeight: 'calc(100dvh - 32px)', overflow: 'hidden', borderRadius: 28, backgroundColor: tokens.canvas, boxShadow: '0 12px 60px rgb(0 0 0 / .14)', '@media (max-width: 700px)': { width: '100%', maxWidth: 680, maxHeight: 'calc(100dvh - 8px)', borderBottomLeftRadius: 0, borderBottomRightRadius: 0 } },
  wide: { maxWidth: 680, height: 'min(760px, calc(100dvh - 32px))', '@media (max-width: 700px)': { height: 'min(820px, calc(100dvh - 8px))' } },
  dragHandle: { display: 'none', height: 24, flexShrink: 0, alignItems: 'center', justifyContent: 'center', touchAction: 'none', cursor: 'grab', '@media (max-width: 700px)': { display: 'flex' } },
  dragHandleBar: { width: 36, height: 5, borderRadius: 999, backgroundColor: tokens.controlBorder },
  dialogBody: { padding: 22, maxHeight: 'calc(100dvh - 32px)', overflowY: 'auto', overscrollBehavior: 'contain', minWidth: 0, '@media (max-width: 700px)': { padding: '8px 18px max(18px, env(safe-area-inset-bottom))', maxHeight: 'calc(100dvh - 32px)' } },
  title: { fontSize: '1.3125rem', fontWeight: 650, lineHeight: 1.3, margin: 0 },
  row: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 },
  field: { width: '100%', minWidth: 0, borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, borderRadius: 14, padding: '12px 14px', backgroundColor: tokens.surface, color: tokens.text, fontSize: '1rem', lineHeight: 1.5 },
  button: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, borderRadius: 14, minHeight: 44, padding: '10px 16px', fontSize: '0.875rem', fontWeight: 550, backgroundColor: { default: tokens.canvas, ':hover': tokens.surface }, color: tokens.text },
  primary: { backgroundColor: { default: tokens.text, ':hover': tokens.primaryHover }, color: tokens.canvas, borderColor: tokens.text },
  danger: { color: tokens.danger },
  muted: { fontSize: '0.875rem', lineHeight: 1.6, color: tokens.muted },
});
