import { Children, createContext, forwardRef, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { HTMLAttributes, ReactNode, RefObject } from 'react';
import { Virtuoso } from 'react-virtuoso';
import type { VirtuosoHandle } from 'react-virtuoso';
import * as stylex from '@stylexjs/stylex';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Copy, Check, Code2 } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import type { ChatMessage, UseChat } from './types';
import { tokens } from './tokens.stylex';
import { CITATION_TITLE_PREFIX, formatCitations } from './citations';
import { ICON_STROKE, IconButton, styles as ui } from './ui';
import { VISUAL_MESSAGE_PREFIX, visualDocument, visualTheme } from './visual';
import { Activity } from './Activity';
import { useMessageMenu } from './useMessageMenu';
import { QueuedBubble } from './QueuedMessages';

const markdownPlugins = [remarkGfm];
const highlightPlugins = [rehypeHighlight];
const attachmentPrompt = /^\[첨부 이미지\]\n((?:- .*\n)+)위 이미지를[^\n]*(?:\n\n?)?/;
const initialLocation = { index: 'LAST', align: 'end' } as const;
const PREVIEW_HEIGHT = 'clamp(240px, 62svh, 560px)';
const messageListComponents = { Footer: function ChatBottomSpace() { return <div aria-hidden="true" {...stylex.props(styles.bottomSpace)} />; }, Scroller: forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function ChatScroller({ style, ...props }, ref) {
  return <div {...props} ref={ref} id="chatScroll" role="region" aria-label="Conversation" tabIndex={0} style={style} {...stylex.props(styles.scroller)} />;
}) };

export function messageText(message: ChatMessage) {
  return message.blocks.filter(block => block.type === 'text').map(block => block.text).join('\n');
}

function textContent(node: ReactNode): string {
  return Children.toArray(node).map(child => {
    if (typeof child === 'string' || typeof child === 'number') return String(child);
    if (typeof child === 'object' && 'props' in child) return textContent((child.props as { children?: ReactNode }).children);
    return '';
  }).join('');
}

function CopyButton({ text, notify }: { text: string; notify: (text: string, kind?: 'success' | 'error') => void }) {
  const [isCopied, setCopied] = useState(false);
  useEffect(() => { if (!isCopied) return; const timer = setTimeout(() => setCopied(false), 1800); return () => clearTimeout(timer); }, [isCopied]);
  return <IconButton label={isCopied ? 'Copied' : 'Copy'} onClick={async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); notify('Copied to clipboard', 'success'); }
    catch { notify('Could not copy. Select the text to copy it.', 'error'); }
  }}>{isCopied ? <Check size={18} strokeWidth={ICON_STROKE} /> : <Copy size={18} strokeWidth={ICON_STROKE} />}</IconButton>;
}

function CodeBlock({ children, notify, isIncomplete }: { children: ReactNode; notify: (text: string, kind?: 'success' | 'error') => void; isIncomplete: boolean }) {
  const code = textContent(children);
  const child = Children.toArray(children)[0];
  const language = typeof child === 'object' && 'props' in child ? (child.props as { className?: string }).className?.match(/language-(\S+)/)?.[1] : undefined;
  if (language === 'mermaid') return <Diagram source={code} notify={notify} />;
  if (language === 'visual' || language === 'html') return isIncomplete ? <div {...stylex.props(styles.code)}><div {...stylex.props(styles.codeHeader)}><span>Building visual…</span><CopyButton text={code} notify={notify} /></div><div role="status" {...stylex.props(styles.visual)} /></div> : <Visual source={code} notify={notify} />;
  return <div {...stylex.props(styles.code)}><div {...stylex.props(styles.codeHeader)}><span>{language || 'Text'}</span><CopyButton text={code} notify={notify} /></div><pre role="region" aria-label={(language || 'Text') + ' code'} tabIndex={0}>{children}</pre></div>;
}

