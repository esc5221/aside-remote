import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { ArrowUp, Plus, Square, X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { tokens } from './tokens.stylex';
import { ICON_STROKE, BrowserIcon, IconButton, styles as ui } from './ui';
import type { UploadAttachment, UseChat } from './types';
import { ModelPicker, useModelSelection } from './ModelPicker';

type Attachment = { key: string; preview: string; name: string; upload?: UploadAttachment; hasError?: boolean };
const MAX_ATTACHMENTS = 6;
const COMPACT_DRAFT_HEIGHT = 28;
const MAX_DRAFT_HEIGHT = 160;

export function Composer({ chat, onBrowser, draft, setDraft, revision, notify, textSize, isKeyboardOpen }: {
  chat: UseChat; onBrowser: () => void; draft: string; setDraft: (value: string) => void; revision: number; notify: (text: string, kind?: 'error' | 'success') => void; textSize: number; isKeyboardOpen: boolean;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const footerRef = useRef<HTMLElement>(null);
  const modelSelection = useModelSelection(chat, notify);
  const shouldReduceMotion = useReducedMotion();
  const fileInput = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [hasFocus, setFocus] = useState(false);
  const isExpanded = isKeyboardOpen || hasFocus && matchMedia('(pointer: fine)').matches;
  const attachmentRef = useRef<Attachment[]>([]);
  const draftRef = useRef(draft);
  // A touch submits before iOS can blur the input; its later click must not send again or activate the replacement Stop button.
  const isTouchSubmissionRef = useRef(false);
  const pendingPreviewRevokesRef = useRef<string[]>([]);
  const revisionRef = useRef(revision);
  useEffect(() => { draftRef.current = draft; }, [draft]);
  useEffect(() => { attachmentRef.current = attachments; }, [attachments]);
  useEffect(() => {
    if (!chat.recoveredAttachments.length) return;
    const restored = chat.recoveredAttachments.map(upload => ({ key: crypto.randomUUID(), preview: upload.url, name: upload.name, upload }));
    setAttachments(current => [...current, ...restored].slice(0, MAX_ATTACHMENTS));
  }, [chat.recoveredAttachments]);
  useEffect(() => {
    revisionRef.current = revision;
    pendingPreviewRevokesRef.current.push(...attachmentRef.current.map(attachment => attachment.preview));
    attachmentRef.current = []; setAttachments([]);
    if (!document.querySelector('dialog[open]')) input.current?.focus({ preventScroll: true });
  }, [revision]);
  useEffect(() => () => [...attachmentRef.current.map(attachment => attachment.preview), ...pendingPreviewRevokesRef.current].forEach(preview => URL.revokeObjectURL(preview)), []);
  function resizeInput() { if (input.current) { input.current.style.height = 'auto'; input.current.style.height = Math.min(input.current.scrollHeight, MAX_DRAFT_HEIGHT) + 'px'; } }
  useLayoutEffect(resizeInput, [draft, textSize, isExpanded]);
  useLayoutEffect(() => {
    const footer = footerRef.current;
    if (!footer) return;
    const updateHeight = () => footer.parentElement?.style.setProperty('--composer-height', footer.getBoundingClientRect().height + 'px');
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(footer);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const area = input.current; if (!area) return;
    let width = area.clientWidth;
    const observer = new ResizeObserver(() => { if (area.clientWidth !== width) { width = area.clientWidth; resizeInput(); } });
    observer.observe(area); return () => observer.disconnect();
  }, [isExpanded]);
  const hasUploadPending = attachments.some(attachment => !attachment.upload && !attachment.hasError);
  const hasInput = draft.length > 0 || attachments.length > 0;
  const hasDraftContent = draft.trim().length > 0 || attachments.some(attachment => attachment.upload);
  const canSubmit = chat.isReady && !chat.authError && !chat.isOpening && !modelSelection.isUpdating && (!!chat.sessionId || !!modelSelection.current) && !hasUploadPending && hasDraftContent;
  const shouldQueue = chat.isRunning || chat.queuedMessages.length > 0;
  function flushPreviewRevokes() { pendingPreviewRevokesRef.current.splice(0).forEach(preview => URL.revokeObjectURL(preview)); }

  async function addFiles(files: File[]) {
    const imageFiles = files.filter(file => file.type.startsWith('image/'));
    if (imageFiles.length !== files.length) notify('Choose an image file.', 'error');
    const remaining = MAX_ATTACHMENTS - attachmentRef.current.length;
    if (imageFiles.length > remaining) notify('You can attach up to 6 images.', 'error');
    const generation = revisionRef.current;
    for (const file of imageFiles.slice(0, remaining)) {
      const key = crypto.randomUUID(); const preview = URL.createObjectURL(file);
      const slot = { key, preview, name: file.name };
      attachmentRef.current = [...attachmentRef.current, slot]; setAttachments(attachmentRef.current);
      try {
        const upload = await chat.upload(await resizeImage(file));
        if (generation !== revisionRef.current) { URL.revokeObjectURL(preview); continue; }
        setAttachments(current => current.map(attachment => attachment.key === key ? { ...attachment, upload } : attachment));
      } catch {
        if (generation === revisionRef.current) {
          notify('Could not prepare this image. Try another image.', 'error');
          setAttachments(current => current.map(attachment => attachment.key === key ? { ...attachment, hasError: true } : attachment));
        }
      }
    }
  }

  async function submit() {
    if (!canSubmit) return;
    const sentDraft = draft; const sentRevision = revisionRef.current;
    const sentAttachments = attachmentRef.current;
    const uploads = sentAttachments.flatMap(attachment => attachment.upload ? [attachment.upload] : []);
    draftRef.current = ''; setDraft('');
    attachmentRef.current = []; setAttachments([]);
    input.current?.blur();
    const accepted = shouldQueue ? await chat.queue(sentDraft, uploads) : await chat.send(sentDraft, uploads, modelSelection.current);
    if (sentRevision !== revisionRef.current) return;
    if (!accepted) {
      attachmentRef.current = [...sentAttachments, ...attachmentRef.current].slice(0, MAX_ATTACHMENTS); setAttachments(attachmentRef.current);
      if (sentDraft) {
        const restoredDraft = draftRef.current ? sentDraft + '\n\n' + draftRef.current : sentDraft;
        draftRef.current = restoredDraft; setDraft(restoredDraft);
      }
      return;
    }
    const sentKeys = new Set(sentAttachments.map(attachment => attachment.key));
    pendingPreviewRevokesRef.current.push(...sentAttachments.map(attachment => attachment.preview));
    attachmentRef.current = attachmentRef.current.filter(attachment => !sentKeys.has(attachment.key));
    setAttachments(attachmentRef.current);
  }

  return <footer ref={footerRef} id="composer" {...stylex.props(styles.footer, isExpanded && styles.expandedFooter)} onFocusCapture={() => setFocus(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocus(false); }}>
    <div {...stylex.props(styles.tools)}>
      <motion.button type="button" aria-haspopup="dialog" aria-label="Open browser" {...stylex.props(styles.browser)} whileTap={shouldReduceMotion ? undefined : { scale: .96 }} onPointerDown={event => { if (event.pointerType === 'touch') event.preventDefault(); }} onClick={onBrowser}><BrowserIcon size={17} /><span>Browser</span></motion.button>
      <ModelPicker selection={modelSelection} disabled={!chat.isReady || chat.isOpening || chat.isSending || !!chat.authError} isRunning={chat.isRunning} />
    </div>
    <form {...stylex.props(styles.composer, isExpanded && styles.expandedComposer)} onSubmit={event => { event.preventDefault(); void submit(); }} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void addFiles([...event.dataTransfer.files]); }}>
      <AnimatePresence initial={false} onExitComplete={flushPreviewRevokes}>
        {attachments.length > 0 && <motion.div key="attachments" {...stylex.props(styles.attachments)} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 82 }} exit={{ opacity: 0, height: 0 }} transition={{ duration: .18 }}>
          <AnimatePresence initial={false} onExitComplete={flushPreviewRevokes}>{attachments.map(attachment => <motion.div layout key={attachment.key} {...stylex.props(styles.attachment)} initial={{ opacity: 0, scale: .86, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: .84, y: -6 }} transition={{ duration: .18, ease: [0.22, 1, 0.36, 1] }}>
            <img src={attachment.preview} alt={attachment.name} {...stylex.props(styles.thumbnail)} />
            {!attachment.upload && <span role="status" aria-label={attachment.name + (attachment.hasError ? ' failed to upload' : ' uploading')} {...stylex.props(styles.uploadState)}>{attachment.hasError ? 'Failed' : 'Uploading…'}</span>}
            <motion.button type="button" {...stylex.props(styles.remove)} whileTap={{ scale: .86 }} aria-label={'Remove ' + attachment.name} onClick={() => { pendingPreviewRevokesRef.current.push(attachment.preview); attachmentRef.current = attachmentRef.current.filter(item => item.key !== attachment.key); setAttachments(attachmentRef.current); }}><X size={14} strokeWidth={2} /></motion.button>
          </motion.div>)}</AnimatePresence>
        </motion.div>}
      </AnimatePresence>
      <IconButton label="Add photos" style={{ width: 36, height: 36 }} disabled={!chat.isReady || chat.isOpening || !!chat.authError} onClick={() => fileInput.current?.click()}><Plus size={24} strokeWidth={ICON_STROKE} /></IconButton>
      <textarea ref={input} id="draft" aria-label="Message" placeholder={chat.authError ? 'Connect in Settings' : chat.isRunning ? 'Follow up' : 'Message'} rows={1} value={draft} disabled={!chat.isReady || chat.isOpening || !!chat.authError} {...stylex.props(styles.input, isExpanded && styles.expandedInput)} onChange={event => { draftRef.current = event.target.value; setDraft(event.target.value); }} onPaste={event => { const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); void addFiles(files); } }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && matchMedia('(pointer: fine)').matches) { event.preventDefault(); void submit(); } }} />
      <div {...stylex.props(styles.submitActions)}>{chat.isRunning && !hasInput
        ? <motion.button key="stop" type="button" aria-label={chat.isStopping ? 'Stopping response' : 'Stop response'} title="Stop response" disabled={chat.isStopping} aria-busy={chat.isStopping} whileTap={shouldReduceMotion ? undefined : { scale: .88 }} {...stylex.props(styles.stop)} onPointerDown={event => { isTouchSubmissionRef.current = false; if (event.pointerType === 'touch') event.preventDefault(); }} onClick={event => { if (event.detail === 0 || !isTouchSubmissionRef.current) void chat.abort(); }}><Square size={13} fill="currentColor" /></motion.button>
        : <motion.button key="send" type="submit" id="send" aria-label={shouldQueue ? 'Queue message' : chat.isSending ? 'Starting response' : 'Send message'} title={shouldQueue ? 'Queue message' : 'Send message'} disabled={!canSubmit} whileTap={shouldReduceMotion ? undefined : { scale: .88 }} {...stylex.props(styles.send)} onPointerDown={event => { isTouchSubmissionRef.current = event.pointerType === 'touch'; if (isTouchSubmissionRef.current) { event.preventDefault(); void submit(); } }} onClick={event => { if (isTouchSubmissionRef.current && event.detail > 0) event.preventDefault(); }}><ArrowUp size={22} strokeWidth={2.2} /></motion.button>}</div>
      <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={event => { void addFiles([...event.target.files || []]); event.target.value = ''; }} />
    </form>
  </footer>;
}

