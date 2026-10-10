import { useEffect, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Check, ChevronDown } from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import { parseModelConfig, parseModels } from './responses';
import { tokens } from './tokens.stylex';
import { CloseButton, Dialog, ICON_STROKE, styles as ui } from './ui';
import type { AvailableModel, ModelConfig, UseChat } from './types';

const MODEL_STORAGE_KEY = 'asideModel';
const THINKING_STORAGE_KEY = 'asideThinkingLevel';
const THINKING_LABELS: Record<string, string> = { off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' };

export function useModelSelection(chat: UseChat, notify: (text: string, kind?: 'error' | 'success') => void) {
  const [catalog, setCatalog] = useState<{ sessionId?: string; items: AvailableModel[]; current: ModelConfig }>();
  const [error, setError] = useState<string>();
  const [isUpdating, setUpdating] = useState(false);
  const generation = useRef(0);
  const mutation = useRef(false);
  const { sessionId, isReady, authError, request } = chat;
  const [revision, setRevision] = useState(0);
  const loaded = catalog?.sessionId === sessionId ? catalog : undefined;

  useEffect(() => {
    const version = ++generation.current;
    const controller = new AbortController();
    setError(undefined);
    if (isReady && !authError) void load();
    return () => { generation.current += 1; controller.abort(); };

    async function load() {
      try {
        const response = await request('/api/models' + (sessionId ? '?session_id=' + encodeURIComponent(sessionId) : ''), { signal: controller.signal });
        const result = parseModels(await response.json());
        if (controller.signal.aborted || version !== generation.current) return;
        const savedModel = !sessionId && localStorage.getItem(MODEL_STORAGE_KEY);
        const saved = !sessionId && result.items.find(model => savedModel ? `${model.provider}/${model.id}` === savedModel : model.id === result.current.modelId && model.provider === result.current.provider);
        setCatalog({ sessionId, ...result, current: saved ? configureModel(saved, { ...result.current, thinkingLevel: localStorage.getItem(THINKING_STORAGE_KEY) ?? result.current.thinkingLevel }) : result.current });
      } catch {
        if (!controller.signal.aborted && version === generation.current) setError('Could not load models.');
      }
    }
  }, [sessionId, isReady, authError, request, revision]);

  async function select(model: AvailableModel, thinkingLevel?: string) {
    if (!loaded || mutation.current) return false;
    const version = ++generation.current;
    mutation.current = true;
    setUpdating(true);
    const config = configureModel(model, thinkingLevel ? { ...loaded.current, thinkingLevel } : loaded.current);
    setCatalog({ ...loaded, current: config });
    try {
      const current = sessionId
        ? parseModelConfig(await (await request('/api/sessions/' + encodeURIComponent(sessionId) + '/model', {
          method: 'PUT', body: JSON.stringify(config),
        })).json())
        : config;
      if (version !== generation.current) return false;
      setCatalog({ ...loaded, current });
      localStorage.setItem(MODEL_STORAGE_KEY, `${current.provider}/${current.modelId}`);
      localStorage.setItem(THINKING_STORAGE_KEY, current.thinkingLevel);
      return true;
    } catch {
      if (version === generation.current) { setCatalog(loaded); notify('Could not update model settings. Try again.', 'error'); }
      return false;
    } finally { mutation.current = false; setUpdating(false); }
  }

  return { items: loaded?.items ?? [], current: loaded?.current, error, isUpdating, select, reload: () => setRevision(value => value + 1) };
}

function configureModel(model: AvailableModel, current: ModelConfig): ModelConfig {
  return { provider: model.provider, modelId: model.id,
    thinkingLevel: model.thinkingLevels.includes(current.thinkingLevel) ? current.thinkingLevel : model.thinkingLevels.includes('high') ? 'high' : model.thinkingLevels[0],
    fastMode: model.supportsFastMode && current.fastMode };
}

export function ModelPicker({ selection, disabled, isRunning }: {
  selection: ReturnType<typeof useModelSelection>; disabled: boolean; isRunning: boolean;
}) {
  const [isOpen, setOpen] = useState(false);
  const current = selection.items.find(model => model.id === selection.current?.modelId && model.provider === selection.current.provider);
  const name = current?.name ?? selection.current?.modelId ?? 'Model';
  const providers = [...new Set(selection.items.map(model => model.provider))];
  const thinkingLabel = selection.current && (THINKING_LABELS[selection.current.thinkingLevel] ?? selection.current.thinkingLevel);
  const close = () => setOpen(false);
  const open = () => { selection.reload(); setOpen(true); };

  return <>
    <button type="button" aria-label={'Choose model, ' + name + (thinkingLabel ? ', ' + thinkingLabel : '')} aria-haspopup="dialog" aria-expanded={isOpen} disabled={disabled || selection.isUpdating} {...stylex.props(styles.trigger, ui.glass)} onPointerDown={event => { if (event.pointerType === 'touch') { event.preventDefault(); if (!disabled && !selection.isUpdating) open(); } }} onClick={open}>
      <span {...stylex.props(styles.triggerText)}><span {...stylex.props(styles.name)}>{name}</span>{thinkingLabel && <span {...stylex.props(styles.effort)}>{thinkingLabel}</span>}</span><ChevronDown size={13} strokeWidth={ICON_STROKE} aria-hidden="true" />
    </button>
    <AnimatePresence>{isOpen && <Dialog key="models" title="Models" onClose={close}>
      <div {...stylex.props(styles.header)}><h2 {...stylex.props(ui.title)}>Models</h2><CloseButton onClick={close} /></div>
      {isRunning && <p {...stylex.props(styles.note)}>Applies to your next response.</p>}
      {selection.error ? <p role="alert" {...stylex.props(styles.note)}>{selection.error} <button type="button" {...stylex.props(styles.retry)} onClick={selection.reload}>Try again</button></p> : !selection.current && <p role="status" {...stylex.props(styles.note)}>Loading models…</p>}
      {current && selection.current && <label {...stylex.props(styles.reasoning)}><span>Reasoning effort</span>
        <select aria-label="Reasoning effort" value={selection.current.thinkingLevel} disabled={disabled || selection.isUpdating} {...stylex.props(styles.effortSelect)} onChange={event => { void selection.select(current, event.target.value); }}>
          {current.thinkingLevels.map(level => <option key={level} value={level}>{THINKING_LABELS[level] ?? level}</option>)}
        </select>
      </label>}
      {providers.map(provider => <section key={provider} aria-label={provider} {...stylex.props(styles.group)}>
        <h3 {...stylex.props(styles.provider)}>{provider === 'openai-codex' ? 'OpenAI Codex' : provider === 'aside' ? 'Aside' : provider}</h3>
        {sortModels(selection.items.filter(model => model.provider === provider)).map(model => {
          const isSelected = model.id === selection.current?.modelId && model.provider === selection.current.provider;
          return <button key={model.id} type="button" aria-label={model.name + ', ' + provider} aria-pressed={isSelected} disabled={selection.isUpdating || disabled} {...stylex.props(styles.option, isSelected && styles.selected)} onClick={() => { close(); void selection.select(model); }}>
            <span {...stylex.props(styles.name)}>{model.name}</span>{isSelected && <Check size={19} strokeWidth={ICON_STROKE} aria-hidden="true" />}
          </button>;
        })}
      </section>)}
      {selection.isUpdating && <p role="status" {...stylex.props(styles.note)}>Updating model settings…</p>}
    </Dialog>}</AnimatePresence>
  </>;
}

function sortModels(models: AvailableModel[]) {
  const family = (model: AvailableModel) => model.name.match(/^[a-z]+/i)?.[0] ?? model.name;
  const families = [...new Set(models.map(family))];
  return [...models].sort((first, second) => families.indexOf(family(first)) - families.indexOf(family(second))
    || (second.name.match(/\d+(?:\.\d+)*/)?.[0] ?? '').localeCompare(first.name.match(/\d+(?:\.\d+)*/)?.[0] ?? '', 'en', { numeric: true }));
}

const styles = stylex.create({
  trigger: { display: 'flex', alignItems: 'center', gap: 6, minHeight: 32, maxWidth: 190, minWidth: 0, padding: '0 10px', borderWidth: 0, borderRadius: 20, backgroundColor: { default: 'transparent', ':hover': tokens.hover }, color: tokens.muted, fontSize: '.6875rem', pointerEvents: 'auto', '@media (max-width: 375px)': { maxWidth: 172 } },
  name: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  triggerText: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
  effort: { fontSize: '0.625rem' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  note: { color: tokens.muted, fontSize: '0.8125rem', lineHeight: 1.5, margin: '0 0 14px' },
  retry: { borderWidth: 0, backgroundColor: 'transparent', color: tokens.text, padding: '8px 4px', fontSize: 'inherit' },
  group: { marginBottom: 16 },
  reasoning: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '0 12px', marginBottom: 20, color: tokens.muted, fontSize: '0.8125rem' },
  effortSelect: { minHeight: 44, maxWidth: '55%', borderWidth: 0, borderRadius: 12, padding: '0 12px', backgroundColor: tokens.surface, color: tokens.text, fontFamily: 'inherit', fontSize: '0.875rem' },
  provider: { color: tokens.muted, fontSize: '0.75rem', fontWeight: 500, margin: '0 12px 6px' },
  option: { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 44, padding: '10px 12px', borderWidth: 0, borderRadius: 12, backgroundColor: { default: 'transparent', ':hover': tokens.hover }, color: tokens.text, textAlign: 'left', fontSize: '0.9375rem' },
  selected: { backgroundColor: tokens.surface },
});