function Visual({ source, notify }: { source: string; notify: (text: string, kind?: 'success' | 'error') => void }) {
  const id = useId();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [isSource, setSource] = useState(false);
  const srcDoc = useMemo(() => visualDocument(source, id), [source, id]);
  useEffect(() => {
    const sendTheme = () => frameRef.current?.contentWindow?.postMessage({ type: VISUAL_MESSAGE_PREFIX + 'theme', id, ...visualTheme() }, '*');
    const receive = (event: MessageEvent<unknown>) => {
      if (event.source !== frameRef.current?.contentWindow || typeof event.data !== 'object' || event.data === null) return;
      const data = event.data;
      if (Reflect.get(data, 'id') !== id) return;
      const type = Reflect.get(data, 'type');
      if (type === VISUAL_MESSAGE_PREFIX + 'ready') sendTheme();
    };
    window.addEventListener('message', receive);
    const observer = new MutationObserver(sendTheme);
    observer.observe(window.document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
    sendTheme();
    return () => { window.removeEventListener('message', receive); observer.disconnect(); };
  }, [id]);
  return <div {...stylex.props(styles.code)}><div {...stylex.props(styles.codeHeader)}><button type="button" {...stylex.props(ui.button)} aria-label={isSource ? 'Show visual preview' : 'Show visual source'} onClick={() => setSource(!isSource)}><Code2 size={16} aria-hidden="true" />{isSource ? 'Preview' : 'Source'}</button><CopyButton text={source} notify={notify} /></div>
    <div hidden={isSource}><iframe ref={frameRef} title="HTML visual" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={srcDoc} {...stylex.props(styles.visual)} /></div>
    {isSource && <pre role="region" aria-label="Visual source" tabIndex={0} {...stylex.props(styles.previewSource)}>{source}</pre>}
  </div>;
}

type Mermaid = { initialize: (options: Record<string, unknown>) => void; render: (id: string, source: string) => Promise<{ svg: string }> };
let mermaidPromise: Promise<Mermaid> | undefined;
function loadMermaid() {
  if (!mermaidPromise) mermaidPromise = new Promise<Mermaid>((resolve, reject) => {
    const script = document.createElement('script'); script.src = '/vendor/mermaid.min.js';
    script.onload = () => { const mermaid = (window as Window & { mermaid?: Mermaid }).mermaid; if (mermaid) { mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', fontFamily: 'Wanted Sans Variable, Wanted Sans, sans-serif' }); resolve(mermaid); } else reject(new Error('Diagram unavailable')); };
    script.onerror = () => { script.remove(); mermaidPromise = undefined; reject(new Error('Diagram unavailable')); }; document.head.appendChild(script);
  });
  return mermaidPromise;
}
function Diagram({ source, notify }: { source: string; notify: (text: string, kind?: 'success' | 'error') => void }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [svg, setSvg] = useState(''); const [hasError, setError] = useState(false); const [isSource, setSource] = useState(false);
  useEffect(() => { let isActive = true; setError(false); setSvg('');
    void loadMermaid().then(async mermaid => { await document.fonts.ready; const result = await mermaid.render('diagram' + id, source); if (isActive) setSvg(result.svg); }).catch(() => { if (isActive) setError(true); });
    return () => { isActive = false; };
  }, [source, id]);
  return <div {...stylex.props(styles.code)}><div {...stylex.props(styles.codeHeader)}><button {...stylex.props(ui.button)} onClick={() => setSource(!isSource)}><Code2 size={16} />{isSource ? 'Diagram' : 'Source'}</button><CopyButton text={source} notify={notify} /></div>
    {isSource || hasError ? <pre role="region" aria-label="Diagram source" tabIndex={0} {...stylex.props(styles.previewSource)}>{source}</pre> : svg ? <div role="region" aria-label="Diagram" tabIndex={0} {...stylex.props(styles.diagram)} dangerouslySetInnerHTML={{ __html: svg }} /> : <p role="status" {...stylex.props(ui.muted, styles.diagram)}>Loading diagram…</p>}
  </div>;
}

export function Messages({ chat, listRef, onAtBottomChange, notify, onZoom }: {
  chat: UseChat; listRef: RefObject<VirtuosoHandle | null>; onAtBottomChange: (isAtBottom: boolean) => void; notify: (text: string, kind?: 'success' | 'error') => void; onZoom: (src: string) => void;
}) {
  const { messages, pendingPrompt, liveAssistant, isRunning } = chat;
  const pendingImages = chat.pendingAttachments.map(attachment => attachment.url);
  const shouldReduceMotion = useReducedMotion();
  const sources = [...new Map(messages.flatMap(message => message.sources ?? []).map(source => [source.id, source])).values()];
  const messageById = new Map(messages.map(message => [String(message.seq), message]));
  const { handlers, menu, selectableId } = useMessageMenu(id => {
    if (liveAssistant?.streamId === id) return formatCitations({ text: liveAssistant.text, sources, isStreaming: !liveAssistant.done });
    const message = messageById.get(id);
    if (!message) return '';
    return message.role === 'user' ? messageText(message).replace(attachmentPrompt, '') : formatCitations({ text: messageText(message), sources });
  }, notify);
  const [editingId, setEditingId] = useState<string>();
  const [editText, setEditText] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  function changeExpanded(id: string, isOpen: boolean) { setExpanded(current => current[id] === isOpen ? current : { ...current, [id]: isOpen }); }
  const hasEditor = chat.queuedMessages.some(message => message.id === editingId);
  const queueCountRef = useRef(chat.queuedMessages.length);
  const isFollowingRef = useRef(true);
  const scrollFrameRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(followLatest);
    observer.observe(container);
    return () => { observer.disconnect(); cancelAnimationFrame(scrollFrameRef.current); };
  }, [listRef]);
  const [isFontReady, setFontReady] = useState(false);
  useEffect(() => {
    let isActive = true;
    void Promise.all([document.fonts.load('16px "Wanted Sans Variable"'), document.fonts.load('16px "D2Coding"')]).then(() => document.fonts.ready, () => undefined).then(() => { if (isActive) setFontReady(true); });
    return () => { isActive = false; };
  }, []);
  useLayoutEffect(() => {
    if (pendingPrompt !== undefined || chat.queuedMessages.length > queueCountRef.current) { isFollowingRef.current = true; listRef.current?.scrollToIndex(initialLocation); }
    queueCountRef.current = chat.queuedMessages.length;
  }, [pendingPrompt, chat.queuedMessages.length, listRef]);
  const results = new Map(messages.flatMap(message => message.role === 'toolResult' && message.toolCallId ? [[message.toolCallId, message] as const] : []));
  const callIds = new Set(messages.flatMap(message => message.blocks.flatMap(block => block.type === 'toolCall' && block.id ? [block.id] : [])));
  const groups: ({ kind: 'message'; message: ChatMessage } | { kind: 'activity'; messages: ChatMessage[] } | { kind: 'pending' | 'live' | 'working' | 'paused' } | { kind: 'queue'; index: number })[] = [];
  messages.forEach(message => {
    if (message.role === 'user') { groups.push({ kind: 'message', message }); return; }
    if (message.role === 'toolResult' && message.toolCallId && callIds.has(message.toolCallId)) return;
    const textBlocks = message.blocks.filter(block => block.type === 'text' || block.type === 'image');
    const activities = message.role === 'toolResult' || message.role === 'system' ? message.blocks : message.blocks.filter(block => block.type !== 'text' && block.type !== 'image');
    if (activities.length) {
      const previous = groups.at(-1); const activity = { ...message, blocks: activities };
      if (previous?.kind === 'activity') previous.messages.push(activity); else groups.push({ kind: 'activity', messages: [activity] });
    }
    if (textBlocks.length && message.role !== 'toolResult' && message.role !== 'system') groups.push({ kind: 'message', message: { ...message, blocks: textBlocks } });
  });
  if (pendingPrompt !== undefined) groups.push({ kind: 'pending' });
  if (liveAssistant?.text) groups.push({ kind: 'live' });
  else if (isRunning) groups.push({ kind: 'working' });
  chat.queuedMessages.forEach((_, index) => groups.push({ kind: 'queue', index }));
  if (chat.isQueuePaused) groups.push({ kind: 'paused' });
  return <div ref={containerRef} id="messages" {...stylex.props(styles.messages)} {...handlers} onClickCapture={event => { if (event.target instanceof Element && event.target.closest('summary')) isFollowingRef.current = false; }} onPointerDownCapture={event => { if (event.target instanceof Element && event.target.id === 'chatScroll') isFollowingRef.current = false; }} onWheelCapture={() => { isFollowingRef.current = false; }} onTouchMoveCapture={() => { isFollowingRef.current = false; }} onKeyDownCapture={event => { if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) isFollowingRef.current = false; }}><Virtuoso ref={listRef} data={groups} components={messageListComponents} initialTopMostItemIndex={initialLocation} initialItemCount={8} defaultItemHeight={96} increaseViewportBy={240} atBottomThreshold={2} atBottomStateChange={isAtBottom => { if (isAtBottom) isFollowingRef.current = true; onAtBottomChange(isAtBottom); }} followOutput={false} totalListHeightChanged={followLatest} style={{ height: '100%', visibility: isFontReady ? 'visible' : 'hidden' }} computeItemKey={(_, group) => group.kind === 'message' ? group.message.responseId ?? 'message-' + group.message.seq : group.kind === 'activity' ? 'activity-' + group.messages[0].seq : group.kind === 'queue' ? chat.queuedMessages[group.index].id : group.kind === 'live' ? liveAssistant?.responseId ?? liveAssistant?.streamId ?? 'live' : group.kind} itemContent={(index, group) => <div {...stylex.props(styles.row, group.kind === 'activity' && styles.activityRow, index === 0 && styles.firstRow)}>{renderGroup(group)}</div>} />{menu}</div>;

  function followLatest() {
    cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = requestAnimationFrame(() => {
      const scroller = containerRef.current?.querySelector<HTMLElement>('#chatScroll');
      if (isFollowingRef.current && scroller) listRef.current?.scrollTo({ top: scroller.scrollHeight - scroller.clientHeight, behavior: 'instant' });
    });
  }

  function renderGroup(group: typeof groups[number]) {
    if (group.kind === 'activity') return <Activity messages={group.messages} results={results} onZoom={onZoom} expanded={expanded} onExpandedChange={changeExpanded} />;
    if (group.kind === 'pending') return <article aria-label="Sending message" {...stylex.props(styles.message, styles.user)}>{pendingImages.map(src => <img key={src} src={src} alt="Pending attachment" {...stylex.props(styles.image)} />)}<div {...stylex.props(styles.userText)}>{pendingPrompt}</div></article>;
    if (group.kind === 'live' && liveAssistant) return <article data-message-id={liveAssistant.streamId} data-selectable={selectableId === liveAssistant.streamId} tabIndex={0} aria-haspopup="menu" aria-keyshortcuts="Shift+F10" aria-label="Response" aria-busy={!liveAssistant.done} data-streaming={!liveAssistant.done} {...stylex.props(styles.message)}><ResponseMarkdown text={formatCitations({ text: liveAssistant.text, sources, isStreaming: !liveAssistant.done })} isStreaming={!liveAssistant.done} notify={notify} onZoom={onZoom} /></article>;
    if (group.kind === 'working') return <div role="status" aria-label="Working" {...stylex.props(styles.working)}><motion.span {...stylex.props(styles.pulse)} animate={{ opacity: shouldReduceMotion ? 1 : [.4, 1, .4] }} transition={{ duration: 1.2, repeat: shouldReduceMotion ? 0 : Infinity }} />Working…</div>;
    if (group.kind === 'queue') {
      const message = chat.queuedMessages[group.index];
      return <QueuedBubble message={message} index={group.index} chat={chat} isEditing={editingId === message.id} isAnotherEditing={hasEditor && editingId !== message.id} editText={editText} onEditTextChange={setEditText} onEditingChange={isEditing => { if (isEditing) setEditText(message.prompt); setEditingId(isEditing ? message.id : undefined); }} />;
    }
    if (group.kind === 'paused') return <div role="status" {...stylex.props(styles.working)}>Queue paused<button type="button" {...stylex.props(ui.button)} disabled={chat.isUpdatingQueue} onClick={() => { void chat.resumeQueue(); }}>Resume</button></div>;
    if (group.kind !== 'message') return;
    const message = group.message;
    const raw = messageText(message);
    const attachmentMatch = raw.match(attachmentPrompt);
    const text = message.role === 'user' ? attachmentMatch ? raw.slice(attachmentMatch[0].length) : raw : formatCitations({ text: raw, sources });
    const attachments = attachmentMatch ? attachmentMatch[1].trim().split('\n').flatMap(line => { const match = line.match(/^- (.*) → (.+\/([^/]+))$/); return match ? [{ name: match[1], src: '/api/upload/' + encodeURIComponent(match[3]) }] : []; }) : [];
    return <article key={message.seq} data-message-id={message.seq} data-selectable={selectableId === String(message.seq)} tabIndex={text ? 0 : undefined} aria-haspopup={text ? 'menu' : undefined} aria-keyshortcuts={text ? 'Shift+F10' : undefined} aria-label={message.role === 'user' ? 'Your message' : 'Response'} {...stylex.props(styles.message, message.role === 'user' && styles.user)}>
      {attachments.map(attachment => <button key={attachment.src} {...stylex.props(styles.imageButton)} onClick={() => onZoom(attachment.src)}><img src={attachment.src} alt={attachment.name} {...stylex.props(styles.image)} /></button>)}
      {message.role === 'user' ? <div {...stylex.props(styles.userText)}>{text}</div> : <ResponseMarkdown text={text} notify={notify} onZoom={onZoom} />}
      {message.blocks.filter(block => block.type === 'image').map((block, index) => block.type === 'image' ? <button key={index} {...stylex.props(styles.imageButton)} onClick={() => onZoom('/api/media/' + block.mediaId)}><img src={'/api/media/' + block.mediaId} alt="Attachment" loading="lazy" {...stylex.props(styles.image)} /></button> : undefined)}
    </article>;
  }
}

