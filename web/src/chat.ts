import { useCallback, useEffect, useRef, useState } from "react"
import { formatRequestError } from "./errors"
import { useAutoRefresh } from "./useAutoRefresh"
import {
  isRecord,
  parseChatMessage,
  parseSessionsResponse,
  parseMessagesResponse,
  parseRunRequest,
  parseStartedRun,
  parseUploadAttachment,
  parseDeletedSession,
  parseAbortedRun,
  parseRunStatus,
  parseSessionDetails,
} from "./responses"

import type {
  ChatMessage,
  ChatSession,
  LiveAssistant,
  ModelConfig,
  QueuedMessage,
  Toast,
  UploadAttachment,
  UseChat,
} from "./types"

const LAST_SESSION_KEY = "lastSession"
const LAST_SESSION_MODE_KEY = "lastSessionMode"
const TOKEN_KEY = "token"
const PAGE_SIZE = 30
const MESSAGE_TAIL = 400
const RUN_POLL_INTERVAL_MS = 6_000
const SESSION_REFRESH_INTERVAL_MS = 5_000
const QUEUE_REFRESH_INTERVAL_MS = 1_500
const FOLLOWUP_REQUEST_TIMEOUT_MS = 60_000
const RUN_REQUEST_RECOVERY_INTERVAL_MS = 750
const RUN_REQUEST_RECOVERY_MAX_ATTEMPTS = 48
const MAX_STALE_STREAM_KEYS = 128

const getRouteSessionId = () => location.pathname.match(/^\/c\/([A-Za-z0-9_-]{1,64})\/?$/)?.[1]

type PendingRequest = {
  prompt: string
  sessionId?: string
  generation: number
  resolve: (accepted: boolean) => void
}

type ActiveLiveAssistant = LiveAssistant & {
  canonicalStartSeq: number
}

type QueueResponse = { items: QueuedMessage[]; isPaused: boolean }

type SocketMessage = {
  op: string
  requestId?: string
  sessionId?: string
  runId?: string
  message?: ChatMessage
  running?: string[]
  error?: string
  streamId?: string
  revision?: number
  text?: string
  done?: boolean
  messageTs?: number
  responseId?: string
}

class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(formatRequestError({ message, status }))
    this.status = status
  }
}

const getErrorMessage = (error: unknown) => {
  return formatRequestError({ message: error instanceof Error ? error.message : undefined })
}

const createRequestId = () => {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
}

const getStreamKey = (sessionId: string, streamId: string) => `${sessionId}:${streamId}`

const getRunKey = (sessionId: string, runId: string) => `${sessionId}:${runId}`

const compareSessions = (left: ChatSession, right: ChatSession) => {
  return Number(right.isPinned) - Number(left.isPinned) || right.mtime - left.mtime || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
}

const getAssistantText = (message: ChatMessage) => {
  return message.blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
}

const isCanonicalMatch = (active: ActiveLiveAssistant, message: ChatMessage) => {
  if (message.role !== "assistant") return false
  if (active.responseId && message.responseId === active.responseId) return true
  if (active.messageTs !== undefined && message.ts === active.messageTs) return true
  if (
    active.responseId ||
    active.messageTs !== undefined ||
    message.seq < active.canonicalStartSeq
  ) {
    return false
  }
  return active.text.length > 0 && getAssistantText(message) === active.text
}

const parseApiError = async (response: Response) => {
  const body = await response.text()
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed === "object" && parsed !== null) {
      const detail = Reflect.get(parsed, "detail")
      if (typeof detail === "string") return detail
      const error = Reflect.get(parsed, "error")
      if (typeof error === "string") return error
    }
  } catch {
    // The plain response body below is more useful than a JSON parse failure.
  }
  return body || `Request failed (${response.status}).`
}

const parseQueueResponse = (value: unknown): QueueResponse => {
  if (!isRecord(value) || !Array.isArray(value.items) || typeof value.isPaused !== "boolean") {
    throw new Error("Invalid queue response.")
  }
  const items = value.items.map((item): QueuedMessage => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.prompt !== "string" ||
        !Array.isArray(item.attachments) || !["queued", "sending", "error"].includes(String(item.status))) {
      throw new Error("Invalid queued message.")
    }
    const attachments = item.attachments.map(parseUploadAttachment)
    return {
      id: item.id, prompt: item.prompt, attachments,
      status: item.status === "sending" ? "sending" : item.status === "error" ? "error" : "queued",
      isEditing: item.isEditing === true,
      error: typeof item.error === "string" ? formatRequestError({ message: item.error }) : undefined,
    }
  })
  return { items, isPaused: value.isPaused }
}

const parseSocketMessage = (raw: string): SocketMessage | undefined => {
  try {
    const value: unknown = JSON.parse(raw)
    if (!isRecord(value) || typeof value.op !== "string") return undefined
    return {
      op: value.op,
      requestId: typeof value.requestId === "string" ? value.requestId : undefined,
      sessionId: typeof value.sessionId === "string" ? value.sessionId : undefined,
      runId: typeof value.runId === "string" ? value.runId : undefined,
      message: isRecord(value.message) ? parseChatMessage(value.message) : undefined,
      running: Array.isArray(value.running)
        ? value.running.filter((item): item is string => typeof item === "string")
        : undefined,
      streamId: typeof value.streamId === "string" ? value.streamId : undefined,
      revision:
        typeof value.revision === "number" && Number.isInteger(value.revision)
          ? value.revision
          : undefined,
      text: typeof value.text === "string" ? value.text : undefined,
      done: typeof value.done === "boolean" ? value.done : undefined,
      messageTs:
        typeof value.messageTs === "number" && Number.isFinite(value.messageTs)
          ? value.messageTs
          : undefined,
      responseId: typeof value.responseId === "string" ? value.responseId : undefined,
      error:
        typeof value.message === "string"
          ? formatRequestError({ message: value.message })
          : typeof value.error === "string"
            ? formatRequestError({ message: value.error })
            : undefined,
    }
  } catch {
    return undefined
  }
}

