import * as stylex from '@stylexjs/stylex';
import { Check, ChevronRight, Circle, CircleAlert } from 'lucide-react';
import type { ChatMessage, ToolCallBlock } from './types';
import { isRecord } from './responses';
import { tokens } from './tokens.stylex';
import { ICON_STROKE } from './ui';

const TOOL_TITLES: Record<string, string> = { repl: 'Browser action', history_search: 'Search browsing history', memory_search: 'Search saved notes', read_file: 'Read file', web_search: 'Search the web' };

export function Activity({ messages, results, onZoom, expanded, onExpandedChange }: { messages: ChatMessage[]; results: Map<string, ChatMessage>; onZoom: (src: string) => void; expanded: Record<string, boolean>; onExpandedChange: (id: string, isOpen: boolean) => void }) {
  const calls = messages.flatMap(message => message.blocks.flatMap((block, index) => block.type === 'toolCall' ? [{ block, key: `${message.seq}-${index}`, result: block.id ? results.get(block.id) : undefined }] : []));
  const notes = messages.flatMap(message => message.blocks.flatMap((block, index) => block.type === 'thinking' && block.text.trim() ? [{ text: block.text, key: `${message.seq}-${index}` }] : []));
  const standalone = messages.filter(message => message.role === 'toolResult' || message.role === 'system');
  const rootId = 'activity-' + messages[0].seq;
  return <details open={expanded[rootId] ?? false} onToggle={event => { if (event.target === event.currentTarget) onExpandedChange(rootId, event.currentTarget.open); }} {...stylex.props(styles.activity)}><summary {...stylex.props(styles.summary)}><ChevronRight size={15} strokeWidth={ICON_STROKE} aria-hidden="true" /><span>{calls.length ? `${calls.length} ${calls.length === 1 ? 'action' : 'actions'}` : 'Activity'}</span></summary>
    {expanded[rootId] && <div {...stylex.props(styles.body)}>
      {notes.map(note => <details key={note.key} open={expanded[note.key] ?? false} onToggle={event => onExpandedChange(note.key, event.currentTarget.open)} {...stylex.props(styles.notes)}><summary {...stylex.props(styles.summary)}><ChevronRight size={14} aria-hidden="true" />Notes</summary><p {...stylex.props(styles.description)}>{note.text}</p></details>)}
      {calls.map(call => <Action key={call.key} call={call.block} result={call.result} onZoom={onZoom} isExpanded={expanded[call.key] ?? false} onExpandedChange={isOpen => onExpandedChange(call.key, isOpen)} />)}
      {standalone.map(message => <Action key={message.seq} result={message} onZoom={onZoom} isExpanded={expanded[String(message.seq)] ?? false} onExpandedChange={isOpen => onExpandedChange(String(message.seq), isOpen)} />)}
    </div>}
  </details>;
}

