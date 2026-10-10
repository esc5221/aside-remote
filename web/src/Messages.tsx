import { Children, createContext, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { ChevronRight, Copy, Check, Code2 } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { ChatMessage, LiveAssistant } from './types';
import { tokens } from './tokens.stylex';
import { CITATION_TITLE_PREFIX, formatCitations } from './citations';
import { ICON_STROKE, IconButton, styles as ui } from './ui';
import { VISUAL_MESSAGE_PREFIX, visualDocument, visualTheme } from './visual';

const markdownPlugins = [remarkGfm];
const highlightPlugins = [rehypeHighlight];

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
  if (language === 'visual' || language === 'html') return isIncomplete ? <p role="status" {...stylex.props(ui.muted)}>Building visual…</p> : <Visual source={code} notify={notify} />;
  return <div {...stylex.props(styles.code)}><div {...stylex.props(styles.codeHeader)}><span>{language || 'Text'}</span><CopyButton text={code} notify={notify} /></div><pre role="region" aria-label={(language || 'Text') + ' code'} tabIndex={0}>{children}</pre></div>;
}

function Visual({ source, notify }: { source: string; notify: (text: string, kind?: 'success' | 'error') => void }) {
  const id = useId();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(240);
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
      const nextHeight = Reflect.get(data, 'height');
      if (type === VISUAL_MESSAGE_PREFIX + 'resize' && typeof nextHeight === 'number' && Number.isFinite(nextHeight)) setHeight(Math.max(120, Math.min(12_000, nextHeight)));
    };
    window.addEventListener('message', receive);
    const observer = new MutationObserver(sendTheme);
    observer.observe(window.document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
    sendTheme();
    return () => { window.removeEventListener('message', receive); observer.disconnect(); };
  }, [id]);
  return <div {...stylex.props(styles.code)}><div {...stylex.props(styles.codeHeader)}><button type="button" {...stylex.props(ui.button)} aria-label={isSource ? 'Show visual preview' : 'Show visual source'} onClick={() => setSource(!isSource)}><Code2 size={16} aria-hidden="true" />{isSource ? 'Preview' : 'Source'}</button><CopyButton text={source} notify={notify} /></div>
    <div hidden={isSource}><iframe ref={frameRef} title="HTML visual" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={srcDoc} style={{ height }} {...stylex.props(styles.visual)} /></div>
    {isSource && <pre role="region" aria-label="Visual source" tabIndex={0}>{source}</pre>}
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
    {isSource || hasError ? <pre role="region" aria-label="Diagram source" tabIndex={0}>{source}</pre> : svg ? <div role="region" aria-label="Diagram" tabIndex={0} {...stylex.props(styles.diagram)} dangerouslySetInnerHTML={{ __html: svg }} /> : <p role="status" {...stylex.props(ui.muted, styles.codePadding)}>Loading diagram…</p>}
  </div>;
}

function Activity({ messages }: { messages: ChatMessage[] }) {
  const names = messages.flatMap(message => message.blocks.flatMap(block => block.type === 'toolCall' ? [block.name] : []));
  return <details {...stylex.props(styles.activity)}><summary {...stylex.props(styles.summary)}><ChevronRight size={16} strokeWidth={ICON_STROKE} /><span>{names.length ? `${names.length} ${names.length === 1 ? 'action' : 'actions'}` : 'Activity'}</span></summary>
    <div {...stylex.props(styles.activityBody)}>{messages.map(message => <div key={message.seq}>
      {message.toolName && <strong {...stylex.props(styles.toolTitle)}>{message.isError ? 'Failed · ' : ''}{message.toolName}</strong>}
      {message.blocks.map((block, index) => block.type === 'image' ? <img key={index} src={'/api/media/' + block.mediaId} alt="Activity attachment" loading="lazy" /> : <details key={index} {...stylex.props(styles.step)}><summary {...stylex.props(styles.summary)}><ChevronRight size={14} />{block.type === 'toolCall' ? block.name : block.type === 'thinking' ? 'Notes' : (block.text.split('\n')[0] || 'Result').slice(0, 90)}</summary><pre {...stylex.props(styles.toolOutput)}>{block.type === 'toolCall' ? JSON.stringify(block.args, undefined, 2) : block.text}</pre></details>)}
    </div>)}</div>
  </details>;
}

