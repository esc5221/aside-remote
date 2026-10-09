import * as stylex from '@stylexjs/stylex';
import { Maximize2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isTabResponse } from './browser';
import type { BrowserTab } from './types';
import { tokens } from './tokens.stylex';
import { BrowserIcon, ICON_STROKE } from './ui';
import { useAutoRefresh } from './useAutoRefresh';

export function BrowserLive({ sessionId, request, onOpen }: {
  sessionId: string;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  onOpen: (targetId: string) => void;
}) {
  const [tab, setTab] = useState<BrowserTab>();
  const [imageUrl, setImageUrl] = useState<string>();
  const [isConnected, setConnected] = useState(false);
  const imageRef = useRef<string | undefined>(undefined);
  const sessionQuery = `&session=${encodeURIComponent(sessionId)}`;
  const targetId = tab?.targetId;

  const loadTabs = useCallback(async (signal: AbortSignal) => {
    try {
      const response = await request(`/api/tabs?refresh=true${sessionQuery}`, { cache: 'no-store', signal });
      const value: unknown = await response.json();
      if (signal.aborted) return;
      if (!isTabResponse(value)) throw new Error('Invalid browser response.');
      setTab(value.tabs.find(tab => tab.active) ?? [...value.tabs].sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0]);
    } catch {
      if (!signal.aborted) setConnected(false);
    }
  }, [request, sessionQuery]);
  useAutoRefresh(loadTabs, 2_000);

  const capture = useCallback(async (signal: AbortSignal) => {
    if (!targetId) return;
    try {
      const response = await request(`/api/tabs/${encodeURIComponent(targetId)}/shot?fresh=true${sessionQuery}`, { cache: 'no-store', signal });
      const blob = await response.blob();
      if (signal.aborted) return;
      if (!blob.type.startsWith('image/')) throw new Error('Invalid preview.');
      const nextUrl = URL.createObjectURL(blob);
      const previousUrl = imageRef.current;
      imageRef.current = nextUrl;
      setImageUrl(nextUrl);
      setConnected(true);
      if (previousUrl) URL.revokeObjectURL(previousUrl);
    } catch {
      if (!signal.aborted) setConnected(false);
    }
  }, [request, sessionQuery, targetId]);
  useEffect(() => {
    setImageUrl(undefined);
    setConnected(false);
    return () => {
      if (imageRef.current) URL.revokeObjectURL(imageRef.current);
      imageRef.current = undefined;
    };
  }, [targetId]);
  useAutoRefresh(capture, 1_000, !!targetId && tab?.loaded !== false);

  return <AnimatePresence>{tab && <motion.button key={tab.targetId} type="button" aria-label={`Open live browser preview: ${tab.title || 'Browser'}`} aria-haspopup="dialog" {...stylex.props(styles.preview)} initial={{ opacity: 0, y: 12, scale: .92 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: .92 }} transition={{ duration: .18 }} whileTap={{ scale: .96 }} onClick={() => onOpen(tab.targetId)}>
    <span {...stylex.props(styles.top)}><BrowserIcon size={15} /><span {...stylex.props(styles.title)}>{tab.title || 'Browser'}</span><Maximize2 size={13} strokeWidth={ICON_STROKE} aria-hidden="true" /></span>
    <span {...stylex.props(styles.frame)}>{imageUrl ? <img src={imageUrl} alt="" {...stylex.props(styles.image)} /> : <span {...stylex.props(styles.placeholder)}>{tab.loaded === false ? 'Tab asleep' : 'Connecting…'}</span>}</span>
    <span {...stylex.props(styles.status)}><span {...stylex.props(styles.dot, isConnected && styles.connected)} />{isConnected ? 'Live' : 'Connecting…'}</span>
  </motion.button>}</AnimatePresence>;
}

const styles = stylex.create({
  preview: { position: 'absolute', right: 'max(16px, env(safe-area-inset-right))', bottom: 62, width: 'min(168px, 43%)', padding: 0, borderRadius: 16, borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, backgroundColor: tokens.canvas, color: tokens.text, overflow: 'hidden', cursor: 'pointer', boxShadow: '0 6px 28px rgb(0 0 0 / .15)', zIndex: 2, textAlign: 'left' },
  top: { display: 'flex', alignItems: 'center', gap: 6, padding: '9px 10px', minWidth: 0 },
  title: { flex: 1, minWidth: 0, fontSize: '0.6875rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: 600 },
  frame: { display: 'flex', width: '100%', aspectRatio: '4 / 3', overflow: 'hidden', backgroundColor: tokens.surface },
  image: { width: '100%', height: '100%', objectFit: 'contain', objectPosition: 'top' },
  placeholder: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', fontSize: '0.6875rem', color: tokens.muted },
  status: { display: 'flex', alignItems: 'center', gap: 5, padding: '7px 10px', fontSize: '0.625rem', color: tokens.muted },
  dot: { width: 5, height: 5, borderRadius: '50%', backgroundColor: tokens.muted },
  connected: { backgroundColor: tokens.text },
});
