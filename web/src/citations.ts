import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Root, RootContent } from 'mdast';
import type { CitationSource } from './types';

export const CITATION_TITLE_PREFIX = 'Source: ';
const citationTag = /<\/?citation\b[^>]*>/gi;

export function formatCitations({ text, sources, isStreaming = false }: { text: string; sources: CitationSource[]; isStreaming?: boolean }) {
  if (!text.includes('<')) return text;
  const stack: CitationSource[][] = [];
  const references: string[] = [];
  const replacements: { start: number; end: number; value: string }[] = [];
  visit(fromMarkdown(text));
  return replacements.reverse().reduce((value, replacement) => value.slice(0, replacement.start) + replacement.value + value.slice(replacement.end), text);

  function visit(node: Root | RootContent) {
    if (node.type === 'html' && node.position) {
      const value = node.value.replace(citationTag, tag => {
        if (tag.startsWith('</')) return (stack.pop() ?? []).map(source => {
          let index = references.indexOf(source.id);
          if (index < 0) { index = references.length; references.push(source.id); }
          const url = source.url.replace(/[<>\s()]/g, character => encodeURIComponent(character));
          const title = (CITATION_TITLE_PREFIX + (source.title || new URL(source.url).hostname)).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, ' ');
          return ` [${index + 1}](<${url}> "${title}")`;
        }).join('');
        const refs = tag.match(/\brefs\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
        const ids = new Set((refs?.[1] ?? refs?.[2] ?? '').split(/[\s,]+/).filter(Boolean));
        stack.push(sources.filter(source => ids.has(source.id) && isWebSource(source.url)));
        return '';
      });
      if (value !== node.value) replacements.push({ start: node.position.start.offset!, end: node.position.end.offset!, value });
    } else if (isStreaming && node.type === 'text' && node.position?.end.offset === text.length) {
      const start = text.lastIndexOf('<');
      const tail = text.slice(start).toLowerCase();
      if (start >= (node.position.start.offset ?? 0) && tail.length > 1 && ('<citation'.startsWith(tail) || '</citation'.startsWith(tail) || /^<\/?citation\b[^>]*$/.test(tail))) {
        replacements.push({ start, end: text.length, value: '' });
      }
    }
    if ('children' in node) node.children.forEach(visit);
  }
}

function isWebSource(value: string) {
  try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:'; }
  catch { return false; }
}