function Action({ call, result, onZoom, isExpanded, onExpandedChange }: { call?: ToolCallBlock; result?: ChatMessage; onZoom: (src: string) => void; isExpanded: boolean; onExpandedChange: (isOpen: boolean) => void }) {
  const args = isRecord(call?.args) ? call.args : undefined;
  const name = call?.name ?? result?.toolName ?? '';
  const title = typeof args?.title === 'string' && args.title.trim() ? args.title : TOOL_TITLES[name] ?? (name.replace(/[_-]/g, ' ') || 'Activity');
  const output = result?.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim() ?? '';
  const isSkipped = /\b(?:was skipped|not a completed search)\b/i.test(output);
  const status = result?.isError ? 'Failed' : isSkipped ? 'Unavailable' : result?.role === 'system' ? 'Notice' : result ? 'Completed' : 'Started';
  const page = output.match(/(?:^|\n)[+-]?\s*-\s*title:\s*"([^"\n]+)"\s*\[url=(https?:\/\/[^\]]+)\]/) ?? output.match(/→\s*([^\n]+?)\s*\((https?:\/\/[^\s)]+)\)/);
  const pageUrl = page && URL.canParse(page[2]) ? new URL(page[2]) : undefined;
  const queries = Array.isArray(args?.queries) ? args.queries.filter((query): query is string => typeof query === 'string') : typeof args?.query === 'string' ? [args.query] : [];
  const isSnapshot = /(?:^|\n)(?:[+-]?\s*-\s*(?:title|generic|text|link|button)|@@)/.test(output);
  const observed = output.split('\n').flatMap(line => {
    const match = line.match(/^\+\s*-\s*(?:text|heading|link)(?:\s+\[.*?\])?:?\s*"([^"\n]+)"/);
    return match ? [match[1]] : [];
  }).filter((text, index, all) => !/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(text) && !/광고|advertisement/i.test(text) && all.indexOf(text) === index).slice(0, 4);
  const lines = output.split('\n').filter(line => line.trim() && !/^\s*(?:at |# |\[Output too large|Preview|Displayed image|Image original|\[Try |@@|[+-]- )/.test(line));
  const description = describeResult();
  const images = result?.blocks.filter(block => block.type === 'image') ?? [];
  const input = args && Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'title' && key !== 'code'));
  const hasInput = input && Object.keys(input).length > 0;
  return <section aria-label={title} {...stylex.props(styles.action)}>
    <div {...stylex.props(styles.heading)}>{result?.isError || isSkipped ? <CircleAlert size={15} strokeWidth={ICON_STROKE} aria-hidden="true" /> : result ? <Check size={15} strokeWidth={ICON_STROKE} aria-hidden="true" /> : <Circle size={13} strokeWidth={ICON_STROKE} aria-hidden="true" />}<strong {...stylex.props(styles.title)}>{title}</strong><span {...stylex.props(styles.status, (result?.isError || isSkipped) && styles.error)}>{status}</span></div>
    {queries.length > 0 && <p {...stylex.props(styles.query)}>{queries.join(' · ')}</p>}
    {page && pageUrl && <a href={pageUrl.href} target="_blank" rel="noopener noreferrer" {...stylex.props(styles.page)}>{page[1]}<span {...stylex.props(styles.domain)}>{pageUrl.hostname}</span></a>}
    {description && <p {...stylex.props(styles.description)}>{description.slice(0, 600)}</p>}
    {observed.length > 0 && <ul {...stylex.props(styles.changes)}>{observed.map(text => <li key={text}>{text.slice(0, 180)}</li>)}</ul>}
    {images.map((block, index) => block.type === 'image' ? <button key={index} type="button" aria-label="View activity screenshot" {...stylex.props(styles.imageButton)} onClick={() => onZoom('/api/media/' + block.mediaId)}><img src={'/api/media/' + block.mediaId} alt="Activity screenshot" loading="lazy" {...stylex.props(styles.image)} /></button> : undefined)}
    {(output || args) && <details open={isExpanded} onToggle={event => onExpandedChange(event.currentTarget.open)} {...stylex.props(styles.technical)}><summary {...stylex.props(styles.summary)}><ChevronRight size={13} aria-hidden="true" />Technical details</summary>
      {isExpanded && <>{name && <span {...stylex.props(styles.label)}>Tool · {name}</span>}
      {hasInput && <><span {...stylex.props(styles.label)}>Input</span><pre {...stylex.props(styles.output)}>{JSON.stringify(input, undefined, 2)}</pre></>}
      {typeof args?.code === 'string' && <><span {...stylex.props(styles.label)}>Code</span><pre {...stylex.props(styles.output)}>{args.code}</pre></>}
      {output && <><span {...stylex.props(styles.label)}>Result</span><pre {...stylex.props(styles.output)}>{output}</pre></>}</>}
    </details>}
  </section>;

  function describeResult() {
    if (result?.isError) return /RefStaleError/.test(output) ? 'The page changed before this action could finish.' : lines[0]?.replace(/^Error:\s*/, '');
    if (isSkipped) return output.split(/(?<=[.!?])\s/)[0];
    if (output === '[]') return 'No open tabs.';
    if (/^\(no matching history\)/.test(output)) return 'No matching history.';
    if (observed.length) return;
    if (isSnapshot) return 'Page inspected.';
    if (page) return;
    return lines.filter(line => !/^[\[\]{}]/.test(line)).slice(0, 3).join('\n');
  }
}

const styles = stylex.create({
  activity: { color: tokens.muted, fontSize: '0.8125rem', minWidth: 0 },
  summary: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', listStyle: 'none', minHeight: 32, overflowWrap: 'anywhere' },
  body: { borderLeftWidth: 1, borderLeftStyle: 'solid', borderLeftColor: tokens.border, marginLeft: 7, paddingLeft: 12, paddingBottom: 6, minWidth: 0 },
  action: { minWidth: 0, padding: '8px 0', borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: tokens.border, ':last-child': { borderBottomWidth: 0 } },
  heading: { display: 'flex', alignItems: 'flex-start', gap: 7, minWidth: 0, lineHeight: 1.5 },
  title: { flex: 1, minWidth: 0, color: tokens.text, fontSize: '0.8125rem', fontWeight: 550, overflowWrap: 'anywhere' },
  status: { flexShrink: 0, fontSize: '0.6875rem', lineHeight: 1.8 },
  error: { color: tokens.danger },
  query: { margin: '4px 0 0 22px', overflowWrap: 'anywhere', lineHeight: 1.5 },
  page: { display: 'block', margin: '4px 0 0 22px', color: tokens.text, overflowWrap: 'anywhere', lineHeight: 1.5 },
  domain: { display: 'block', color: tokens.muted, fontSize: '0.6875rem', textDecoration: 'none' },
  description: { margin: '4px 0 0 22px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.55, color: tokens.muted },
  changes: { margin: '4px 0 0 22px', paddingLeft: 16, overflowWrap: 'anywhere', lineHeight: 1.55, fontSize: '0.75rem', color: tokens.muted },
  notes: { minWidth: 0 },
  technical: { marginLeft: 22, fontSize: '0.75rem' },
  label: { display: 'block', margin: '4px 0', fontSize: '0.6875rem' },
  output: { fontSize: '0.75rem', lineHeight: 'var(--code-line-height)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0, padding: '8px 10px', backgroundColor: tokens.surface, borderRadius: 10, maxHeight: 240, overflowY: 'auto' },
  imageButton: { display: 'block', width: 'calc(100% - 22px)', margin: '6px 0 0 22px', padding: 0, borderWidth: 0, backgroundColor: 'transparent', cursor: 'zoom-in' },
  image: { display: 'block', width: '100%', height: 144, borderRadius: 10, objectFit: 'contain' },
});