export function Messages({ messages, pendingPrompt, pendingImages, liveAssistant, isRunning, notify, onZoom }: {
  messages: ChatMessage[]; pendingPrompt?: string; pendingImages: string[]; liveAssistant?: LiveAssistant; isRunning: boolean; notify: (text: string, kind?: 'success' | 'error') => void; onZoom: (src: string) => void;
}) {
  const shouldReduceMotion = useReducedMotion();
  const sources = messages.flatMap(message => message.sources ?? []).filter((source, index, all) => all.findIndex(candidate => candidate.id === source.id) === index);
  const groups: ({ kind: 'message'; message: ChatMessage } | { kind: 'activity'; messages: ChatMessage[] })[] = [];
  messages.forEach(message => {
    if (message.role === 'user') { groups.push({ kind: 'message', message }); return; }
    const textBlocks = message.blocks.filter(block => block.type === 'text' || block.type === 'image');
    const activities = message.role === 'toolResult' || message.role === 'system' ? message.blocks : message.blocks.filter(block => block.type !== 'text' && block.type !== 'image');
    if (activities.length) {
      const previous = groups.at(-1); const activity = { ...message, blocks: activities };
      if (previous?.kind === 'activity') previous.messages.push(activity); else groups.push({ kind: 'activity', messages: [activity] });
    }
    if (textBlocks.length && message.role !== 'toolResult' && message.role !== 'system') groups.push({ kind: 'message', message: { ...message, blocks: textBlocks } });
  });
  return <div id="messages" {...stylex.props(styles.messages)}>{groups.map(group => {
    if (group.kind === 'activity') return <Activity key={'activity' + group.messages[0].seq} messages={group.messages} />;
    const message = group.message;
    const raw = messageText(message);
    const attachmentMatch = raw.match(/^\[첨부 이미지\]\n((?:- .*\n)+)위 이미지를[^\n]*\n\n?/);
    const text = message.role === 'user' ? attachmentMatch ? raw.slice(attachmentMatch[0].length) : raw : formatCitations({ text: raw, sources });
    const attachments = attachmentMatch ? attachmentMatch[1].trim().split('\n').flatMap(line => { const match = line.match(/^- (.*) → (.+\/([^/]+))$/); return match ? [{ name: match[1], src: '/api/upload/' + encodeURIComponent(match[3]) }] : []; }) : [];
    return <article key={message.seq} aria-label={message.role === 'user' ? 'Your message' : 'Response'} {...stylex.props(styles.message, message.role === 'user' && styles.user)}>
      {attachments.map(attachment => <button key={attachment.src} {...stylex.props(styles.imageButton)} onClick={() => onZoom(attachment.src)}><img src={attachment.src} alt={attachment.name} {...stylex.props(styles.image)} /></button>)}
      {message.role === 'user' ? <div {...stylex.props(styles.userText)}>{text}</div> : <ResponseMarkdown text={text} notify={notify} onZoom={onZoom} />}
      {message.blocks.filter(block => block.type === 'image').map((block, index) => block.type === 'image' ? <button key={index} {...stylex.props(styles.imageButton)} onClick={() => onZoom('/api/media/' + block.mediaId)}><img src={'/api/media/' + block.mediaId} alt="Attachment" loading="lazy" {...stylex.props(styles.image)} /></button> : undefined)}
      {message.role !== 'user' && text && <div {...stylex.props(styles.responseActions)}><CopyButton text={text} notify={notify} /></div>}
    </article>;
  })}
    {pendingPrompt !== undefined && <article aria-label="Sending message" {...stylex.props(styles.message, styles.user)}>{pendingImages.map(src => <img key={src} src={src} alt="Pending attachment" {...stylex.props(styles.image)} />)}<div {...stylex.props(styles.userText)}>{pendingPrompt}</div></article>}
    {liveAssistant?.text && <motion.article key={liveAssistant.streamId} aria-label="Response" aria-busy={!liveAssistant.done} data-streaming={!liveAssistant.done} {...stylex.props(styles.message)} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .16 }}><ResponseMarkdown text={formatCitations({ text: liveAssistant.text, sources, isStreaming: !liveAssistant.done })} isStreaming={!liveAssistant.done} notify={notify} onZoom={onZoom} /></motion.article>}
    <AnimatePresence>{isRunning && !liveAssistant?.text && <motion.div key="working" role="status" aria-label="Working" {...stylex.props(styles.working)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: .12 }}><motion.span {...stylex.props(styles.pulse)} animate={{ opacity: shouldReduceMotion ? 1 : [.4, 1, .4] }} transition={{ duration: 1.2, repeat: shouldReduceMotion ? 0 : Infinity }} />Working…</motion.div>}</AnimatePresence>
  </div>;
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
    return <button {...stylex.props(styles.imageButton)} onClick={() => src && onZoom(src)}><img src={src} alt={alt || 'Attachment'} loading="lazy" /></button>;
  },
  a: ({ href, children, title }) => <a href={href} title={title} aria-label={title?.startsWith(CITATION_TITLE_PREFIX) ? title : undefined} {...stylex.props(title?.startsWith(CITATION_TITLE_PREFIX) && styles.citation)} target="_blank" rel="noopener noreferrer">{children}</a>,
};