function ResponseMarkdown({ text, notify, onZoom, isStreaming = false }: { text: string; notify: (text: string, kind?: 'success' | 'error') => void; onZoom: (src: string) => void; isStreaming?: boolean }) {
  return <MarkdownContext value={{ text, notify, onZoom, isStreaming }}><div className="markdown"><ReactMarkdown remarkPlugins={markdownPlugins} rehypePlugins={highlightPlugins} components={markdownComponents}>{text}</ReactMarkdown></div></MarkdownContext>;
}

const MarkdownContext = createContext<{ text: string; isStreaming: boolean; notify: (text: string, kind?: 'success' | 'error') => void; onZoom: (src: string) => void }>({ text: '', isStreaming: false, notify: () => {}, onZoom: () => {} });
const markdownComponents: Components = {
  pre: function MarkdownCode({ children, node }) {
    const { text, notify, isStreaming } = useContext(MarkdownContext);
    return <CodeBlock notify={notify} isIncomplete={isStreaming && !/(?:^|\n)\s*(?:`{3,}|~{3,})\s*$/.test(text.slice(node?.position?.start.offset, node?.position?.end.offset))}>{children}</CodeBlock>;
  },
  table: ({ children }) => <div role="region" aria-label="Response table" tabIndex={0} {...stylex.props(styles.tableScroll)}><table>{children}</table></div>,
  img: function MarkdownImage({ src, alt }) {
    const { onZoom } = useContext(MarkdownContext);
    return <button {...stylex.props(styles.imageButton)} onClick={() => src && onZoom(src)}><img src={src} alt={alt || 'Attachment'} loading="lazy" {...stylex.props(styles.image)} /></button>;
  },
  a: ({ href, children, title }) => <a href={href} title={title} aria-label={title?.startsWith(CITATION_TITLE_PREFIX) ? title : undefined} {...stylex.props(title?.startsWith(CITATION_TITLE_PREFIX) && styles.citation)} target="_blank" rel="noopener noreferrer">{children}</a>,
};

const styles = stylex.create({
  messages: { height: '100%', width: '100%', minWidth: 0 },
  scroller: { overflowX: 'hidden', overflowAnchor: 'none', overscrollBehaviorY: 'contain', scrollbarWidth: 'thin' },
  row: { display: 'flex', flexDirection: 'column', width: '100%', minWidth: 0, maxWidth: 736, margin: '0 auto', padding: '0 max(20px, env(safe-area-inset-right)) 14px max(20px, env(safe-area-inset-left))', alignItems: 'stretch' },
  activityRow: { paddingBottom: 4 },
  firstRow: { paddingTop: 'calc(var(--header-height) + 12px)' },
  bottomSpace: { height: 'var(--composer-height)' },
  message: { minWidth: 0, maxWidth: '100%', flexShrink: 0 },
  user: { alignSelf: 'flex-end', backgroundColor: tokens.bubble, borderRadius: 24, padding: '12px 18px', maxWidth: '88%', fontSize: '1rem', lineHeight: 1.55 },
  userText: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  citation: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 24, minHeight: 24, padding: '0 7px', margin: '0 2px', borderRadius: 12, backgroundColor: { default: tokens.surface, ':hover': tokens.hover }, color: tokens.muted, fontSize: '0.6875rem', fontWeight: 600, lineHeight: 1.3, textDecoration: 'none', verticalAlign: 'middle' },
  code: { minWidth: 0, maxWidth: '100%', borderRadius: 16, borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, overflow: 'hidden', marginTop: 16, marginBottom: 20, backgroundColor: tokens.surface },
  codeHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 6px 2px 16px', borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: tokens.border, fontSize: '0.75rem', color: tokens.muted },
  visual: { display: 'block', width: '100%', height: PREVIEW_HEIGHT, maxWidth: '100%', minWidth: 0, borderWidth: 0, backgroundColor: tokens.canvas },
  previewSource: { height: PREVIEW_HEIGHT, overflow: 'auto' },
  tableScroll: { overflowX: 'auto', maxWidth: '100%', minWidth: 0, overscrollBehaviorX: 'contain', marginTop: 16, marginBottom: 20 },
  imageButton: { borderWidth: 0, padding: 0, backgroundColor: 'transparent', display: 'block', width: '100%', maxWidth: '100%', cursor: 'zoom-in' },
  image: { display: 'block', width: '100%', height: 'clamp(160px, 52vw, 320px)', objectFit: 'contain', borderRadius: 16 },
  diagram: { height: PREVIEW_HEIGHT, margin: 0, padding: 16, overflow: 'auto', maxWidth: '100%', backgroundColor: tokens.mediaWhite },
  working: { display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.875rem', color: tokens.muted, paddingTop: 2 },
  pulse: { display: 'inline-block', width: 8, height: 8, backgroundColor: tokens.text, borderRadius: '50%' },
});
