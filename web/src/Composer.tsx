import { useEffect, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { ArrowUp, Plus, Square, X } from 'lucide-react';
import { tokens } from './tokens.stylex';
import { ICON_STROKE, BrowserIcon, IconButton } from './ui';
import type { UploadAttachment, UseChat } from './types';

type Attachment = { key: string; preview: string; name: string; upload?: UploadAttachment; hasError?: boolean };
const MAX_ATTACHMENTS = 6;

export function Composer({ chat, onBrowser, draft, setDraft, revision, notify }: {
  chat: UseChat; onBrowser: () => void; draft: string; setDraft: (value: string) => void; revision: number; notify: (text: string, kind?: 'error' | 'success') => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const attachmentRef = useRef<Attachment[]>([]);
  const revisionRef = useRef(revision);
  useEffect(() => { attachmentRef.current = attachments; }, [attachments]);
  useEffect(() => {
    if (!chat.recoveredAttachments.length) return;
    const restored = chat.recoveredAttachments.map(upload => ({ key: crypto.randomUUID(), preview: upload.url, name: upload.name, upload }));
    setAttachments(current => [...current, ...restored].slice(0, MAX_ATTACHMENTS));
  }, [chat.recoveredAttachments]);
  useEffect(() => {
    revisionRef.current = revision;
    attachmentRef.current.forEach(attachment => URL.revokeObjectURL(attachment.preview));
    attachmentRef.current = []; setAttachments([]);
    input.current?.focus({ preventScroll: true });
  }, [revision]);
  useEffect(() => () => attachmentRef.current.forEach(attachment => URL.revokeObjectURL(attachment.preview)), []);
  useEffect(() => { if (input.current) { input.current.style.height = 'auto'; input.current.style.height = Math.min(input.current.scrollHeight, 160) + 'px'; } }, [draft]);
  const hasUploadPending = attachments.some(attachment => !attachment.upload && !attachment.hasError);
  const canSend = chat.isReady && !chat.authError && !chat.isOpening && !chat.isSending && !hasUploadPending && (draft.trim().length > 0 || attachments.some(attachment => attachment.upload));

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
    if (chat.isRunning) { if (!chat.isSending) await chat.abort(); return; }
    if (!canSend) return;
    const sentDraft = draft; const sentRevision = revisionRef.current;
    const accepted = await chat.send(sentDraft, attachments.flatMap(attachment => attachment.upload ? [attachment.upload] : []));
    if (!accepted || sentRevision !== revisionRef.current) return;
    setDraft('');
    attachmentRef.current.forEach(attachment => URL.revokeObjectURL(attachment.preview));
    attachmentRef.current = []; setAttachments([]);
  }

  return <footer id="composer" {...stylex.props(styles.footer)}>
    <form {...stylex.props(styles.composer)} onSubmit={event => { event.preventDefault(); void submit(); }} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void addFiles([...event.dataTransfer.files]); }}>
      {attachments.length > 0 && <div {...stylex.props(styles.attachments)}>{attachments.map(attachment => <div key={attachment.key} {...stylex.props(styles.attachment)}>
        <img src={attachment.preview} alt={attachment.name} {...stylex.props(styles.thumbnail)} />
        {!attachment.upload && <span {...stylex.props(styles.uploadState)}>{attachment.hasError ? 'Failed' : 'Uploading…'}</span>}
        <button type="button" {...stylex.props(styles.remove)} aria-label={'Remove ' + attachment.name} onClick={() => { URL.revokeObjectURL(attachment.preview); setAttachments(current => current.filter(item => item.key !== attachment.key)); }}><X size={14} strokeWidth={2} /></button>
      </div>)}</div>}
      <textarea ref={input} id="draft" aria-label="Message" placeholder={chat.authError ? 'Connect in Settings' : 'Message'} rows={1} value={draft} disabled={chat.isSending} {...stylex.props(styles.input)} onChange={event => setDraft(event.target.value)} onPaste={event => { const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); void addFiles(files); } }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && matchMedia('(pointer: fine)').matches) { event.preventDefault(); void submit(); } }} />
      <div {...stylex.props(styles.actions)}><div {...stylex.props(styles.leftActions)}><IconButton isOutlined label="Add photos" disabled={chat.isSending || !chat.isReady || !!chat.authError} onClick={() => fileInput.current?.click()}><Plus size={24} strokeWidth={ICON_STROKE} /></IconButton>
        <button type="button" {...stylex.props(styles.browser)} onClick={onBrowser}><BrowserIcon size={17} /><span>Browser</span></button></div>
        <button type="submit" id="send" aria-label={chat.isSending ? 'Starting response' : chat.isRunning ? 'Stop response' : 'Send message'} title={chat.isRunning ? 'Stop response' : 'Send message'} disabled={chat.isSending || (!chat.isRunning && !canSend)} {...stylex.props(styles.send)}>{chat.isRunning && !chat.isSending ? <Square size={14} fill="currentColor" /> : <ArrowUp size={22} strokeWidth={2.2} />}</button>
      </div>
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
  footer: { flexShrink: 0, width: '100%', backgroundColor: tokens.canvas, padding: '4px 20px max(16px, env(safe-area-inset-bottom))', '@media (max-width: 700px)': { paddingLeft: 'max(12px, env(safe-area-inset-left))', paddingRight: 'max(12px, env(safe-area-inset-right))' } },
  composer: { width: '100%', maxWidth: 768, margin: '0 auto', borderRadius: 28, backgroundColor: tokens.surface, borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, padding: '14px 8px 7px', minWidth: 0 },
  input: { display: 'block', width: '100%', resize: 'none', borderWidth: 0, backgroundColor: 'transparent', color: tokens.text, fontSize: 16, lineHeight: 1.5, minHeight: 28, maxHeight: 160, overflowY: 'auto', overflowWrap: 'anywhere', padding: '0 10px 4px', '::placeholder': { color: tokens.muted } },
  actions: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 4 },
  leftActions: { display: 'flex', alignItems: 'center', gap: 4 },
  browser: { display: 'flex', alignItems: 'center', gap: 7, minHeight: 38, padding: '0 12px', borderWidth: 1, borderStyle: 'solid', borderColor: tokens.controlBorder, borderRadius: 24, backgroundColor: { default: tokens.canvas, ':hover': tokens.hover }, color: tokens.text, fontSize: 13, fontWeight: 500 },
  send: { width: 38, height: 38, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', borderWidth: 0, backgroundColor: tokens.text, color: tokens.canvas, marginRight: 4, flexShrink: 0 },
  attachments: { display: 'flex', gap: 10, overflowX: 'auto', padding: '0 10px 10px', maxWidth: '100%', minWidth: 0 },
  attachment: { position: 'relative', width: 72, height: 72, flexShrink: 0 },
  thumbnail: { width: '100%', height: '100%', objectFit: 'cover', borderRadius: 14 },
  remove: { position: 'absolute', right: -4, top: -4, width: 28, height: 28, borderRadius: '50%', color: tokens.canvas, backgroundColor: tokens.text, borderWidth: 2, borderStyle: 'solid', borderColor: tokens.surface, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  uploadState: { position: 'absolute', left: 0, bottom: 0, width: '100%', borderRadius: '0 0 14px 14px', padding: 5, backgroundColor: 'rgb(0 0 0 / .6)', color: tokens.mediaWhite, fontSize: 10, textAlign: 'center' },
});