const styles = stylex.create({
  messages: { display: 'flex', flexDirection: 'column', gap: 24, width: '100%', minWidth: 0, paddingTop: 22, paddingBottom: 24 },
  message: { minWidth: 0, maxWidth: '100%', flexShrink: 0 },
  user: { alignSelf: 'flex-end', backgroundColor: tokens.bubble, borderRadius: 24, padding: '12px 18px', maxWidth: '88%', fontSize: '1rem', lineHeight: 1.55 },
  userText: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  responseActions: { marginLeft: -12, marginTop: 8, color: tokens.muted },
  citation: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 24, minHeight: 24, padding: '0 7px', margin: '0 2px', borderRadius: 12, backgroundColor: { default: tokens.surface, ':hover': tokens.hover }, color: tokens.muted, fontSize: '0.6875rem', fontWeight: 600, lineHeight: 1.3, textDecoration: 'none', verticalAlign: 'middle' },
  code: { minWidth: 0, maxWidth: '100%', borderRadius: 16, borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, overflow: 'hidden', marginTop: 16, marginBottom: 20, backgroundColor: tokens.surface },
  codeHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 6px 2px 16px', borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: tokens.border, fontSize: '0.75rem', color: tokens.muted },
  codePadding: { padding: 16 },
  visual: { display: 'block', width: '100%', maxWidth: '100%', minWidth: 0, borderWidth: 0, backgroundColor: tokens.canvas },
  tableScroll: { overflowX: 'auto', maxWidth: '100%', minWidth: 0, overscrollBehaviorX: 'contain', marginTop: 16, marginBottom: 20 },
  imageButton: { borderWidth: 0, padding: 0, backgroundColor: 'transparent', display: 'block', maxWidth: '100%', cursor: 'zoom-in' },
  image: { display: 'block', maxWidth: '100%', maxHeight: 360, objectFit: 'contain', borderRadius: 16, marginBottom: 8 },
  activity: { color: tokens.muted, fontSize: '0.8125rem', minWidth: 0 },
  summary: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', listStyle: 'none', minHeight: 44, overflowWrap: 'anywhere' },
  activityBody: { borderLeftWidth: 1, borderLeftStyle: 'solid', borderLeftColor: tokens.border, marginLeft: 8, paddingLeft: 14, minWidth: 0 },
  step: { minWidth: 0, maxWidth: '100%' },
  toolTitle: { fontSize: '0.8125rem', color: tokens.text },
  toolOutput: { fontSize: '0.75rem', lineHeight: 'var(--code-line-height)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0, padding: 12, backgroundColor: tokens.surface, borderRadius: 12, maxHeight: 320, overflowY: 'auto' },
  diagram: { padding: 16, overflowX: 'auto', maxWidth: '100%', backgroundColor: tokens.mediaWhite },
  working: { display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.875rem', color: tokens.muted, paddingTop: 2 },
  pulse: { display: 'inline-block', width: 8, height: 8, backgroundColor: tokens.text, borderRadius: '50%' },
});
