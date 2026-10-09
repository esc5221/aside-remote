import { Children, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { ChevronRight, Copy, Check, Code2 } from 'lucide-react';
import type { ChatMessage } from './types';
import { tokens } from './tokens.stylex';
import { ICON_STROKE, IconButton, styles as ui } from './ui';

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

function CodeBlock({ children, notify }: { children: ReactNode; notify: (text: string, kind?: 'success' | 'error') => void }) {
  const code = textContent(children);
  const child = Children.toArray(children)[0];
  const language = typeof child === 'object' && 'props' in child ? (child.props as { className?: string }).className?.match(/language-(\S+)/)?.[1] : undefined;
  if (language === 'mermaid') return <Diagram source={code} notify={notify} />;
  return <div {...stylex.props(styles.code)}><div {...stylex.props(styles.codeHeader)}><span>{language || 'Text'}</span><CopyButton text={code} notify={notify} /></div><pre>{children}</pre></div>;
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
    {isSource || hasError ? <pre>{source}</pre> : svg ? <div {...stylex.props(styles.diagram)} dangerouslySetInnerHTML={{ __html: svg }} /> : <p {...stylex.props(ui.muted, styles.codePadding)}>Loading diagram…</p>}
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

export function Messages({ messages, pendingPrompt, pendingImages, isRunning, notify, onZoom }: {
  messages: ChatMessage[]; pendingPrompt?: string; pendingImages: string[]; isRunning: boolean; notify: (text: string, kind?: 'success' | 'error') => void; onZoom: (src: string) => void;
}) {
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
    const text = attachmentMatch ? raw.slice(attachmentMatch[0].length) : raw;
    const attachments = attachmentMatch ? attachmentMatch[1].trim().split('\n').flatMap(line => { const match = line.match(/^- (.*) → (.+\/([^/]+))$/); return match ? [{ name: match[1], src: '/api/upload/' + encodeURIComponent(match[3]) }] : []; }) : [];
    return <article key={message.seq} aria-label={message.role === 'user' ? 'Your message' : 'Response'} {...stylex.props(styles.message, message.role === 'user' && styles.user)}>
      {attachments.map(attachment => <button key={attachment.src} {...stylex.props(styles.imageButton)} onClick={() => onZoom(attachment.src)}><img src={attachment.src} alt={attachment.name} {...stylex.props(styles.image)} /></button>)}
      {message.role === 'user' ? <div {...stylex.props(styles.userText)}>{text}</div> : <div className="markdown"><ReactMarkdown remarkPlugins={markdownPlugins} rehypePlugins={highlightPlugins} components={{
        pre: ({ children }) => <CodeBlock notify={notify}>{children}</CodeBlock>,
        table: ({ children }) => <div {...stylex.props(styles.tableScroll)}><table>{children}</table></div>,
        img: ({ src, alt }) => <button {...stylex.props(styles.imageButton)} onClick={() => src && onZoom(src)}><img src={src} alt={alt || 'Attachment'} loading="lazy" /></button>,
        a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
      }}>{text}</ReactMarkdown></div>}
      {message.blocks.filter(block => block.type === 'image').map((block, index) => block.type === 'image' ? <button key={index} {...stylex.props(styles.imageButton)} onClick={() => onZoom('/api/media/' + block.mediaId)}><img src={'/api/media/' + block.mediaId} alt="Attachment" loading="lazy" {...stylex.props(styles.image)} /></button> : undefined)}
      {message.role !== 'user' && text && <div {...stylex.props(styles.responseActions)}><CopyButton text={text} notify={notify} /></div>}
    </article>;
  })}
    {pendingPrompt !== undefined && <article aria-label="Sending message" {...stylex.props(styles.message, styles.user)}>{pendingImages.map(src => <img key={src} src={src} alt="Pending attachment" {...stylex.props(styles.image)} />)}<div {...stylex.props(styles.userText)}>{pendingPrompt}</div></article>}
    {isRunning && <div role="status" aria-label="Working" {...stylex.props(styles.working)}><span {...stylex.props(styles.pulse)} />Working…</div>}
  </div>;
}

const styles = stylex.create({
  messages: { display: 'flex', flexDirection: 'column', gap: 24, width: '100%', minWidth: 0, paddingTop: 22, paddingBottom: 24 },
  message: { minWidth: 0, maxWidth: '100%', flexShrink: 0 },
  user: { alignSelf: 'flex-end', backgroundColor: tokens.bubble, borderRadius: 24, padding: '12px 18px', maxWidth: '88%', fontSize: 16, lineHeight: 1.55 },
  userText: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  responseActions: { marginLeft: -12, marginTop: 8, color: tokens.muted },
  code: { minWidth: 0, maxWidth: '100%', borderRadius: 16, borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, overflow: 'hidden', marginTop: 16, marginBottom: 20, backgroundColor: tokens.surface },
  codeHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 6px 2px 16px', borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: tokens.border, fontSize: 12, color: tokens.muted },
  codePadding: { padding: 16 },
  tableScroll: { overflowX: 'auto', maxWidth: '100%', minWidth: 0, overscrollBehaviorX: 'contain', marginTop: 16, marginBottom: 20 },
  imageButton: { borderWidth: 0, padding: 0, backgroundColor: 'transparent', display: 'block', maxWidth: '100%', cursor: 'zoom-in' },
  image: { display: 'block', maxWidth: '100%', maxHeight: 360, objectFit: 'contain', borderRadius: 16, marginBottom: 8 },
  activity: { color: tokens.muted, fontSize: 13, minWidth: 0 },
  summary: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', listStyle: 'none', minHeight: 44, overflowWrap: 'anywhere' },
  activityBody: { borderLeftWidth: 1, borderLeftStyle: 'solid', borderLeftColor: tokens.border, marginLeft: 8, paddingLeft: 14, minWidth: 0 },
  step: { minWidth: 0, maxWidth: '100%' },
  toolTitle: { fontSize: 13, color: tokens.text },
  toolOutput: { fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0, padding: 12, backgroundColor: tokens.surface, borderRadius: 12, maxHeight: 320, overflowY: 'auto' },
  diagram: { padding: 16, overflowX: 'auto', maxWidth: '100%', backgroundColor: tokens.mediaWhite },
  working: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: tokens.muted, paddingTop: 2 },
  pulse: { display: 'inline-block', width: 8, height: 8, backgroundColor: tokens.text, borderRadius: '50%' },
});