export const useChat = (): UseChat => {
  const [isReady, setIsReady] = useState(false)
  const [isConnected, setIsConnected] = useState(false)
  const [isOpening, setIsOpening] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [isUpdatingQueue, setIsUpdatingQueue] = useState(false)
  const [queueState, setQueueState] = useState<QueueResponse & { sessionId: string }>()
  const [isLoadingSessions, setIsLoadingSessions] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [authError, setAuthError] = useState<string>()
  const [sessionId, setSessionId] = useState<string | undefined>(getRouteSessionId)
  const [pendingPrompt, setPendingPrompt] = useState<string>()
  const [pendingAttachments, setPendingAttachments] = useState<UploadAttachment[]>([])
  const [recoveredDraft, setRecoveredDraft] = useState<string>()
  const [recoveredAttachments, setRecoveredAttachments] = useState<UploadAttachment[]>([])
  const [searchQuery, setSearchQueryState] = useState("")
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [liveAssistant, setLiveAssistant] = useState<LiveAssistant>()
  const [cursor, setCursor] = useState<string>()
  const [total, setTotal] = useState(0)
  const [matched, setMatched] = useState(0)
  const [runningSessionIds, setRunningSessionIds] = useState<string[]>([])
  const [toasts, setToasts] = useState<Toast[]>([])

  const tokenRef = useRef("")
  const socketRef = useRef<WebSocket | undefined>(undefined)
  const reconnectTimerRef = useRef<number | undefined>(undefined)
  const reconnectAttemptsRef = useRef(0)
  const sessionIdRef = useRef<string | undefined>(undefined)
  const searchQueryRef = useRef("")
  const cursorRef = useRef<string | undefined>(undefined)
  const nextSeqRef = useRef(0)
  const offsetRef = useRef(0)
  const pendingPromptRef = useRef<string | undefined>(undefined)
  const pendingAttachmentsRef = useRef<UploadAttachment[]>([])
  const pendingStartSeqRef = useRef(0)
  const activeSendRef = useRef<string | undefined>(undefined)
  const openGenerationRef = useRef(0)
  const listGenerationRef = useRef(0)
  const sessionsRef = useRef<ChatSession[]>([])
  const pendingRequestsRef = useRef(new Map<string, PendingRequest>())
  const recoveringRequestIdsRef = useRef(new Set<string>())
  const messagesRef = useRef<ChatMessage[]>([])
  const liveAssistantRef = useRef<ActiveLiveAssistant | undefined>(undefined)
  const activeRunIdsRef = useRef(new Map<string, string>())
  const retiredStreamIdsRef = useRef(new Set<string>())
  const abortedRunIdsRef = useRef(new Set<string>())
  const isUnmountedRef = useRef(false)
  const queueMutationRef = useRef<string | undefined>(undefined)
  const queueRevisionRef = useRef(0)
  const followupRequestRef = useRef<{ key: string; id: string } | undefined>(undefined)
  const heldQueueEditRef = useRef<{ sessionId: string; id: string } | undefined>(undefined)

  const rememberRetiredStream = useCallback((selectedSessionId: string, streamId: string) => {
    const retired = retiredStreamIdsRef.current
    retired.add(getStreamKey(selectedSessionId, streamId))
    if (retired.size > MAX_STALE_STREAM_KEYS) {
      const oldest = retired.values().next().value
      if (typeof oldest === "string") retired.delete(oldest)
    }
  }, [])

  const retireLiveAssistant = useCallback(
    (expectedSessionId?: string, expectedStreamId?: string) => {
      const active = liveAssistantRef.current
      if (
        !active ||
        (expectedSessionId !== undefined && active.sessionId !== expectedSessionId) ||
        (expectedStreamId !== undefined && active.streamId !== expectedStreamId)
      ) {
        return
      }
      rememberRetiredStream(active.sessionId, active.streamId)
      liveAssistantRef.current = undefined
      setLiveAssistant(undefined)
    },
    [rememberRetiredStream],
  )

  const reconcileLiveAssistant = useCallback(
    (canonicalMessages: ChatMessage[]) => {
      const active = liveAssistantRef.current
      if (!active || active.sessionId !== sessionIdRef.current) return
      const reconciled = canonicalMessages.some((message) => isCanonicalMatch(active, message))
      if (reconciled) retireLiveAssistant(active.sessionId, active.streamId)
    },
    [retireLiveAssistant],
  )

  const pushToast = useCallback(
    (message: string, tone: Toast["tone"] = "error") => {
      const toast = { id: createRequestId(), createdAt: Date.now(), message, tone }
      setToasts((current) => [...current, toast])
    },
    [],
  )

  const dismissToast = useCallback((toastId: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== toastId))
  }, [])

  const updateSessions = useCallback(
    (update: (current: ChatSession[]) => ChatSession[]) => {
      const next = update(sessionsRef.current)
      sessionsRef.current = next
      setSessions(next)
    },
    [],
  )

  const request = useCallback(async (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    if (tokenRef.current) headers.set("Authorization", `Bearer ${tokenRef.current}`)
    if (init?.body && typeof init.body === "string") {
      headers.set("Content-Type", "application/json")
    }
    const response = await fetch(path, { ...init, headers })
    if (!response.ok) throw new ApiError(response.status, await parseApiError(response))
    return response
  }, [])

  const api = useCallback(async <T,>(path: string, parse: (value: unknown) => T, init?: RequestInit) => {
    const response = await request(path, init)
    const value: unknown = await response.json()
    return parse(value)
  }, [request])

  const releaseQueueEdit = useCallback(() => {
    const held = heldQueueEditRef.current
    if (!held) return
    heldQueueEditRef.current = undefined
    void request(`/api/sessions/${encodeURIComponent(held.sessionId)}/followups/${encodeURIComponent(held.id)}`, {
      method: "PATCH", body: JSON.stringify({ isEditing: false }), keepalive: true,
      signal: AbortSignal.timeout(FOLLOWUP_REQUEST_TIMEOUT_MS),
    }).catch(() => undefined)
  }, [request])

  const refreshQueue = useCallback(async (signal?: AbortSignal) => {
    const selectedSessionId = sessionIdRef.current
    if (!selectedSessionId || queueMutationRef.current) return
    const generation = openGenerationRef.current
    const revision = ++queueRevisionRef.current
    try {
      const response = await request(`/api/sessions/${encodeURIComponent(selectedSessionId)}/followups`, { cache: "no-store", signal })
      const result = parseQueueResponse(await response.json())
      if (!signal?.aborted && !isUnmountedRef.current && generation === openGenerationRef.current &&
          selectedSessionId === sessionIdRef.current && revision === queueRevisionRef.current && !queueMutationRef.current) {
        setQueueState({ ...result, sessionId: selectedSessionId })
      }
    } catch {
      // Keep the last queue until the next refresh or connection recovery.
    }
  }, [request])

  const sendSocket = useCallback((payload: object) => {
    const socket = socketRef.current
    if (socket?.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(payload))
    return true
  }, [])

  const subscribe = useCallback(
    (selectedSessionId: string) => {
      sendSocket({
        op: "sub",
        sessionId: selectedSessionId,
        fromSeq: nextSeqRef.current,
        fromOffset: offsetRef.current,
      })
    },
    [sendSocket],
  )

  const fetchMessages = useCallback(
    async (selectedSessionId: string, generation: number) => {
      const result = await api(
        `/api/sessions/${encodeURIComponent(selectedSessionId)}/messages?tail=${MESSAGE_TAIL}`, parseMessagesResponse,
      )
      if (
        isUnmountedRef.current ||
        generation !== openGenerationRef.current ||
        sessionIdRef.current !== selectedSessionId
      ) {
        return false
      }
      messagesRef.current = result.messages
      setMessages(result.messages)
      reconcileLiveAssistant(result.messages)
      nextSeqRef.current = result.nextSeq
      offsetRef.current = result.offset
      if (
        pendingPromptRef.current !== undefined &&
        result.messages.some(
          (message) => message.role === "user" && message.seq >= pendingStartSeqRef.current,
        )
      ) {
        setPendingPrompt(undefined)
        pendingPromptRef.current = undefined
        setPendingAttachments([])
        pendingAttachmentsRef.current = []
      }
      setRunningSessionIds((current) => {
        const withoutSelected = current.filter((id) => id !== selectedSessionId)
        return result.running ? [...withoutSelected, selectedSessionId] : withoutSelected
      })
      subscribe(selectedSessionId)
      return result.messages.length > 0 || result.running
    },
    [api, reconcileLiveAssistant, subscribe],
  )

  const loadSessionPage = useCallback(
    async (mode: "reset" | "refresh" | "more", signal?: AbortSignal) => {
      if (mode === "more" && !cursorRef.current) return
      const generation = ++listGenerationRef.current
      const cursorBefore = cursorRef.current
      const hadSessions = sessionsRef.current.length > 0
      mode === "more" ? setIsLoadingMore(true) : setIsLoadingSessions(true)
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) })
      if (mode === "more" && cursorRef.current) params.set("cursor", cursorRef.current)
      if (searchQueryRef.current.trim()) params.set("q", searchQueryRef.current.trim())
      try {
        const result = await api(`/api/sessions?${params}`, parseSessionsResponse, { cache: "no-store", signal })
        if (signal?.aborted || generation !== listGenerationRef.current || isUnmountedRef.current) return
        updateSessions((current) => {
          const firstPageTail = result.items.at(-1)
          const previous =
            mode === "more"
              ? current
              : mode === "refresh" && result.nextCursor && firstPageTail != null
                ? current.filter((item) => compareSessions(item, firstPageTail) > 0)
                : []
          const byId = new Map(previous.map((item) => [item.id, item]))
          const existingById = new Map(current.map((item) => [item.id, item]))
          result.items.forEach((item) => {
            const existing = existingById.get(item.id)
            byId.set(item.id, existing && existing.mtime > item.mtime
              ? { ...item, mtime: existing.mtime, updatedAt: existing.updatedAt }
              : item)
          })
          return [...byId.values()].sort(compareSessions)
        })
        const nextCursor =
          mode === "refresh" && hadSessions && result.nextCursor ? cursorBefore : result.nextCursor
        cursorRef.current = nextCursor
        setCursor(nextCursor)
        setTotal(result.total)
        setMatched(result.matched)
      } catch (error) {
        if (!signal?.aborted && generation === listGenerationRef.current && !isUnmountedRef.current) {
          if (error instanceof ApiError && error.status === 401) {
            setAuthError("Authentication failed. Sign in again and reload the page.")
          } else if (mode !== "refresh") {
            pushToast(`Couldn't load conversations. ${getErrorMessage(error)}`)
          }
        }
      } finally {
        if (generation === listGenerationRef.current && !isUnmountedRef.current) {
          setIsLoadingSessions(false)
          setIsLoadingMore(false)
        }
      }
    },
    [api, pushToast, updateSessions],
  )

  const refreshSessions = useCallback(async (signal?: AbortSignal) => {
    await loadSessionPage("refresh", signal)
  }, [loadSessionPage])

  const loadMore = useCallback(async () => {
    await loadSessionPage("more")
  }, [loadSessionPage])

  const cancelPendingRequests = useCallback(() => {
    pendingRequestsRef.current.forEach((pending) => pending.resolve(false))
    pendingRequestsRef.current.clear()
    activeSendRef.current = undefined
    setIsSending(false)
  }, [])

  const openSession = useCallback(
    async (selectedSessionId: string, shouldNavigate = true) => {
      releaseQueueEdit()
      cancelPendingRequests()
      const previousSessionId = sessionIdRef.current
      if (previousSessionId && previousSessionId !== selectedSessionId) {
        sendSocket({ op: "unsub", sessionId: previousSessionId })
      }
      const generation = ++openGenerationRef.current
      retireLiveAssistant()
      sessionIdRef.current = selectedSessionId
      setSessionId(selectedSessionId)
      messagesRef.current = []
      setMessages([])
      setPendingPrompt(undefined)
      pendingPromptRef.current = undefined
      setPendingAttachments([])
      pendingAttachmentsRef.current = []
      setIsOpening(true)
      nextSeqRef.current = 0
      offsetRef.current = 0
      localStorage.setItem(LAST_SESSION_KEY, selectedSessionId)
      localStorage.setItem(LAST_SESSION_MODE_KEY, "session")
      if (
        shouldNavigate &&
        location.pathname !== `/c/${encodeURIComponent(selectedSessionId)}`
      ) {
        history.pushState({}, "", `/c/${encodeURIComponent(selectedSessionId)}`)
      }
      try {
        const exists = await fetchMessages(selectedSessionId, generation)
        if (!exists && generation === openGenerationRef.current) {
          sessionIdRef.current = undefined
          setSessionId(undefined)
          localStorage.removeItem(LAST_SESSION_KEY)
          if (location.pathname.startsWith("/c/")) history.replaceState({}, "", "/")
          pushToast("That conversation is no longer available.")
        }
        return exists
      } catch (error) {
        if (
          generation === openGenerationRef.current &&
          sessionIdRef.current === selectedSessionId
        ) {
          pushToast(`Couldn't open the conversation. ${getErrorMessage(error)}`)
        }
        return false
      } finally {
        if (generation === openGenerationRef.current && !isUnmountedRef.current) {
          setIsOpening(false)
        }
      }
    },
    [cancelPendingRequests, fetchMessages, pushToast, releaseQueueEdit, retireLiveAssistant, sendSocket],
  )

  const restoreSavedSession = useCallback(async (sessionPage?: Promise<void>) => {
    const routeSessionId = getRouteSessionId()
    const mode = localStorage.getItem(LAST_SESSION_MODE_KEY)
    const savedSessionId = localStorage.getItem(LAST_SESSION_KEY)
    const lastSessionId = routeSessionId ?? (mode === "new" ? undefined : savedSessionId)
    if (lastSessionId) {
      const restored = await openSession(lastSessionId, Boolean(routeSessionId))
      if (!restored && !routeSessionId) {
        await sessionPage
        if (sessionsRef.current[0]) await openSession(sessionsRef.current[0].id, false)
      }
      return
    }
    if (mode === "new") return
    await sessionPage
    if (sessionsRef.current[0]) {
      await openSession(sessionsRef.current[0].id, false)
    }
  }, [openSession])

  const newChat = useCallback(() => {
    releaseQueueEdit()
    cancelPendingRequests()
    const previousSessionId = sessionIdRef.current
    if (previousSessionId) sendSocket({ op: "unsub", sessionId: previousSessionId })
    openGenerationRef.current += 1
    retireLiveAssistant()
    sessionIdRef.current = undefined
    setSessionId(undefined)
    messagesRef.current = []
    setMessages([])
    setPendingPrompt(undefined)
    pendingPromptRef.current = undefined
    setPendingAttachments([])
    pendingAttachmentsRef.current = []
    setIsOpening(false)
    nextSeqRef.current = 0
    offsetRef.current = 0
    localStorage.removeItem(LAST_SESSION_KEY)
    localStorage.setItem(LAST_SESSION_MODE_KEY, "new")
    if (location.pathname !== "/") history.pushState({}, "", "/")
  }, [cancelPendingRequests, releaseQueueEdit, retireLiveAssistant, sendSocket])

  const settlePendingRequest = useCallback(
    (requestId: string, accepted: boolean, error?: string) => {
      const pending = pendingRequestsRef.current.get(requestId)
      if (!pending) return undefined
      pendingRequestsRef.current.delete(requestId)
      if (activeSendRef.current === requestId) activeSendRef.current = undefined
      pending.resolve(accepted)
      setIsSending(pendingRequestsRef.current.size > 0)
      if (!accepted) {
        setPendingPrompt(undefined)
        pendingPromptRef.current = undefined
        setPendingAttachments([])
        pendingAttachmentsRef.current = []
        pushToast(error ? formatRequestError({ message: error }) : "The message couldn't be sent.")
      }
      return pending
    },
    [pushToast],
  )

  const acceptRun = useCallback(
    (requestId: string, acceptedSessionId: string, runId: string) => {
      const pending = pendingRequestsRef.current.get(requestId)
      if (
        !pending ||
        pending.generation !== openGenerationRef.current ||
        pending.sessionId !== sessionIdRef.current
      ) {
        return
      }
      const accepted = settlePendingRequest(requestId, true)
      if (!accepted) return
      activeRunIdsRef.current.set(acceptedSessionId, runId)
      setRunningSessionIds((current) =>
        current.includes(acceptedSessionId) ? current : [...current, acceptedSessionId],
      )
      if (!accepted.sessionId && sessionIdRef.current === undefined) {
        const generation = ++openGenerationRef.current
        sessionIdRef.current = acceptedSessionId
        setSessionId(acceptedSessionId)
        localStorage.setItem(LAST_SESSION_KEY, acceptedSessionId)
        localStorage.setItem(LAST_SESSION_MODE_KEY, "session")
        nextSeqRef.current = 0
        offsetRef.current = 0
        history.pushState({}, "", `/c/${encodeURIComponent(acceptedSessionId)}`)
        void fetchMessages(acceptedSessionId, generation).catch(() => {
          if (
            generation === openGenerationRef.current &&
            sessionIdRef.current === acceptedSessionId
          ) {
            subscribe(acceptedSessionId)
          }
        })
      }
      void refreshSessions()
    },
    [fetchMessages, refreshSessions, settlePendingRequest, subscribe],
  )

  const recoverPendingRequest = useCallback(
    async (requestId: string) => {
      if (recoveringRequestIdsRef.current.has(requestId)) return
      recoveringRequestIdsRef.current.add(requestId)
      try {
        for (let attempt = 0; attempt < RUN_REQUEST_RECOVERY_MAX_ATTEMPTS; attempt += 1) {
          const pending = pendingRequestsRef.current.get(requestId)
          if (
            !pending ||
            pending.generation !== openGenerationRef.current ||
            pending.sessionId !== sessionIdRef.current
          ) {
            return
          }
          try {
            const result = await api(
              `/api/run-requests/${encodeURIComponent(requestId)}`, parseRunRequest,
            )
            if (result.status === "started" && result.sessionId && result.runId) {
              acceptRun(requestId, result.sessionId, result.runId)
              return
            }
            if (result.status === "error") {
              settlePendingRequest(requestId, false, result.message || "The message wasn't accepted.")
              return
            }
          } catch {
            // The request may not have reached the registry before the socket closed.
          }
          await new Promise<void>((resolve) =>
            window.setTimeout(resolve, RUN_REQUEST_RECOVERY_INTERVAL_MS),
          )
        }
        if (pendingRequestsRef.current.has(requestId)) {
          settlePendingRequest(
            requestId,
            false,
            "Delivery status is unknown. Your draft was kept; check the conversation before sending it again.",
          )
        }
      } finally {
        recoveringRequestIdsRef.current.delete(requestId)
      }
    },
    [acceptRun, api, settlePendingRequest],
  )

  const handleSocketMessage = useCallback(
    (event: MessageEvent<string>) => {
      const payload = parseSocketMessage(event.data)
      if (!payload) return
      if (payload.op === "ping") {
        sendSocket({ op: "pong" })
        return
      }
      if (payload.op === "hello") {
        setRunningSessionIds((current) => [...new Set([...current, ...(payload.running ?? [])])])
        return
      }
      if (payload.op === "queue.changed" && payload.sessionId === sessionIdRef.current) {
        void refreshQueue()
        return
      }
      if (payload.op === "run.started" && !payload.requestId && payload.sessionId && payload.runId) {
        const startedSessionId = payload.sessionId
        activeRunIdsRef.current.set(startedSessionId, payload.runId)
        setRunningSessionIds((current) => current.includes(startedSessionId) ? current : [...current, startedSessionId])
        if (payload.sessionId === sessionIdRef.current) {
          void fetchMessages(payload.sessionId, openGenerationRef.current).catch(() => undefined)
          void refreshQueue()
        }
        return
      }
      if (
        payload.op === "run.started" &&
        payload.requestId &&
        payload.sessionId &&
        payload.runId
      ) {
        acceptRun(payload.requestId, payload.sessionId, payload.runId)
        return
      }
      if (payload.op === "error" && payload.requestId) {
        settlePendingRequest(payload.requestId, false, payload.error)
        return
      }
      if (
        payload.op === "msg.delta" &&
        payload.sessionId &&
        payload.runId &&
        payload.streamId &&
        payload.revision !== undefined &&
        payload.text !== undefined &&
        payload.done !== undefined
      ) {
        if (payload.sessionId !== sessionIdRef.current || payload.revision < 0) return
        const streamKey = getStreamKey(payload.sessionId, payload.streamId)
        if (
          retiredStreamIdsRef.current.has(streamKey) ||
          abortedRunIdsRef.current.has(getRunKey(payload.sessionId, payload.runId))
        ) {
          return
        }
        const current = liveAssistantRef.current
        if (
          current?.sessionId === payload.sessionId &&
          current.streamId === payload.streamId &&
          payload.revision <= current.revision
        ) {
          return
        }
        const sameStream =
          current?.sessionId === payload.sessionId && current.streamId === payload.streamId
        const next: ActiveLiveAssistant = {
          sessionId: payload.sessionId,
          runId: payload.runId,
          streamId: payload.streamId,
          revision: payload.revision,
          text: payload.text,
          done: payload.done,
          messageTs: payload.messageTs ?? (sameStream ? current.messageTs : undefined),
          responseId: payload.responseId ?? (sameStream ? current.responseId : undefined),
          canonicalStartSeq: sameStream ? current.canonicalStartSeq : nextSeqRef.current,
        }
        const alreadyCanonical = messagesRef.current.some((message) => {
          if (isCanonicalMatch(next, message)) return true
          return (
            !next.responseId &&
            next.messageTs === undefined &&
            next.done &&
            message.role === "assistant" &&
            message.seq === nextSeqRef.current - 1 &&
            getAssistantText(message) === next.text
          )
        })
        if (alreadyCanonical) {
          if (sameStream) retireLiveAssistant(next.sessionId, next.streamId)
          rememberRetiredStream(next.sessionId, next.streamId)
          return
        }
        if (current && !sameStream) {
          retireLiveAssistant(current.sessionId, current.streamId)
        }
        liveAssistantRef.current = next
        activeRunIdsRef.current.set(next.sessionId, next.runId)
        setLiveAssistant({
          sessionId: next.sessionId,
          runId: next.runId,
          streamId: next.streamId,
          revision: next.revision,
          text: next.text,
          done: next.done,
          messageTs: next.messageTs,
          responseId: next.responseId,
        })
        return
      }
      if (payload.op === "msg" && payload.sessionId && payload.message) {
        const incomingMessage = payload.message
        if ((incomingMessage.role === "user" || incomingMessage.role === "assistant") &&
            typeof incomingMessage.ts === "number" && Number.isFinite(incomingMessage.ts)) {
          const timestamp = incomingMessage.ts / 1000
          const updatedAt = new Date(incomingMessage.ts).toISOString()
          updateSessions((current) => current.map((session) =>
            session.id === payload.sessionId && timestamp > session.mtime
              ? { ...session, mtime: timestamp, updatedAt }
              : session,
          ).sort(compareSessions))
          if (incomingMessage.role === "user") void refreshSessions()
        }
        if (payload.sessionId !== sessionIdRef.current) return
        if (incomingMessage.role === "user") {
          setPendingPrompt(undefined)
          pendingPromptRef.current = undefined
          setPendingAttachments([])
          pendingAttachmentsRef.current = []
        }
        const currentMessages = messagesRef.current
        const index = currentMessages.findIndex((message) => message.seq === incomingMessage.seq)
        const nextMessages =
          index < 0
            ? [...currentMessages, incomingMessage]
            : currentMessages.map((message, itemIndex) =>
                itemIndex === index ? incomingMessage : message,
              )
        messagesRef.current = nextMessages
        setMessages(nextMessages)
        reconcileLiveAssistant([incomingMessage])
        nextSeqRef.current = Math.max(nextSeqRef.current, incomingMessage.seq + 1)
        return
      }
      if (payload.op === "run.done" && payload.sessionId && payload.runId) {
        const activeRunId = activeRunIdsRef.current.get(payload.sessionId)
        if (activeRunId && activeRunId !== payload.runId) {
          void refreshSessions()
          return
        }
        activeRunIdsRef.current.delete(payload.sessionId)
        setRunningSessionIds((current) => current.filter((id) => id !== payload.sessionId))
        if (payload.sessionId === sessionIdRef.current) {
          const generation = openGenerationRef.current
          void fetchMessages(payload.sessionId, generation)
            .then(() => {
              if (
                generation !== openGenerationRef.current ||
                payload.sessionId !== sessionIdRef.current
              ) {
                return
              }
              if (pendingPromptRef.current !== undefined) {
                setRecoveredDraft(pendingPromptRef.current)
                setRecoveredAttachments(pendingAttachmentsRef.current)
                setPendingPrompt(undefined)
                pendingPromptRef.current = undefined
                setPendingAttachments([])
                pendingAttachmentsRef.current = []
                pushToast(`${payload.error ?? "The response couldn't start."} Your message was restored.`)
              } else if (payload.error) {
                pushToast(payload.error)
              }
            })
            .catch(() => {
              if (
                generation !== openGenerationRef.current ||
                payload.sessionId !== sessionIdRef.current ||
                pendingPromptRef.current === undefined
              ) {
                return
              }
              setRecoveredDraft(pendingPromptRef.current)
              setRecoveredAttachments(pendingAttachmentsRef.current)
              setPendingPrompt(undefined)
              pendingPromptRef.current = undefined
              setPendingAttachments([])
              pendingAttachmentsRef.current = []
              pushToast("The response ended, but its messages couldn't be loaded. Your message was restored.")
            })
        }
        void refreshSessions()
        return
      }
      if (payload.op === "session.deleted" && payload.sessionId) {
        updateSessions((current) =>
          current.filter((session) => session.id !== payload.sessionId),
        )
        if (payload.sessionId === sessionIdRef.current) newChat()
      }
    },
    [
      acceptRun,
      fetchMessages,
      newChat,
      pushToast,
      reconcileLiveAssistant,
      rememberRetiredStream,
      refreshSessions,
      refreshQueue,
      retireLiveAssistant,
      sendSocket,
      settlePendingRequest,
      subscribe,
      updateSessions,
    ],
  )

  const connectSocket = useCallback(() => {
    if (isUnmountedRef.current) return
    const current = socketRef.current
    if (current?.readyState === WebSocket.OPEN || current?.readyState === WebSocket.CONNECTING) return
    const protocol = location.protocol === "https:" ? "wss:" : "ws:"
    const socket = new WebSocket(`${protocol}//${location.host}/ws`)
    socketRef.current = socket
    socket.onopen = () => {
      if (socketRef.current !== socket) return
      reconnectAttemptsRef.current = 0
      setIsConnected(true)
      const selectedSessionId = sessionIdRef.current
      if (selectedSessionId) {
        const generation = openGenerationRef.current
        void fetchMessages(selectedSessionId, generation).catch(() => {
          if (
            generation === openGenerationRef.current &&
            sessionIdRef.current === selectedSessionId
          ) {
            subscribe(selectedSessionId)
          }
        })
      }
    }
    socket.onmessage = handleSocketMessage
    socket.onerror = () => undefined
    socket.onclose = () => {
      if (socketRef.current !== socket || isUnmountedRef.current) return
      socketRef.current = undefined
      setIsConnected(false)
      pendingRequestsRef.current.forEach((_pending, requestId) => {
        void recoverPendingRequest(requestId)
      })
      const delay = Math.min(20_000, 1_000 * 2 ** reconnectAttemptsRef.current++)
      reconnectTimerRef.current = window.setTimeout(connectSocket, delay)
    }
  }, [fetchMessages, handleSocketMessage, recoverPendingRequest, subscribe])

  const send = useCallback(
    async (prompt: string, attachments: UploadAttachment[] = [], model?: ModelConfig) => {
      const text = prompt.trim()
      if (!text && attachments.length === 0) return false
      const selectedSessionId = sessionIdRef.current
      if (activeSendRef.current) return false
      const generation = openGenerationRef.current
      const requestId = createRequestId()
      activeSendRef.current = requestId
      const payloadAttachments = attachments.map(({ id, name }) => ({ id, name }))
      const modelOptions = !selectedSessionId && model ? {
        model: `${model.provider}/${model.modelId}`, effort: model.thinkingLevel, speed: model.fastMode ? "fast" : "default",
      } : {}
      const socket = socketRef.current
      setPendingPrompt(prompt)
      pendingPromptRef.current = prompt
      setPendingAttachments(attachments)
      pendingAttachmentsRef.current = attachments
      pendingStartSeqRef.current = nextSeqRef.current
      setIsSending(true)
      if (socket?.readyState === WebSocket.OPEN) {
        return new Promise<boolean>((resolve) => {
          pendingRequestsRef.current.set(requestId, {
            prompt,
            sessionId: selectedSessionId,
            generation,
            resolve,
          })
          socket.send(
            JSON.stringify(
              selectedSessionId
                ? {
                    op: "continue",
                    requestId,
                    sessionId: selectedSessionId,
                    prompt: text,
                    attachments: payloadAttachments,
                  }
                : { op: "run", requestId, prompt: text, attachments: payloadAttachments, ...modelOptions },
            ),
          )
        })
      }
      try {
        const path = selectedSessionId
          ? `/api/sessions/${encodeURIComponent(selectedSessionId)}/messages`
          : "/api/runs"
        const result = await api(path, parseStartedRun, {
          method: "POST",
          body: JSON.stringify({ prompt: text, attachments: payloadAttachments, ...modelOptions }),
        })
        if (
          activeSendRef.current !== requestId ||
          generation !== openGenerationRef.current ||
          sessionIdRef.current !== selectedSessionId
        ) {
          return false
        }
        if (!selectedSessionId) {
          sessionIdRef.current = result.sessionId
          setSessionId(result.sessionId)
          localStorage.setItem(LAST_SESSION_KEY, result.sessionId)
          localStorage.setItem(LAST_SESSION_MODE_KEY, "session")
          subscribe(result.sessionId)
          history.pushState({}, "", `/c/${encodeURIComponent(result.sessionId)}`)
        }
        activeRunIdsRef.current.set(result.sessionId, result.runId)
        setRunningSessionIds((current) =>
          current.includes(result.sessionId) ? current : [...current, result.sessionId],
        )
        void refreshSessions()
        return true
      } catch (error) {
        if (
          activeSendRef.current === requestId &&
          generation === openGenerationRef.current &&
          sessionIdRef.current === selectedSessionId
        ) {
          setPendingPrompt(undefined)
          pendingPromptRef.current = undefined
          setPendingAttachments([])
          pendingAttachmentsRef.current = []
          pushToast(`Couldn't send the message. ${getErrorMessage(error)}`)
        }
        return false
      } finally {
        if (activeSendRef.current === requestId) {
          activeSendRef.current = undefined
          setIsSending(false)
        }
      }
    },
    [api, pushToast, refreshSessions, subscribe],
  )

  const mutateQueue = useCallback(async ({ suffix, method, body }: {
    suffix: string; method: string; body?: object;
  }) => {
    const selectedSessionId = sessionIdRef.current
    if (!selectedSessionId || queueMutationRef.current || activeSendRef.current) return false
    const generation = openGenerationRef.current
    const mutationId = createRequestId()
    queueMutationRef.current = mutationId
    queueRevisionRef.current += 1
    setIsUpdatingQueue(true)
    try {
      const response = await request(`/api/sessions/${encodeURIComponent(selectedSessionId)}/${suffix}`, {
        method, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(FOLLOWUP_REQUEST_TIMEOUT_MS),
      })
      const value: unknown = await response.json()
      const result = parseQueueResponse(value)
      if (!isUnmountedRef.current && generation === openGenerationRef.current && selectedSessionId === sessionIdRef.current) {
        setQueueState({ ...result, sessionId: selectedSessionId })
        const steeredItemId = suffix.match(/^followups\/([^/]+)\/steer$/)?.[1]
        if (steeredItemId && result.items.some(item => item.id === steeredItemId)) {
          pushToast("The message could not be delivered. It is still in your queue.")
          return false
        }
        if (suffix.endsWith("/steer")) {
          setRunningSessionIds((current) => current.includes(selectedSessionId) ? current : [...current, selectedSessionId])
          void fetchMessages(selectedSessionId, generation).catch(() => undefined)
        }
      }
      return true
    } catch (error) {
      if (!isUnmountedRef.current && generation === openGenerationRef.current && selectedSessionId === sessionIdRef.current) {
        pushToast(`Couldn't update the message. ${getErrorMessage(error)}`)
      }
      return false
    } finally {
      if (queueMutationRef.current === mutationId) {
        queueMutationRef.current = undefined
        queueRevisionRef.current += 1
        if (!isUnmountedRef.current) {
          setIsUpdatingQueue(false)
          void refreshQueue()
        }
      }
    }
  }, [fetchMessages, pushToast, refreshQueue, request])

  const queue = useCallback(async (prompt: string, attachments: UploadAttachment[] = []) => {
    if (!prompt.trim() && attachments.length === 0) return false
    const payloadAttachments = attachments.map(({ id, name }) => ({ id, name }))
    const key = JSON.stringify({ sessionId: sessionIdRef.current, prompt, attachments: payloadAttachments })
    if (followupRequestRef.current?.key !== key) followupRequestRef.current = { key, id: createRequestId() }
    const accepted = await mutateQueue({
      suffix: "followups", method: "POST",
      body: { id: followupRequestRef.current.id, prompt: prompt.trim(), attachments: payloadAttachments },
    })
    if (accepted && followupRequestRef.current?.key === key) followupRequestRef.current = undefined
    return accepted
  }, [mutateQueue])

  const editQueuedMessage = useCallback(async (id: string, prompt: string, attachments?: UploadAttachment[]) => {
    const accepted = await mutateQueue({
      suffix: `followups/${encodeURIComponent(id)}`, method: "PATCH",
      body: { prompt: prompt.trim(), isEditing: false, ...(attachments ? { attachments: attachments.map(({ id, name }) => ({ id, name })) } : {}) },
    })
    if (accepted && heldQueueEditRef.current?.id === id) heldQueueEditRef.current = undefined
    return accepted
  }, [mutateQueue])
  const beginEditQueuedMessage = useCallback(async (id: string) => {
    const selectedSessionId = sessionIdRef.current
    if (!selectedSessionId) return false
    releaseQueueEdit()
    const generation = openGenerationRef.current
    heldQueueEditRef.current = { sessionId: selectedSessionId, id }
    const accepted = await mutateQueue({ suffix: `followups/${encodeURIComponent(id)}`, method: "PATCH", body: { isEditing: true } })
    if (!accepted || isUnmountedRef.current || generation !== openGenerationRef.current || selectedSessionId !== sessionIdRef.current) {
      releaseQueueEdit()
      return false
    }
    return true
  }, [mutateQueue, releaseQueueEdit])
  const cancelEditQueuedMessage = useCallback(async (id: string) => {
    const accepted = await mutateQueue({ suffix: `followups/${encodeURIComponent(id)}`, method: "PATCH", body: { isEditing: false } })
    if (accepted && heldQueueEditRef.current?.id === id) heldQueueEditRef.current = undefined
    return accepted
  }, [mutateQueue])
  const deleteQueuedMessage = useCallback((id: string) => mutateQueue({ suffix: `followups/${encodeURIComponent(id)}`, method: "DELETE" }), [mutateQueue])
  const steerQueuedMessage = useCallback((id: string) => mutateQueue({ suffix: `followups/${encodeURIComponent(id)}/steer`, method: "POST" }), [mutateQueue])
  const resumeQueue = useCallback(() => mutateQueue({ suffix: "followups/resume", method: "POST" }), [mutateQueue])

  const upload = useCallback(
    async (file: File) => {
      try {
        return await api("/api/upload", parseUploadAttachment, {
          method: "POST",
          headers: { "X-Filename": encodeURIComponent(file.name || "image") },
          body: file,
        })
      } catch (error) {
        pushToast(`Couldn't upload the image. ${getErrorMessage(error)}`)
        throw error
      }
    },
    [api, pushToast],
  )

  const saveToken = useCallback(
    async (token: string) => {
      const normalized = token.trim()
      if (!normalized) {
        pushToast("Enter an access token.")
        return false
      }
      try {
        const response = await fetch("/api/auth", {
          method: "POST",
          headers: { Authorization: `Bearer ${normalized}` },
        })
        if (!response.ok) throw new ApiError(response.status, await parseApiError(response))
        tokenRef.current = normalized
        localStorage.setItem(TOKEN_KEY, normalized)
        setAuthError(undefined)
        socketRef.current?.close()
        socketRef.current = undefined
        connectSocket()
        await loadSessionPage("reset")
        await restoreSavedSession()
        pushToast("Access token saved.", "success")
        return true
      } catch (error) {
        pushToast(`Couldn't verify the access token. ${getErrorMessage(error)}`)
        return false
      }
    },
    [connectSocket, loadSessionPage, pushToast, restoreSavedSession],
  )

  const deleteSession = useCallback(
    async (deletedSessionId: string) => {
      try {
        await api(`/api/sessions/${encodeURIComponent(deletedSessionId)}`, parseDeletedSession, {
          method: "DELETE",
        })
        updateSessions((current) =>
          current.filter((session) => session.id !== deletedSessionId),
        )
        if (deletedSessionId === sessionIdRef.current) newChat()
        pushToast("Conversation deleted.", "success")
        void refreshSessions()
        return true
      } catch (error) {
        pushToast(`Couldn't delete the conversation. ${getErrorMessage(error)}`)
        return false
      }
    },
    [api, newChat, pushToast, refreshSessions, updateSessions],
  )

  const updateSession = useCallback(async (id: string, settings: { title?: string; isPinned?: boolean }) => {
    try {
      const details = await api(`/api/sessions/${encodeURIComponent(id)}`, parseSessionDetails, {
        method: "PATCH", body: JSON.stringify(settings),
      })
      updateSessions(current => current.map(session => session.id === id ? { ...session, ...details } : session).sort(compareSessions))
      void refreshSessions()
      return true
    } catch (error) {
      pushToast(`Couldn't update the conversation. ${getErrorMessage(error)}`)
      return false
    }
  }, [api, pushToast, refreshSessions, updateSessions])

  const abort = useCallback(async () => {
    const selectedSessionId = sessionIdRef.current
    if (!selectedSessionId) return false
    try {
      const result = await api(
        `/api/sessions/${encodeURIComponent(selectedSessionId)}/abort`, parseAbortedRun,
        { method: "POST" },
      )
      if (result.aborted) {
        setRunningSessionIds((current) => current.filter((id) => id !== selectedSessionId))
        const active = liveAssistantRef.current
        const runId = activeRunIdsRef.current.get(selectedSessionId) ?? active?.runId
        if (runId) {
          const abortedRuns = abortedRunIdsRef.current
          abortedRuns.add(getRunKey(selectedSessionId, runId))
          if (abortedRuns.size > MAX_STALE_STREAM_KEYS) {
            const oldest = abortedRuns.values().next().value
            if (typeof oldest === "string") abortedRuns.delete(oldest)
          }
        }
        activeRunIdsRef.current.delete(selectedSessionId)
        retireLiveAssistant(selectedSessionId)
        setPendingPrompt(undefined)
        pendingPromptRef.current = undefined
        setPendingAttachments([])
        pendingAttachmentsRef.current = []
      }
      void refreshQueue()
      return result.aborted
    } catch (error) {
      pushToast(`Couldn't stop the response. ${getErrorMessage(error)}`)
      return false
    }
  }, [api, pushToast, refreshQueue, retireLiveAssistant])

  const setSearchQuery = useCallback(
    (query: string) => {
      searchQueryRef.current = query
      setSearchQueryState(query)
      cursorRef.current = undefined
      setCursor(undefined)
      void loadSessionPage("reset")
    },
    [loadSessionPage],
  )

  const clearRecoveredDraft = useCallback(() => {
    setRecoveredDraft(undefined)
    setRecoveredAttachments([])
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => {
      const held = heldQueueEditRef.current
      if (!held || document.visibilityState === "hidden") return
      void request(`/api/sessions/${encodeURIComponent(held.sessionId)}/followups/${encodeURIComponent(held.id)}`, {
        method: "PATCH", body: JSON.stringify({ isEditing: true }), signal: AbortSignal.timeout(FOLLOWUP_REQUEST_TIMEOUT_MS),
      }).then(() => {
        const current = heldQueueEditRef.current
        if (current?.sessionId === held.sessionId && current.id === held.id) return
        return request(`/api/sessions/${encodeURIComponent(held.sessionId)}/followups/${encodeURIComponent(held.id)}`, {
          method: "PATCH", body: JSON.stringify({ isEditing: false }), keepalive: true,
          signal: AbortSignal.timeout(FOLLOWUP_REQUEST_TIMEOUT_MS),
        })
      }).catch(() => undefined)
    }, 60_000)
    return () => window.clearInterval(timer)
  }, [request])

  useEffect(() => {
    isUnmountedRef.current = false
    const boot = async () => {
      const savedToken = localStorage.getItem(TOKEN_KEY) ?? ""
      let hasAccess = false
      try {
        const response = await fetch("/api/web-token")
        if (response.ok) {
          const value: unknown = await response.json()
          if (!isRecord(value) || typeof value.token !== "string") {
            throw new Error("The authentication response was invalid.")
          }
          tokenRef.current = value.token
          localStorage.setItem(TOKEN_KEY, value.token)
          hasAccess = true
        } else if (savedToken) {
          const savedResponse = await fetch("/api/auth", {
            method: "POST",
            headers: { Authorization: `Bearer ${savedToken}` },
          })
          if (!savedResponse.ok) {
            throw new ApiError(savedResponse.status, await parseApiError(savedResponse))
          }
          tokenRef.current = savedToken
          hasAccess = true
        } else {
          throw new ApiError(response.status, await parseApiError(response))
        }
      } catch (error) {
        setAuthError(`Authentication failed. ${getErrorMessage(error)}`)
      }
      if (!hasAccess || isUnmountedRef.current) {
        setIsReady(true)
        return
      }
      await restoreSavedSession(loadSessionPage("reset"))
      connectSocket()
      if (!isUnmountedRef.current) setIsReady(true)
    }
    void boot()
    return () => {
      isUnmountedRef.current = true
      window.clearTimeout(reconnectTimerRef.current)
      const socket = socketRef.current
      socketRef.current = undefined
      socket?.close()
      pendingRequestsRef.current.forEach((pending) => pending.resolve(false))
      pendingRequestsRef.current.clear()
    }
  }, [connectSocket, loadSessionPage, restoreSavedSession])

  useEffect(() => {
    window.addEventListener("pagehide", releaseQueueEdit)
    return () => {
      window.removeEventListener("pagehide", releaseQueueEdit)
      releaseQueueEdit()
    }
  }, [releaseQueueEdit])

  useEffect(() => {
    const handlePopState = () => {
      const routeSessionId = getRouteSessionId()
      if (routeSessionId) {
        void openSession(routeSessionId)
        return
      }
      if (location.pathname !== "/") return
      releaseQueueEdit()
      cancelPendingRequests()
      const previousSessionId = sessionIdRef.current
      if (previousSessionId) sendSocket({ op: "unsub", sessionId: previousSessionId })
      openGenerationRef.current += 1
      retireLiveAssistant()
      sessionIdRef.current = undefined
      setSessionId(undefined)
      messagesRef.current = []
      setMessages([])
      setPendingPrompt(undefined)
      pendingPromptRef.current = undefined
      setPendingAttachments([])
      pendingAttachmentsRef.current = []
      setIsOpening(false)
      nextSeqRef.current = 0
      offsetRef.current = 0
      localStorage.removeItem(LAST_SESSION_KEY)
      localStorage.setItem(LAST_SESSION_MODE_KEY, "new")
    }
    window.addEventListener("popstate", handlePopState)
    return () => window.removeEventListener("popstate", handlePopState)
  }, [cancelPendingRequests, openSession, releaseQueueEdit, retireLiveAssistant, sendSocket])

  useEffect(() => {
    const poll = window.setInterval(() => {
      const selectedSessionId = sessionIdRef.current
      if (!selectedSessionId || !runningSessionIds.includes(selectedSessionId)) return
      const generation = openGenerationRef.current
      void api(
        `/api/sessions/${encodeURIComponent(selectedSessionId)}/status`, parseRunStatus,
      )
        .then((result) => {
          if (
            result.running ||
            generation !== openGenerationRef.current ||
            selectedSessionId !== sessionIdRef.current
          ) {
            return
          }
          setRunningSessionIds((current) => current.filter((id) => id !== selectedSessionId))
          activeRunIdsRef.current.delete(selectedSessionId)
          return fetchMessages(selectedSessionId, generation)
            .then(() => {
              if (
                generation !== openGenerationRef.current ||
                selectedSessionId !== sessionIdRef.current
              ) {
                return
              }
              if (pendingPromptRef.current === undefined) return
              setRecoveredDraft(pendingPromptRef.current)
              setRecoveredAttachments(pendingAttachmentsRef.current)
              setPendingPrompt(undefined)
              pendingPromptRef.current = undefined
              setPendingAttachments([])
              pendingAttachmentsRef.current = []
              pushToast("The response couldn't start. Your message was restored.")
            })
            .catch(() => {
              if (
                generation !== openGenerationRef.current ||
                selectedSessionId !== sessionIdRef.current ||
                pendingPromptRef.current === undefined
              ) {
                return
              }
              setRecoveredDraft(pendingPromptRef.current)
              setRecoveredAttachments(pendingAttachmentsRef.current)
              setPendingPrompt(undefined)
              pendingPromptRef.current = undefined
              setPendingAttachments([])
              pendingAttachmentsRef.current = []
              pushToast("The response ended, but its messages couldn't be loaded. Your message was restored.")
            })
        })
        .catch(() => undefined)
    }, RUN_POLL_INTERVAL_MS)
    return () => window.clearInterval(poll)
  }, [api, fetchMessages, pushToast, runningSessionIds])

  useAutoRefresh(refreshSessions, SESSION_REFRESH_INTERVAL_MS, isReady)
  useAutoRefresh(refreshQueue, QUEUE_REFRESH_INTERVAL_MS, isReady && !!sessionId && !authError && !isOpening)

  return {
    isReady,
    isConnected,
    isOpening,
    isSending,
    isUpdatingQueue,
    isQueuePaused: !!queueState && queueState.sessionId === sessionId && queueState.isPaused,
    queuedMessages: queueState && queueState.sessionId === sessionId ? queueState.items : [],
    isRunning: sessionId ? runningSessionIds.includes(sessionId) : isSending,
    isLoadingSessions,
    isLoadingMore,
    authError,
    sessionId,
    pendingPrompt,
    pendingAttachments,
    recoveredDraft,
    recoveredAttachments,
    searchQuery,
    sessions,
    messages,
    liveAssistant,
    hasMore: Boolean(cursor),
    total,
    matched,
    toasts,
    setSearchQuery,
    saveToken,
    request,
    refreshSessions,
    loadMore,
    openSession,
    newChat,
    send,
    queue,
    editQueuedMessage,
    beginEditQueuedMessage,
    cancelEditQueuedMessage,
    deleteQueuedMessage,
    steerQueuedMessage,
    resumeQueue,
    upload,
    deleteSession,
    updateSession,
    abort,
    clearRecoveredDraft,
    dismissToast,
  }
}
