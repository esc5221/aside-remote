export type TextBlock = {
  type: "text"
  text: string
}

export type BrowserTab = {
  targetId: string
  title: string
  url: string
  favicon?: string | null
  active: boolean
  loaded: boolean | null
  lastAccessed?: number | null
}

export type ThinkingBlock = {
  type: "thinking"
  text: string
}

export type ToolCallBlock = {
  type: "toolCall"
  id?: string
  name?: string
  args?: unknown
}

export type ImageBlock = {
  type: "image"
  mediaId: string
  mime?: string
  bytes?: number
}

export type MessageBlock = TextBlock | ThinkingBlock | ToolCallBlock | ImageBlock

export type CitationSource = { id: string; url: string; title?: string }

export type ChatMessage = {
  seq: number
  role: "user" | "assistant" | "toolResult" | "system"
  ts?: number
  responseId?: string
  blocks: MessageBlock[]
  sources?: CitationSource[]
  toolName?: string
  toolCallId?: string
  model?: string
  provider?: string
  stopReason?: string
  isError?: boolean
  usage?: {
    input?: number
    output?: number
    total?: number
    cost?: number
  }
}

export type LiveAssistant = {
  sessionId: string
  runId: string
  streamId: string
  revision: number
  text: string
  done: boolean
  messageTs?: number
  responseId?: string
}

export type ChatSession = {
  id: string
  title: string
  status: string
  unread: boolean
  isPinned: boolean
  updatedAt: string
  mtime: number
  preview: string
  lastPrompt: string
  cost?: number
  tokens?: number
  bytes: number
  hasLog: boolean
}

export type UploadAttachment = {
  id: string
  name: string
  mime: string
  bytes: number
  url: string
}

export type ModelConfig = { provider: string; modelId: string; thinkingLevel: string; fastMode: boolean }
export type AvailableModel = { id: string; name: string; provider: string; thinkingLevels: string[]; supportsFastMode: boolean }

export type QueuedMessage = {
  id: string
  prompt: string
  attachments: UploadAttachment[]
  status: "queued" | "sending" | "error"
  isEditing?: boolean
  error?: string
}

export type Toast = {
  id: string
  createdAt: number
  message: string
  tone: "error" | "success" | "info"
}

export type UseChat = {
  isReady: boolean
  isConnected: boolean
  isOpening: boolean
  isSending: boolean
  isStopping: boolean
  isUpdatingQueue: boolean
  isQueuePaused: boolean
  queuedMessages: QueuedMessage[]
  isRunning: boolean
  isLoadingSessions: boolean
  isLoadingMore: boolean
  authError?: string
  sessionId?: string
  pendingPrompt?: string
  pendingAttachments: UploadAttachment[]
  recoveredDraft?: string
  recoveredAttachments: UploadAttachment[]
  searchQuery: string
  sessions: ChatSession[]
  messages: ChatMessage[]
  liveAssistant?: LiveAssistant
  hasMore: boolean
  total: number
  matched: number
  toasts: Toast[]
  setSearchQuery: (query: string) => void
  saveToken: (token: string) => Promise<boolean>
  request: (path: string, init?: RequestInit) => Promise<Response>
  refreshSessions: () => Promise<void>
  loadMore: () => Promise<void>
  openSession: (sessionId: string) => Promise<boolean>
  newChat: () => void
  send: (prompt: string, attachments?: UploadAttachment[], model?: ModelConfig) => Promise<boolean>
  queue: (prompt: string, attachments?: UploadAttachment[]) => Promise<boolean>
  editQueuedMessage: (id: string, prompt: string, attachments?: UploadAttachment[]) => Promise<boolean>
  beginEditQueuedMessage: (id: string) => Promise<boolean>
  cancelEditQueuedMessage: (id: string) => Promise<boolean>
  deleteQueuedMessage: (id: string) => Promise<boolean>
  steerQueuedMessage: (id: string) => Promise<boolean>
  resumeQueue: () => Promise<boolean>
  upload: (file: File) => Promise<UploadAttachment>
  deleteSession: (sessionId: string) => Promise<boolean>
  updateSession: (sessionId: string, settings: { title?: string; isPinned?: boolean }) => Promise<boolean>
  abort: () => Promise<boolean>
  clearRecoveredDraft: () => void
  dismissToast: (toastId: string) => void
}