async function resizeImage(file: File) {
  const image = new Image(); const url = URL.createObjectURL(file);
  try {
    image.src = url; await image.decode();
    const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
    if (scale === 1 || file.type === 'image/gif') return file;
    const canvas = document.createElement('canvas'); canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
    const context = canvas.getContext('2d'); if (!context) throw new Error('Image processing unavailable'); context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const mime = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error('Image processing failed')), mime, 0.85));
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + (mime === 'image/jpeg' ? '.jpg' : '.png'), { type: blob.type });
  } finally { URL.revokeObjectURL(url); }
}

const styles = stylex.create({
  footer: { position: 'absolute', bottom: 0, left: 0, width: '100%', zIndex: 3, pointerEvents: 'none', padding: '6px max(32px, env(safe-area-inset-right)) var(--composer-bottom-padding, max(18px, env(safe-area-inset-bottom))) max(32px, env(safe-area-inset-left))', '@media (max-width: 375px)': { paddingLeft: 20, paddingRight: 20 } },
  expandedFooter: { paddingLeft: 'max(16px, env(safe-area-inset-left))', paddingRight: 'max(16px, env(safe-area-inset-right))' },
  tools: { display: 'var(--composer-tools-display, none)', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 10, minWidth: 0 },
  composer: { display: 'grid', gridTemplateColumns: '40px minmax(0, 1fr) auto', alignItems: 'center', width: '100%', maxWidth: 736, margin: '0 auto', borderRadius: 28, backgroundColor: tokens.surface, borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, padding: '2px 4px', minWidth: 0, pointerEvents: 'auto' },
  expandedComposer: { borderRadius: 28, padding: 8 },
  input: { display: 'block', width: '100%', resize: 'none', borderWidth: 0, backgroundColor: 'transparent', color: tokens.text, fontSize: '1rem', lineHeight: 1.5, minHeight: COMPACT_DRAFT_HEIGHT, maxHeight: MAX_DRAFT_HEIGHT, overflowY: 'auto', overflowWrap: 'anywhere', padding: '2px 4px', '::placeholder': { color: tokens.muted } },
  expandedInput: { order: -1, gridColumn: '1 / -1', minHeight: 44, padding: '8px 10px 12px' },
  browser: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, minHeight: 38, padding: '0 12px', borderWidth: 1, borderStyle: 'solid', borderColor: tokens.controlBorder, borderRadius: 24, backgroundColor: { default: tokens.canvas, ':hover': tokens.hover }, color: tokens.text, fontSize: '0.8125rem', fontWeight: 500, pointerEvents: 'auto' },
  submitActions: { display: 'flex', gridColumn: 3, alignItems: 'center', gap: 4, minWidth: 0 },
  stop: { width: 38, height: 38, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderStyle: 'solid', borderColor: tokens.primary, backgroundColor: tokens.primary, color: tokens.primaryForeground, flexShrink: 0 },
  send: { width: 38, height: 38, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', borderWidth: 0, backgroundColor: tokens.primary, color: tokens.primaryForeground, flexShrink: 0 },
  attachments: { order: -2, gridColumn: '1 / -1', display: 'flex', gap: 10, overflowX: 'auto', padding: '0 10px 10px', maxWidth: '100%', minWidth: 0 },
  attachment: { position: 'relative', width: 72, height: 72, flexShrink: 0 },
  thumbnail: { width: '100%', height: '100%', objectFit: 'cover', borderRadius: 14 },
  remove: { position: 'absolute', right: -4, top: -4, width: 28, height: 28, borderRadius: '50%', color: tokens.canvas, backgroundColor: tokens.text, borderWidth: 2, borderStyle: 'solid', borderColor: tokens.surface, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  uploadState: { position: 'absolute', left: 0, bottom: 0, width: '100%', borderRadius: '0 0 14px 14px', padding: 5, backgroundColor: 'rgb(0 0 0 / .6)', color: tokens.mediaWhite, fontSize: '0.625rem', textAlign: 'center' },
});
