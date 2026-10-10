import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Copy, TextSelect } from 'lucide-react';
import { tokens } from './tokens.stylex';
import { ICON_STROKE } from './ui';

const MENU_MARGIN = 8;
const LONG_PRESS_MS = 500;
const MOVEMENT_LIMIT = 8;
const INTERACTIVE = 'a, button, input, textarea, select, iframe, pre, code, summary';

export function useMessageMenu(textForMessage: (id: string) => string, notify: (text: string, kind?: 'success' | 'error') => void) {
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<{ text: string; article: HTMLElement } | undefined>(undefined);
  const pressRef = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | undefined>(undefined);
  const [selectableId, setSelectableId] = useState<string>();

  function cancelPress() {
    if (pressRef.current) clearTimeout(pressRef.current.timer);
    pressRef.current = undefined;
  }

  useEffect(() => {
    const close = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      if (event.type === 'pointerdown' && event.target instanceof Node && !selectedRef.current?.article.contains(event.target)) setSelectableId(undefined);
      cancelPress(); menuRef.current?.hidePopover();
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('wheel', close, { passive: true });
    window.addEventListener('resize', close);
    window.visualViewport?.addEventListener('resize', close);
    return () => {
      cancelPress(); window.removeEventListener('pointerdown', close, true); window.removeEventListener('wheel', close);
      window.removeEventListener('resize', close);
      window.visualViewport?.removeEventListener('resize', close);
    };
  }, []);

  function messageAt(target: EventTarget) {
    if (!(target instanceof Element) || target.closest(INTERACTIVE)) return;
    const article = target.closest<HTMLElement>('article[data-message-id]');
    if (!article || article.dataset.messageId === selectableId) return;
    const text = textForMessage(article.dataset.messageId ?? '');
    if (text) return { article, text };
  }

  function openMenu(message: { article: HTMLElement; text: string }, x: number, y: number) {
    cancelPress();
    const menu = menuRef.current;
    if (!menu) return;
    selectedRef.current = message;
    const viewport = window.visualViewport;
    const left = (viewport?.offsetLeft ?? 0) + MENU_MARGIN;
    const top = (viewport?.offsetTop ?? 0) + MENU_MARGIN;
    const right = left + (viewport?.width ?? document.documentElement.clientWidth) - MENU_MARGIN * 2;
    const bottom = top + (viewport?.height ?? innerHeight) - MENU_MARGIN * 2;
    menu.style.left = left + 'px'; menu.style.top = top + 'px';
    menu.style.maxHeight = Math.max(0, bottom - top) + 'px';
    menu.showPopover();
    const box = menu.getBoundingClientRect();
    menu.style.left = Math.max(left, Math.min(x - box.width / 2, right - box.width)) + 'px';
    menu.style.top = Math.max(top, Math.min(y - box.height - MENU_MARGIN < top ? y + MENU_MARGIN : y - box.height - MENU_MARGIN, bottom - box.height)) + 'px';
    menu.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }

  const handlers = {
    onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
      cancelPress();
      if (event.button !== 0 || !event.isPrimary) return;
      const message = messageAt(event.target);
      if (!message) return;
      setSelectableId(undefined);
      const { clientX: x, clientY: y } = event;
      pressRef.current = { x, y, timer: setTimeout(() => openMenu(message, x, y), LONG_PRESS_MS) };
    },
    onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
      const press = pressRef.current;
      if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > MOVEMENT_LIMIT) cancelPress();
    },
    onPointerUp: cancelPress,
    onPointerCancel: cancelPress,
    onPointerLeave: cancelPress,
    onContextMenu(event: ReactMouseEvent<HTMLDivElement>) {
      const message = messageAt(event.target);
      if (!message) return;
      event.preventDefault(); openMenu(message, event.clientX, event.clientY);
    },
    onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
      const message = messageAt(event.target);
      if (!message) return;
      event.preventDefault();
      const box = message.article.getBoundingClientRect();
      openMenu(message, box.left + box.width / 2, box.top);
    },
  };

  const menu = <div ref={menuRef} popover="manual" role="menu" aria-label="Message options" className={[stylex.props(styles.menu).className, 'message-menu'].join(' ')} onKeyDown={event => {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
    const current = buttons.findIndex(button => button === document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); buttons[(current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus(); }
    if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); buttons[event.key === 'Home' ? 0 : buttons.length - 1]?.focus(); }
    if (event.key === 'Tab') { event.currentTarget.hidePopover(); selectedRef.current?.article.focus({ preventScroll: true }); }
    if (event.key === 'Escape') { event.preventDefault(); event.currentTarget.hidePopover(); selectedRef.current?.article.focus({ preventScroll: true }); }
  }}>
    <button type="button" role="menuitem" {...stylex.props(styles.item)} onClick={async () => {
      const selected = selectedRef.current;
      if (!selected) return;
      menuRef.current?.hidePopover();
      selected.article.focus({ preventScroll: true });
      try { await navigator.clipboard.writeText(selected.text); notify('Copied to clipboard', 'success'); }
      catch { notify('Could not copy. Select the text to copy it.', 'error'); }
    }}><Copy size={20} strokeWidth={ICON_STROKE} aria-hidden="true" />Copy</button>
    <button type="button" role="menuitem" {...stylex.props(styles.item)} onClick={() => {
      const selected = selectedRef.current;
      if (!selected) return;
      menuRef.current?.hidePopover(); setSelectableId(selected.article.dataset.messageId);
      selected.article.focus({ preventScroll: true });
      const range = document.createRange(); range.selectNodeContents(selected.article);
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    }}><TextSelect size={20} strokeWidth={ICON_STROKE} aria-hidden="true" />Select text</button>
  </div>;
  return { handlers, menu, selectableId };
}

const styles = stylex.create({
  menu: { position: 'fixed', inset: 'auto', margin: 0, width: 'min(240px, calc(100vw - 16px))', padding: 6, borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, borderRadius: 22, backgroundColor: tokens.surface, color: tokens.text, boxShadow: '0 8px 32px rgb(0 0 0 / .22)', overflowY: 'auto' },
  item: { display: 'flex', alignItems: 'center', gap: 14, width: '100%', minHeight: 48, padding: '0 14px', borderWidth: 0, borderRadius: 16, fontFamily: tokens.font, fontSize: '1rem', color: tokens.text, backgroundColor: { default: 'transparent', ':hover': tokens.hover }, textAlign: 'left' },
});
