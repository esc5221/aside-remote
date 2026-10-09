import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import * as stylex from '@stylexjs/stylex';
import { X } from 'lucide-react';
import { tokens } from './tokens.stylex';

export const ICON_STROKE = 1.8;

export function IconButton({ label, children, isOutlined = false, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode; isOutlined?: boolean }) {
  return <button {...stylex.props(styles.iconButton, isOutlined && styles.outlined)} type="button" aria-label={label} title={label} {...props}>{children}</button>;
}

export function BrowserIcon({ size = 22 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M3 9h18" /><path d="M6.5 6.5h.01M9.5 6.5h.01M12.5 6.5h.01" strokeWidth="2" /></svg>;
}

export function Dialog({ title, children, onClose, isWide = false }: { title: string; children: ReactNode; onClose: () => void; isWide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} {...stylex.props(styles.dialog, isWide && styles.wide)} aria-label={title} onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div {...stylex.props(styles.dialogBody)}>{children}</div>
  </dialog>;
}

export function CloseButton({ onClick }: { onClick: () => void }) { return <IconButton label="Close" onClick={onClick}><X size={22} strokeWidth={ICON_STROKE} /></IconButton>; }

export const styles = stylex.create({
  iconButton: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, width: 44, height: 44, borderRadius: '50%', borderWidth: 0, padding: 0, backgroundColor: { default: 'transparent', ':hover': tokens.hover }, color: tokens.text },
  outlined: { borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border },
  dialog: { borderWidth: 0, borderRadius: 28, padding: 0, width: 'calc(100% - 24px)', maxWidth: 420, maxHeight: 'calc(100dvh - 32px)', overflow: 'hidden', backgroundColor: tokens.canvas, boxShadow: '0 12px 60px rgb(0 0 0 / .14)', '@media (max-width: 700px)': { marginBottom: 'max(12px, env(safe-area-inset-bottom))' } },
  wide: { maxWidth: 680 },
  dialogBody: { padding: 22, maxHeight: 'calc(100dvh - 32px)', overflowY: 'auto', overscrollBehavior: 'contain', minWidth: 0, '@media (max-width: 480px)': { padding: 18 } },
  title: { fontSize: 21, fontWeight: 650, lineHeight: 1.3, margin: 0 },
  row: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 },
  field: { width: '100%', minWidth: 0, borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, borderRadius: 14, padding: '12px 14px', backgroundColor: tokens.surface, color: tokens.text, fontSize: 16, lineHeight: 1.5 },
  button: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, borderRadius: 14, minHeight: 44, padding: '10px 16px', fontSize: 14, fontWeight: 550, backgroundColor: { default: tokens.canvas, ':hover': tokens.surface }, color: tokens.text },
  primary: { backgroundColor: { default: tokens.text, ':hover': tokens.primaryHover }, color: tokens.canvas, borderColor: tokens.text },
  danger: { color: tokens.danger },
  muted: { fontSize: 14, lineHeight: 1.6, color: tokens.muted },
});
