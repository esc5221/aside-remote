export type TextBlock = {
  type: "text"
  text: string
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

export type ChatMessage = {
  seq: number
  role: "user" | "assistant" | "toolResult" | "system"
  ts?: string
  blocks: MessageBlock[]
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

export type ChatSession = {
  id: string
  title: string
  status: string
  unread: boolean
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

export type Toast = {
  id: string
  message: string
  tone: "error" | "success" | "info"
}

export type UseChat = {
  isReady: boolean
  isConnected: boolean
  isOpening: boolean
  isSending: boolean
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
  send: (prompt: string, attachments?: UploadAttachment[]) => Promise<boolean>
  upload: (file: File) => Promise<UploadAttachment>
  deleteSession: (sessionId: string) => Promise<boolean>
  abort: () => Promise<boolean>
  clearRecoveredDraft: () => void
  dismissToast: (toastId: string) => void
}
