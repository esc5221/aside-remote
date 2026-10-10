import { useEffect, useId, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { CornerDownRight, Ellipsis, ListEnd, Pencil, Trash2 } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { QueuedMessage, UseChat } from './types';
import { tokens } from './tokens.stylex';
import { ICON_STROKE } from './ui';

const MENU_MARGIN = 8;
const MENU_WIDTH = 268;

export function QueuedMessages({ chat }: { chat: UseChat }) {
  const [editingId, setEditingId] = useState<string>();
  const hasEditor = chat.queuedMessages.some(message => message.id === editingId);
  return <section aria-label="Queued messages" {...stylex.props(styles.messages)}>
    <AnimatePresence initial={false}>{chat.queuedMessages.map((message, index) => <QueuedBubble key={message.id} message={message} index={index} chat={chat} isEditing={editingId === message.id} isAnotherEditing={hasEditor && editingId !== message.id} onEditingChange={isEditing => setEditingId(isEditing ? message.id : undefined)} />)}</AnimatePresence>
    {chat.isQueuePaused && <div role="status" {...stylex.props(styles.paused)}>Queue paused<button type="button" {...stylex.props(styles.textButton)} disabled={chat.isUpdatingQueue} onClick={() => { void chat.resumeQueue(); }}>Resume</button></div>}
  </section>;
}

function QueuedBubble({ message, index, chat, isEditing, isAnotherEditing, onEditingChange }: { message: QueuedMessage; index: number; chat: UseChat; isEditing: boolean; isAnotherEditing: boolean; onEditingChange: (isEditing: boolean) => void }) {
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [isMenuOpen, setMenuOpen] = useState(false);
  const [editText, setEditText] = useState(message.prompt);
  const [isActing, setActing] = useState(false);
  const actionRef = useRef(false);
  const shouldReduceMotion = useReducedMotion();
  const isBusy = isActing || chat.isUpdatingQueue || message.status === 'sending' || isAnotherEditing;
  const isHeldElsewhere = message.isEditing && !isEditing;
  const label = `Queued message ${index + 1}`;

  useEffect(() => { if (isEditing) inputRef.current?.focus({ preventScroll: true }); }, [isEditing]);
  useEffect(() => {
    if (!isMenuOpen) return;
    const close = () => menuRef.current?.hidePopover();
    window.addEventListener('resize', close);
    const scroll = document.getElementById('chatScroll');
    scroll?.addEventListener('wheel', close, { passive: true });
    scroll?.addEventListener('touchmove', close, { passive: true });
    return () => { window.removeEventListener('resize', close); scroll?.removeEventListener('wheel', close); scroll?.removeEventListener('touchmove', close); };
  }, [isMenuOpen]);

  function openMenu() {
    const menu = menuRef.current; const trigger = triggerRef.current;
    if (!menu || !trigger) return;
    if (menu.matches(':popover-open')) { menu.hidePopover(); return; }
    const anchor = trigger.getBoundingClientRect();
    const viewport = window.visualViewport;
    const viewportTop = (viewport?.offsetTop ?? 0) + MENU_MARGIN;
    const viewportBottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight) - MENU_MARGIN;
    const viewportWidth = viewport?.width ?? document.documentElement.clientWidth;
    menu.style.left = Math.max(MENU_MARGIN, Math.min(anchor.right - MENU_WIDTH, viewportWidth - MENU_WIDTH - MENU_MARGIN)) + 'px';
    menu.style.top = viewportTop + 'px';
    menu.style.maxHeight = Math.max(0, viewportBottom - viewportTop) + 'px';
    menu.showPopover();
    const box = menu.getBoundingClientRect();
    menu.style.left = Math.max(MENU_MARGIN, Math.min(anchor.right - box.width, viewportWidth - box.width - MENU_MARGIN)) + 'px';
    const preferredTop = anchor.top - box.height - MENU_MARGIN;
    menu.style.top = Math.max(viewportTop, Math.min(preferredTop < viewportTop ? anchor.bottom + MENU_MARGIN : preferredTop, viewportBottom - box.height)) + 'px';
    menu.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }

  async function runAction(action: 'edit' | 'cancel' | 'save' | 'steer' | 'delete') {
    if (isBusy || actionRef.current) return;
    actionRef.current = true; setActing(true);
    menuRef.current?.hidePopover();
    try {
      if (action === 'edit') {
        if (await chat.beginEditQueuedMessage(message.id)) { setEditText(message.prompt); onEditingChange(true); }
      } else if (action === 'save') {
        if (await chat.editQueuedMessage(message.id, editText, message.attachments)) onEditingChange(false);
      } else if (action === 'cancel') {
        if (await chat.cancelEditQueuedMessage(message.id)) onEditingChange(false);
      } else if (action === 'steer') {
        await chat.steerQueuedMessage(message.id);
      } else {
        await chat.deleteQueuedMessage(message.id);
      }
    } finally { actionRef.current = false; setActing(false); }
  }

  return <motion.article aria-label={label} {...stylex.props(styles.message)} initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: .16 }}>
    <div {...stylex.props(styles.meta)}><ListEnd size={17} strokeWidth={ICON_STROKE} aria-hidden="true" /><span>{message.status === 'sending' ? 'Sending…' : isEditing || isHeldElsewhere ? 'Editing…' : message.status === 'error' ? 'Not sent' : 'Queued'}</span>
      <button ref={triggerRef} type="button" aria-label={`Options for ${label.toLowerCase()}`} aria-haspopup="menu" aria-expanded={isMenuOpen} aria-controls={menuId} disabled={isBusy || !!isHeldElsewhere || isEditing} {...stylex.props(styles.menuTrigger)} onClick={openMenu}><Ellipsis size={20} strokeWidth={ICON_STROKE} aria-hidden="true" /></button>
    </div>
    <div {...stylex.props(styles.bubble, isEditing && styles.editBubble)}>
      {message.attachments.length > 0 && <div {...stylex.props(styles.attachments)}>{message.attachments.map(attachment => <img key={attachment.id} src={attachment.url} alt={attachment.name} {...stylex.props(styles.image)} />)}</div>}
      {isEditing ? <><textarea ref={inputRef} aria-label={`Edit ${label.toLowerCase()}`} rows={3} value={editText} disabled={isBusy} {...stylex.props(styles.editInput)} onChange={event => setEditText(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); void runAction('cancel'); } }} /><div {...stylex.props(styles.editActions)}><button type="button" disabled={isBusy} {...stylex.props(styles.textButton)} onClick={() => { void runAction('cancel'); }}>Cancel</button><button type="button" disabled={isBusy || (!editText.trim() && !message.attachments.length)} {...stylex.props(styles.textButton, styles.saveButton)} onClick={() => { void runAction('save'); }}>{isActing ? 'Saving…' : 'Save'}</button></div></> : message.prompt}
    </div>
    {message.status === 'error' && <p role="alert" {...stylex.props(styles.error)}>{message.error || 'Could not send. Edit or try again.'}</p>}
    <div ref={menuRef} id={menuId} popover="auto" role="menu" aria-label={`Options for ${label.toLowerCase()}`} className={[stylex.props(styles.menu).className, 'queued-message-menu'].join(' ')} onToggle={event => setMenuOpen(event.currentTarget.matches(':popover-open'))} onKeyDown={event => {
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const current = buttons.findIndex(button => button === document.activeElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); buttons[(current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus(); }
      if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); buttons[event.key === 'Home' ? 0 : buttons.length - 1]?.focus(); }
      if (event.key === 'Escape') { event.preventDefault(); event.currentTarget.hidePopover(); triggerRef.current?.focus({ preventScroll: true }); }
    }}>
      <p {...stylex.props(styles.menuTitle)}>{message.prompt || 'Attached images'}</p>
      <button type="button" role="menuitem" disabled={isBusy || !!isHeldElsewhere} {...stylex.props(styles.menuItem)} onClick={() => { void runAction('edit'); }}><Pencil size={20} strokeWidth={ICON_STROKE} aria-hidden="true" />Edit message</button>
      <button type="button" role="menuitem" disabled={isBusy || !!isHeldElsewhere} {...stylex.props(styles.menuItem)} onClick={() => { void runAction('steer'); }}><CornerDownRight size={20} strokeWidth={ICON_STROKE} aria-hidden="true" />{chat.isRunning ? 'Steer instead' : 'Send now'}</button>
      <button type="button" role="menuitem" disabled={isBusy} {...stylex.props(styles.menuItem, styles.danger)} onClick={() => { void runAction('delete'); }}><Trash2 size={20} strokeWidth={ICON_STROKE} aria-hidden="true" />Cancel message</button>
    </div>
  </motion.article>;
}

