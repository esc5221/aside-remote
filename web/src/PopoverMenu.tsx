import { useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import * as stylex from '@stylexjs/stylex';
import { tokens } from './tokens.stylex';

const MENU_MARGIN = 8;

export function PopoverMenu({ anchor, point, label, children, onClose }: {
  anchor: HTMLElement; point?: { x: number; y: number }; label: string; children: ReactNode; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const viewport = window.visualViewport;
    const left = (viewport?.offsetLeft ?? 0) + MENU_MARGIN;
    const top = (viewport?.offsetTop ?? 0) + MENU_MARGIN;
    const right = left + (viewport?.width ?? document.documentElement.clientWidth) - MENU_MARGIN * 2;
    const bottom = top + (viewport?.height ?? innerHeight) - MENU_MARGIN * 2;
    menu.style.maxHeight = Math.max(0, bottom - top) + 'px';
    menu.style.left = left + 'px'; menu.style.top = top + 'px';
    menu.showPopover();
    const box = menu.getBoundingClientRect(); const origin = anchor.getBoundingClientRect();
    const x = point?.x ?? origin.right;
    const above = (point?.y ?? origin.top) - box.height - MENU_MARGIN;
    const below = (point?.y ?? origin.bottom) + MENU_MARGIN;
    menu.style.left = Math.max(left, Math.min(x - box.width, right - box.width)) + 'px';
    menu.style.top = Math.max(top, Math.min(above < top ? below : above, bottom - box.height)) + 'px';
    (menu.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? menu).focus({ preventScroll: true });
    return () => {
      if (menu.matches(':popover-open')) menu.hidePopover();
      requestAnimationFrame(() => {
        if (document.querySelector('dialog[open]') !== anchor.closest('dialog')) return;
        const fallback = document.querySelector<HTMLElement>('dialog[open] button[aria-label="Close conversations"]') ?? document.querySelector<HTMLElement>('button[aria-label="Session options"]');
        (anchor.isConnected ? anchor : fallback)?.focus({ preventScroll: true });
      });
    };
  }, []);
  useLayoutEffect(() => {
    const menu = ref.current;
    if (document.activeElement === menu) menu?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [children]);
  useLayoutEffect(() => {
    const outside = (event: Event) => { if (event.target instanceof Node && !ref.current?.contains(event.target)) onClose(); };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('wheel', outside, { passive: true });
    window.addEventListener('resize', onClose);
    window.visualViewport?.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('pointerdown', outside, true); window.removeEventListener('wheel', outside);
      window.removeEventListener('resize', onClose); window.visualViewport?.removeEventListener('resize', onClose);
    };
  }, [onClose]);
  return createPortal(<div ref={ref} tabIndex={-1} popover="manual" role="menu" aria-label={label} className={[stylex.props(styles.menu).className, 'session-menu'].join(' ')} onKeyDown={event => {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const current = buttons.findIndex(button => button === document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); buttons[(current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus(); }
    if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); buttons[event.key === 'Home' ? 0 : buttons.length - 1]?.focus(); }
    if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); onClose(); }
  }}>{children}</div>, anchor.closest('dialog') ?? document.body);
}

const styles = stylex.create({
  menu: { position: 'fixed', inset: 'auto', margin: 0, width: 'min(268px, calc(100vw - 16px))', padding: 8, borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, borderRadius: 22, backgroundColor: tokens.surface, color: tokens.text, boxShadow: '0 8px 32px rgb(0 0 0 / .22)', overflowY: 'auto' },
});
