import type { AvailableModel, ChatMessage, ChatSession, MessageBlock, ModelConfig, UploadAttachment } from './types';

const INVALID_RESPONSE = 'Invalid server response.';
const MESSAGE_ROLES: ChatMessage['role'][] = ['user', 'assistant', 'toolResult', 'system'];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function record(value: unknown) {
  if (!isRecord(value)) throw new Error(INVALID_RESPONSE);
  return value;
}

function text(value: unknown) {
  if (typeof value !== 'string') throw new Error(INVALID_RESPONSE);
  return value;
}

function number(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(INVALID_RESPONSE);
  return value;
}

function position(value: unknown) {
  const result = number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(INVALID_RESPONSE);
  return result;
}

function boolean(value: unknown) {
  if (typeof value !== 'boolean') throw new Error(INVALID_RESPONSE);
  return value;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error(INVALID_RESPONSE);
  return value;
}

function optionalText(value: unknown) {
  return value == null ? undefined : text(value);
}

function optionalNumber(value: unknown) {
  return value == null ? undefined : number(value);
}

export function parseModelConfig(value: unknown): ModelConfig {
  const item = record(value);
  return { provider: text(item.provider), modelId: text(item.modelId), thinkingLevel: text(item.thinkingLevel), fastMode: boolean(item.fastMode) };
}

export function parseModels(value: unknown) {
  const item = record(value);
  const items = array(item.items).map((value): AvailableModel => {
    const model = record(value);
    const thinkingLevels = array(model.thinkingLevels).map(text);
    if (!thinkingLevels.length) throw new Error(INVALID_RESPONSE);
    return { id: text(model.id), name: text(model.name), provider: text(model.provider), thinkingLevels, supportsFastMode: boolean(model.supportsFastMode) };
  });
  return { items, current: parseModelConfig(item.current) };
}

function block(value: unknown): MessageBlock {
  const item = record(value);
  if (item.type === 'text' || item.type === 'thinking') {
    return { type: item.type, text: text(item.text) };
  }
  if (item.type === 'image') {
    return {
      type: item.type,
      mediaId: text(item.mediaId),
      mime: optionalText(item.mime),
      bytes: optionalNumber(item.bytes),
    };
  }
  if (item.type === 'toolCall') {
    return {
      type: item.type,
      id: optionalText(item.id),
      name: optionalText(item.name),
      args: item.args,
    };
  }
  throw new Error(INVALID_RESPONSE);
}

export function parseChatMessage(value: unknown): ChatMessage {
  const item = record(value);
  const role = MESSAGE_ROLES.find(role => role === item.role);
  if (!role) throw new Error(INVALID_RESPONSE);
  const usage = item.usage == null ? undefined : record(item.usage);
  return {
    seq: position(item.seq),
    role,
    blocks: array(item.blocks).map(block),
    ts: optionalNumber(item.ts),
    responseId: optionalText(item.responseId),
    toolName: optionalText(item.toolName),
    toolCallId: optionalText(item.toolCallId),
    model: optionalText(item.model),
    provider: optionalText(item.provider),
    stopReason: optionalText(item.stopReason),
    isError: item.isError == null ? undefined : boolean(item.isError),
    sources: item.sources == null ? undefined : array(item.sources).map(value => {
      const source = record(value);
      return { id: text(source.id), url: text(source.url), title: optionalText(source.title) };
    }),
    usage: usage && {
      input: optionalNumber(usage.input),
      output: optionalNumber(usage.output),
      total: optionalNumber(usage.total),
      cost: optionalNumber(usage.cost),
    },
  };
}

function session(value: unknown): ChatSession {
  const item = record(value);
  return {
    id: text(item.id),
    title: text(item.title),
    status: text(item.status),
    unread: boolean(item.unread),
    isPinned: boolean(item.isPinned),
    updatedAt: text(item.updatedAt),
    mtime: number(item.mtime),
    preview: text(item.preview),
    lastPrompt: text(item.lastPrompt),
    bytes: position(item.bytes),
    hasLog: boolean(item.hasLog),
    cost: optionalNumber(item.cost),
    tokens: optionalNumber(item.tokens),
  };
}

export function parseSessionDetails(value: unknown) {
  const item = record(value);
  return { id: text(item.id), title: text(item.title), status: text(item.status), isPinned: boolean(item.isPinned) };
}

export function parseSessionsResponse(value: unknown) {
  const item = record(value);
  return {
    items: array(item.items).map(session),
    nextCursor: optionalText(item.nextCursor),
    total: position(item.total),
    matched: position(item.matched),
  };
}

export function parseMessagesResponse(value: unknown) {
  const item = record(value);
  return {
    sessionId: text(item.sessionId),
    messages: array(item.messages).map(parseChatMessage),
    offset: position(item.offset),
    nextSeq: position(item.nextSeq),
    running: boolean(item.running),
  };
}

export function parseRunRequest(value: unknown) {
  const item = record(value);
  if (item.status !== 'pending' && item.status !== 'started' && item.status !== 'error') throw new Error(INVALID_RESPONSE);
  const sessionId = optionalText(item.sessionId);
  const runId = optionalText(item.runId);
  if (item.status === 'started' && (!sessionId || !runId)) throw new Error(INVALID_RESPONSE);
  return { status: item.status, sessionId, runId, message: optionalText(item.message) };
}

export function parseStartedRun(value: unknown) {
  const item = record(value);
  return {
    sessionId: text(item.sessionId),
    runId: text(item.runId),
    running: boolean(item.running),
  };
}

export function parseUploadAttachment(value: unknown): UploadAttachment {
  const item = record(value);
  return {
    id: text(item.id),
    name: text(item.name),
    mime: text(item.mime),
    bytes: position(item.bytes),
    url: text(item.url),
  };
}

export function parseDeletedSession(value: unknown) {
  if (record(value).deleted !== true) throw new Error(INVALID_RESPONSE);
}

export function parseAbortedRun(value: unknown) {
  return { aborted: boolean(record(value).aborted) };
}

export function parseRunStatus(value: unknown) {
  return { running: boolean(record(value).running) };
}

export function parseHealth(value: unknown) {
  return { asideApp: boolean(record(value).asideApp) };
}