const styles = stylex.create({
  messages: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 22, minWidth: 0, width: '100%', paddingTop: 22, ':empty': { display: 'none' } },
  message: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', minWidth: 0, maxWidth: '88%', gap: 8 },
  meta: { display: 'flex', alignItems: 'center', gap: 6, color: tokens.muted, fontSize: '0.8125rem', paddingRight: 3 },
  menuTrigger: { display: 'grid', placeItems: 'center', width: 32, height: 32, borderWidth: 0, borderRadius: 12, padding: 0, color: tokens.muted, backgroundColor: { default: 'transparent', ':hover': tokens.hover } },
  bubble: { backgroundColor: tokens.bubble, borderRadius: 24, padding: '12px 18px', minWidth: 0, maxWidth: '100%', fontSize: '1rem', lineHeight: 1.55, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  editBubble: { width: 'min(540px, 100%)' },
  editInput: { display: 'block', width: '100%', maxHeight: 160, minHeight: 72, resize: 'none', padding: 0, borderWidth: 0, color: tokens.text, backgroundColor: 'transparent', fontFamily: tokens.font, fontSize: '1rem', lineHeight: 1.55, overflowWrap: 'anywhere' },
  editActions: { display: 'flex', justifyContent: 'flex-end', gap: 4, marginTop: 8 },
  textButton: { minHeight: 36, padding: '0 12px', borderWidth: 0, borderRadius: 18, backgroundColor: 'transparent', color: tokens.text, fontSize: '0.8125rem', fontFamily: tokens.font, fontWeight: 600 },
  saveButton: { backgroundColor: tokens.text, color: tokens.canvas },
  attachments: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  image: { width: 100, maxWidth: '100%', height: 100, objectFit: 'cover', borderRadius: 16 },
  error: { margin: 0, fontSize: '0.8125rem', color: tokens.danger, overflowWrap: 'anywhere' },
  paused: { display: 'flex', alignItems: 'center', gap: 4, color: tokens.muted, fontSize: '0.8125rem' },
  menu: { position: 'fixed', inset: 'auto', margin: 0, width: 'min(268px, calc(100vw - 16px))', padding: 8, borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, borderRadius: 24, backgroundColor: tokens.surface, color: tokens.text, boxShadow: '0 10px 40px rgb(0 0 0 / .24)', overflowY: 'auto', overflowX: 'hidden' },
  menuTitle: { margin: '4px 12px 8px', maxWidth: '100%', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', color: tokens.muted, fontSize: '0.8125rem' },
  menuItem: { display: 'flex', alignItems: 'center', gap: 14, width: '100%', minHeight: 48, padding: '0 12px', borderWidth: 0, borderRadius: 16, fontFamily: tokens.font, fontSize: '1rem', color: tokens.text, backgroundColor: { default: 'transparent', ':hover': tokens.hover }, textAlign: 'left' },
  danger: { color: tokens.danger },
});
