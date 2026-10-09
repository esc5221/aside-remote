import * as stylex from "@stylexjs/stylex"
import {
  ArrowLeft,
  ExternalLink,
  Focus,
  Globe2,
  Pause,
  Play,
  RefreshCw,
  Search,
  Send,
  Trash2,
  X,
} from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { formatRequestError } from "./errors"

import { tokens } from "./tokens.stylex"
import { focusDialogSurface } from "./ui"

const REFRESH_INTERVAL_MS = 5_000
const ICON_SIZE = 20
const ICON_STROKE = 1.8

type BrowserTab = {
  targetId: string
  title: string
  url: string
  favicon?: string
  active: boolean
  loaded: boolean | null
  lastAccessed?: number
}

type BrowserPanelProps = {
  request: (path: string, init?: RequestInit) => Promise<Response>
  notify: (message: string, kind?: "error" | "success") => void
  onStart: (prompt: string) => void
  onClose: () => void
}

type PreviewStatus = "idle" | "loading" | "ready" | "asleep" | "missing" | "error"

export function BrowserPanel({ request, notify, onStart, onClose }: BrowserPanelProps) {
  const [tabs, setTabs] = useState<BrowserTab[]>([])
  const [selectedTab, setSelectedTab] = useState<BrowserTab>()
  const [query, setQuery] = useState("")
  const [isLiveOnly, setIsLiveOnly] = useState(false)
  const [isLoadingTabs, setIsLoadingTabs] = useState(true)
  const [listError, setListError] = useState<string>()
  const [instruction, setInstruction] = useState("")
  const [isPaused, setIsPaused] = useState(false)
  const [isOpenFormVisible, setIsOpenFormVisible] = useState(false)
  const [newTabUrl, setNewTabUrl] = useState("")
  const [previewUrl, setPreviewUrl] = useState<string>()
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>("idle")
  const [updatedAt, setUpdatedAt] = useState<Date>()
  const [busyAction, setBusyAction] = useState<string>()
  const [isConfirmingClose, setIsConfirmingClose] = useState(false)
  const listGenerationRef = useRef(0)
  const captureGenerationRef = useRef(0)
  const captureControllerRef = useRef<AbortController | undefined>(undefined)
  const previewUrlRef = useRef<string | undefined>(undefined)
  const panelRef = useRef<HTMLElement>(null)
  const backButtonRef = useRef<HTMLButtonElement>(null)
  const selectedTargetRef = useRef<string | undefined>(undefined)

  useLayoutEffect(() => {
    const dialog = panelRef.current?.closest("dialog")
    if (dialog && document.activeElement === dialog) focusDialogSurface(dialog)
  }, [])

  useLayoutEffect(() => {
    if (selectedTab) {
      selectedTargetRef.current = selectedTab.targetId
      backButtonRef.current?.focus({ preventScroll: true })
    } else if (selectedTargetRef.current) {
      [...panelRef.current?.querySelectorAll<HTMLButtonElement>("[data-browser-tab]") ?? []]
        .find((button) => button.dataset.browserTab === selectedTargetRef.current)?.focus({ preventScroll: true })
      selectedTargetRef.current = undefined
    }
  }, [selectedTab?.targetId])

  const loadTabs = useCallback(async (force = false) => {
    const generation = ++listGenerationRef.current
    setIsLoadingTabs(true)
    setListError(undefined)
    try {
      const response = await request(`/api/tabs?refresh=${force}`)
      const value: unknown = await response.json()
      if (generation !== listGenerationRef.current || !isTabResponse(value)) return
      const sortedTabs = [...value.tabs].sort(
        (first, second) => (second.lastAccessed ?? 0) - (first.lastAccessed ?? 0),
      )
      setTabs(sortedTabs)
    } catch (error) {
      if (generation === listGenerationRef.current) setListError(getErrorMessage(error))
    } finally {
      if (generation === listGenerationRef.current) setIsLoadingTabs(false)
    }
  }, [request])

  useEffect(() => {
    void loadTabs(true)
    return () => {
      listGenerationRef.current += 1
    }
  }, [loadTabs])

  const capturePreview = useCallback(async () => {
    if (!selectedTab || selectedTab.loaded === false) return
    captureControllerRef.current?.abort()
    const controller = new AbortController()
    captureControllerRef.current = controller
    const generation = ++captureGenerationRef.current
    setPreviewStatus("loading")
    try {
      const response = await request(
        `/api/tabs/${encodeURIComponent(selectedTab.targetId)}/shot?fresh=true&t=${Date.now()}`,
        { cache: "no-store", signal: controller.signal },
      )
      const blob = await response.blob()
      if (!blob.type.startsWith("image/")) throw new Error("The preview was not an image.")
      const nextUrl = URL.createObjectURL(blob)
      if (controller.signal.aborted || generation !== captureGenerationRef.current) {
        URL.revokeObjectURL(nextUrl)
        return
      }
      const previousUrl = previewUrlRef.current
      previewUrlRef.current = nextUrl
      setPreviewUrl(nextUrl)
      setPreviewStatus("ready")
      setUpdatedAt(new Date())
      if (previousUrl) URL.revokeObjectURL(previousUrl)
    } catch (error) {
      if (controller.signal.aborted || generation !== captureGenerationRef.current) return
      const status = getErrorStatus(error)
      setPreviewStatus(status === 409 ? "asleep" : status === 404 ? "missing" : "error")
    }
  }, [request, selectedTab])

  useEffect(() => {
    captureControllerRef.current?.abort()
    captureGenerationRef.current += 1
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    previewUrlRef.current = undefined
    setPreviewUrl(undefined)
    setUpdatedAt(undefined)
    setIsPaused(false)
    setIsConfirmingClose(false)
    setPreviewStatus(selectedTab?.loaded === false ? "asleep" : "idle")
    if (selectedTab?.loaded !== false) void capturePreview()
    return () => captureControllerRef.current?.abort()
  }, [capturePreview, selectedTab])

  useEffect(() => {
    if (!selectedTab || selectedTab.loaded === false || isPaused || previewStatus === "asleep" || previewStatus === "missing") return
    const timer = window.setInterval(() => void capturePreview(), REFRESH_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [capturePreview, isPaused, previewStatus, selectedTab])

  useEffect(() => {
    return () => {
      captureControllerRef.current?.abort()
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    }
  }, [])

  const runTabAction = async (action: "focus" | "open" | "close") => {
    if (!selectedTab || busyAction) return
    setBusyAction(action)
    try {
      if (action === "focus") {
        await request(`/api/tabs/${encodeURIComponent(selectedTab.targetId)}/focus`, { method: "POST" })
        notify("Focus request sent.", "success")
      } else if (action === "open") {
        await request("/api/tabs", { method: "POST", body: JSON.stringify({ url: selectedTab.url }) })
        notify("Opened a new copy of the tab.", "success")
        await loadTabs(true)
      } else {
        await request(`/api/tabs/${encodeURIComponent(selectedTab.targetId)}`, { method: "DELETE" })
        notify("Tab closed.", "success")
        setSelectedTab(undefined)
        await loadTabs(true)
      }
    } catch (error) {
      const status = getErrorStatus(error)
      if (status === 404) setPreviewStatus("missing")
      else if (status === 409) setPreviewStatus("asleep")
      notify(getErrorMessage(error), "error")
    } finally {
      setBusyAction(undefined)
    }
  }

  const openNewTab = async () => {
    if (busyAction) return
    const url = getWebUrl(newTabUrl)
    if (!url) {
      notify("Enter a full http:// or https:// URL.", "error")
      return
    }
    setBusyAction("new")
    try {
      await request("/api/tabs", { method: "POST", body: JSON.stringify({ url }) })
      setNewTabUrl("")
      setIsOpenFormVisible(false)
      notify("Tab opened.", "success")
      await loadTabs(true)
    } catch (error) {
      notify(getErrorMessage(error), "error")
    } finally {
      setBusyAction(undefined)
    }
  }

  const filteredTabs = tabs.filter((tab) => {
    const needle = query.trim().toLocaleLowerCase()
    return (
      (!isLiveOnly || tab.loaded !== false) &&
      (!needle || tab.title.toLocaleLowerCase().includes(needle) || tab.url.toLocaleLowerCase().includes(needle))
    )
  })
  const liveCount = tabs.filter((tab) => tab.loaded !== false).length

  return (
    <section ref={panelRef} {...stylex.props(styles.panel)} aria-label="Browser tabs">
      <header {...stylex.props(styles.header)}>
        <button
          ref={backButtonRef}
          {...stylex.props(styles.iconButton)}
          type="button"
          aria-label={selectedTab ? "Back to tabs" : "Refresh tabs"}
          onClick={() => selectedTab ? setSelectedTab(undefined) : void loadTabs(true)}
        >
          {selectedTab ? <ArrowLeft size={ICON_SIZE} strokeWidth={ICON_STROKE} /> : <RefreshCw size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
        </button>
        <h2 {...stylex.props(styles.heading)}>Browser</h2>
        <button {...stylex.props(styles.iconButton)} type="button" aria-label="Close browser" onClick={onClose}>
          <X size={ICON_SIZE} strokeWidth={ICON_STROKE} />
        </button>
      </header>

      {selectedTab ? (
        <div {...stylex.props(styles.detail)}>
          <div {...stylex.props(styles.tabIdentity)}>
            <h3 {...stylex.props(styles.tabTitle)}>{selectedTab.title || "Untitled tab"}</h3>
            <div {...stylex.props(styles.url)}>{selectedTab.url}</div>
          </div>

          <div {...stylex.props(styles.previewFrame)}>
            {previewUrl && <img {...stylex.props(styles.preview)} src={previewUrl} alt={`Current view of ${selectedTab.title || "browser tab"}`} />}
            {!previewUrl && <PreviewMessage status={previewStatus} />}
          </div>

          <div {...stylex.props(styles.previewBar)}>
            <span {...stylex.props(styles.status)}>
              {previewStatus === "loading" ? "Updating preview…" : isPaused ? "Auto-refresh paused" : updatedAt ? `Updated ${updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : "Refreshes every 5 seconds"}
            </span>
            <span className="sr-only" role="status">{isPaused ? "Auto-refresh paused" : "Auto-refresh running"}</span>
            {selectedTab.loaded !== false && previewStatus !== "missing" && (
              <div {...stylex.props(styles.inlineActions)}>
                <button {...stylex.props(styles.iconButton)} type="button" aria-label="Refresh preview" disabled={previewStatus === "loading"} onClick={() => void capturePreview()}>
                  <RefreshCw size={18} strokeWidth={ICON_STROKE} />
                </button>
                <button {...stylex.props(styles.iconButton)} type="button" aria-label={isPaused ? "Resume auto-refresh" : "Pause auto-refresh"} aria-pressed={isPaused} onClick={() => setIsPaused((value) => !value)}>
                  {isPaused ? <Play size={18} strokeWidth={ICON_STROKE} /> : <Pause size={18} strokeWidth={ICON_STROKE} />}
                </button>
              </div>
            )}
          </div>

          <textarea
            {...stylex.props(styles.textarea)}
            value={instruction}
            rows={3}
            aria-label="Instructions for this tab"
            placeholder="What should happen on this page?"
            onChange={(event) => setInstruction(event.target.value)}
          />
          <button
            {...stylex.props(styles.primaryButton)}
            type="button"
            disabled={!instruction.trim() || previewStatus === "asleep" || previewStatus === "missing"}
            onClick={() => {
              const task = instruction.trim()
              if (!task) return
              onStart(`Use browser tab targetId=${selectedTab.targetId} (${selectedTab.title}, ${selectedTab.url}) and follow these instructions:\n\n${task}`)
            }}
          >
            <Send size={18} strokeWidth={ICON_STROKE} /> Start in chat
          </button>

          <div {...stylex.props(styles.actionGrid)}>
            <button {...stylex.props(styles.secondaryButton)} type="button" disabled={!!busyAction || selectedTab.loaded === false} onClick={() => void runTabAction("focus")}>
              <Focus size={18} strokeWidth={ICON_STROKE} /> Focus
            </button>
            <button {...stylex.props(styles.secondaryButton)} type="button" disabled={!!busyAction} onClick={() => void runTabAction("open")}>
              <ExternalLink size={18} strokeWidth={ICON_STROKE} /> Open copy
            </button>
          </div>
          {isConfirmingClose ? (
            <div {...stylex.props(styles.confirmRow)}>
              <span {...stylex.props(styles.confirmText)}>Close this Chrome tab?</span>
              <button {...stylex.props(styles.textButton)} type="button" onClick={() => setIsConfirmingClose(false)}>Cancel</button>
              <button {...stylex.props(styles.dangerButton)} type="button" disabled={!!busyAction} onClick={() => void runTabAction("close")}>Close tab</button>
            </div>
          ) : (
            <button {...stylex.props(styles.deleteButton)} type="button" disabled={!!busyAction} onClick={() => setIsConfirmingClose(true)}>
              <Trash2 size={18} strokeWidth={ICON_STROKE} /> Close tab
            </button>
          )}
        </div>
      ) : (
        <div {...stylex.props(styles.listView)}>
          <div {...stylex.props(styles.searchRow)}>
            <label {...stylex.props(styles.searchBox)}>
              <Search size={18} strokeWidth={ICON_STROKE} />
              <span {...stylex.props(styles.srOnly)}>Search tabs</span>
              <input {...stylex.props(styles.searchInput)} value={query} placeholder="Search tabs" onChange={(event) => setQuery(event.target.value)} />
            </label>
            <button {...stylex.props(styles.filterButton, isLiveOnly && styles.filterButtonActive)} type="button" aria-pressed={isLiveOnly} onClick={() => setIsLiveOnly((value) => !value)}>Live</button>
          </div>
          <div {...stylex.props(styles.meta)}>{tabs.length} tabs · {liveCount} available</div>
          <div {...stylex.props(styles.list)}>
            {listError && <EmptyState title="Tabs unavailable" detail={listError} action="Try again" onAction={() => void loadTabs(true)} />}
            {!listError && isLoadingTabs && tabs.length === 0 && <EmptyState title="Loading tabs…" detail="Chrome may take a moment to respond." />}
            {!listError && !isLoadingTabs && filteredTabs.length === 0 && <EmptyState title={tabs.length ? "No matching tabs" : "No browser tabs"} detail={tabs.length ? "Try a different search or show all tabs." : "Open a tab here or refresh the list."} action="Refresh" onAction={() => void loadTabs(true)} />}
            {filteredTabs.map((tab) => (
              <button key={tab.targetId} data-browser-tab={tab.targetId} title={tab.title || "Untitled tab"} {...stylex.props(styles.tabRow)} type="button" onClick={() => setSelectedTab(tab)}>
                <TabThumbnail tab={tab} request={request} />
                <span {...stylex.props(styles.tabCopy)}>
                  <span {...stylex.props(styles.rowTitle)}>{tab.title || "Untitled tab"}</span>
                  <span {...stylex.props(styles.rowMeta)}>{getHost(tab.url)} · {tab.loaded === false ? "Asleep" : tab.active ? "Active" : "Available"}</span>
                </span>
              </button>
            ))}
            {isOpenFormVisible ? (
              <form {...stylex.props(styles.openForm)} onSubmit={(event) => { event.preventDefault(); void openNewTab() }}>
                <label {...stylex.props(styles.openLabel)} htmlFor="new-browser-tab-url">Open a tab</label>
                <div {...stylex.props(styles.openRow)}>
                  <input
                    id="new-browser-tab-url"
                    {...stylex.props(styles.openInput)}
                    type="url" inputMode="url" autoCapitalize="none" autoCorrect="off"
                    value={newTabUrl}
                    placeholder="https://example.com"
                    onChange={(event) => setNewTabUrl(event.target.value)}
                    autoFocus
                  />
                  <button {...stylex.props(styles.openButton)} type="submit" disabled={busyAction === "new"}>Open</button>
                </div>
                <button {...stylex.props(styles.textButton)} type="button" onClick={() => setIsOpenFormVisible(false)}>Cancel</button>
              </form>
            ) : (
              <button {...stylex.props(styles.openDisclosure)} type="button" onClick={() => setIsOpenFormVisible(true)}>
                <ExternalLink size={18} strokeWidth={ICON_STROKE} /> Open a tab
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

function TabThumbnail({ tab, request }: { tab: BrowserTab; request: BrowserPanelProps["request"] }) {
  const [src, setSrc] = useState<string>()
  useEffect(() => {
    if (tab.loaded === false) return
    const controller = new AbortController()
    let objectUrl: string | undefined
    void request(`/api/tabs/${encodeURIComponent(tab.targetId)}/shot`, { signal: controller.signal })
      .then((response) => response.blob())
      .then((blob) => {
        if (controller.signal.aborted || !blob.type.startsWith("image/")) return
        objectUrl = URL.createObjectURL(blob)
        setSrc(objectUrl)
      })
      .catch(() => undefined)
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [request, tab.loaded, tab.targetId])
  return (
    <span {...stylex.props(styles.thumbnail)}>
      {src ? <img {...stylex.props(styles.thumbnailImage)} src={src} alt="" /> : tab.favicon ? <img {...stylex.props(styles.favicon)} src={tab.favicon} alt="" /> : <Globe2 size={20} strokeWidth={ICON_STROKE} />}
    </span>
  )
}

function PreviewMessage({ status }: { status: PreviewStatus }) {
  const copy = status === "asleep"
    ? ["This tab is asleep", "Open a copy to load it again."]
    : status === "missing"
      ? ["This tab is no longer available", "Return to the list and refresh your tabs."]
      : status === "error"
        ? ["Preview unavailable", "Refresh to try again."]
        : ["Loading preview…", ""]
  return <div {...stylex.props(styles.previewMessage)}><strong>{copy[0]}</strong>{copy[1] && <span>{copy[1]}</span>}</div>
}

function EmptyState({ title, detail, action, onAction }: { title: string; detail: string; action?: string; onAction?: () => void }) {
  return <div {...stylex.props(styles.empty)}><strong>{title}</strong><span>{detail}</span>{action && <button {...stylex.props(styles.textButton)} type="button" onClick={onAction}>{action}</button>}</div>
}

function isTabResponse(value: unknown): value is { tabs: BrowserTab[] } {
  if (typeof value !== "object" || value === null) return false
  const tabs = Reflect.get(value, "tabs")
  return Array.isArray(tabs) && tabs.every((tab) => typeof tab === "object" && tab !== null && typeof Reflect.get(tab, "targetId") === "string" && typeof Reflect.get(tab, "url") === "string")
}

function getErrorStatus(error: unknown) {
  if (typeof error !== "object" || error === null) return undefined
  const status = Reflect.get(error, "status")
  return typeof status === "number" ? status : undefined
}

function getErrorMessage(error: unknown) {
  if (getErrorStatus(error) === 404) return "This tab is no longer available."
  return formatRequestError({ message: error instanceof Error ? error.message : undefined })
}

function getHost(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, "") }
  catch { return url }
}

function getWebUrl(value: string) {
  try {
    const url = new URL(value.trim())
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined
  } catch {
    return undefined
  }
}

const styles = stylex.create({
  panel: { display: "flex", flexDirection: "column", width: "100%", height: "100%", minWidth: 0, overflow: "hidden", backgroundColor: tokens.canvas, color: tokens.text, fontFamily: tokens.font },
  header: { minHeight: 58, display: "grid", gridTemplateColumns: "44px 1fr 44px", alignItems: "center", padding: "7px 12px", borderBottomWidth: 1, borderBottomStyle: "solid", borderBottomColor: tokens.border },
  heading: { margin: 0, textAlign: "center", fontSize: '1.0625rem', lineHeight: 1.2, fontWeight: 650 },
  iconButton: { width: 44, height: 44, padding: 0, borderWidth: 0, borderRadius: 999, display: "inline-flex", alignItems: "center", justifyContent: "center", color: tokens.text, backgroundColor: { default: "transparent", ":hover": tokens.hover } },
  listView: { display: "flex", flexDirection: "column", minHeight: 0, flex: 1 },
  searchRow: { display: "flex", gap: 8, padding: "14px 16px 8px" },
  searchBox: { minWidth: 0, flex: 1, height: 44, display: "flex", alignItems: "center", gap: 9, padding: "0 13px", borderRadius: 14, backgroundColor: tokens.surface, color: tokens.muted },
  searchInput: { minWidth: 0, width: "100%", height: "100%", padding: 0, borderWidth: 0, outline: 0, backgroundColor: "transparent", color: tokens.text, fontFamily: tokens.font, fontSize: '1rem' },
  filterButton: { minWidth: 58, height: 44, padding: "0 15px", borderWidth: 1, borderStyle: "solid", borderColor: tokens.border, borderRadius: 999, backgroundColor: tokens.canvas, color: tokens.muted, fontFamily: tokens.font, fontSize: '0.875rem', fontWeight: 600 },
  filterButtonActive: { backgroundColor: tokens.text, borderColor: tokens.text, color: tokens.canvas },
  meta: { padding: "2px 18px 9px", color: tokens.muted, fontSize: '0.75rem' },
  list: { minHeight: 0, flex: 1, overflowY: "auto", overscrollBehavior: "contain", padding: "0 10px 18px" },
  tabRow: { width: "100%", minHeight: 76, display: "flex", alignItems: "center", gap: 12, padding: "9px 8px", borderWidth: 0, borderRadius: 14, textAlign: "left", backgroundColor: { default: "transparent", ":hover": tokens.surface }, color: tokens.text, fontFamily: tokens.font },
  thumbnail: { width: 84, height: 56, flexShrink: 0, display: "grid", placeItems: "center", overflow: "hidden", borderRadius: 10, borderWidth: 1, borderStyle: "solid", borderColor: tokens.border, backgroundColor: tokens.surface, color: tokens.muted },
  thumbnailImage: { display: "block", width: "100%", height: "100%", objectFit: "cover" },
  favicon: { width: 22, height: 22, objectFit: "contain" },
  tabCopy: { minWidth: 0, display: "flex", flexDirection: "column", gap: 4 },
  rowTitle: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: '0.9375rem', lineHeight: 1.25, fontWeight: 560 },
  rowMeta: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: tokens.muted, fontSize: '0.75rem' },
  detail: { minHeight: 0, flex: 1, overflowY: "auto", overscrollBehavior: "contain", padding: "16px", display: "flex", flexDirection: "column", gap: 12 },
  tabIdentity: { minWidth: 0, padding: "0 2px" },
  tabTitle: { margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: '1.0625rem', lineHeight: 1.35, fontWeight: 650 },
  url: { marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: tokens.muted, fontSize: '0.75rem' },
  previewFrame: { minHeight: 180, maxHeight: "min(46vh, 430px)", aspectRatio: "16 / 10", display: "grid", placeItems: "center", overflow: "hidden", borderWidth: 1, borderStyle: "solid", borderColor: tokens.border, borderRadius: 16, backgroundColor: tokens.surface },
  preview: { display: "block", width: "100%", height: "100%", objectFit: "contain", backgroundColor: tokens.canvas },
  previewMessage: { display: "flex", flexDirection: "column", alignItems: "center", gap: 5, padding: 24, textAlign: "center", color: tokens.muted, fontSize: '0.8125rem' },
  previewBar: { minHeight: 44, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 },
  status: { minWidth: 0, color: tokens.muted, fontSize: '0.75rem', overflowWrap: "anywhere" },
  inlineActions: { display: "flex", flexShrink: 0 },
  textarea: { width: "100%", minHeight: 88, resize: "vertical", padding: "13px 14px", borderWidth: 1, borderStyle: "solid", borderColor: tokens.border, borderRadius: 14, backgroundColor: tokens.canvas, color: tokens.text, fontFamily: tokens.font, fontSize: '1rem', lineHeight: 1.45 },
  primaryButton: { minHeight: 48, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "0 18px", borderWidth: 0, borderRadius: 999, backgroundColor: tokens.text, color: tokens.canvas, fontFamily: tokens.font, fontSize: '0.9375rem', fontWeight: 650 },
  actionGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 },
  secondaryButton: { minHeight: 44, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7, padding: "0 14px", borderWidth: 1, borderStyle: "solid", borderColor: tokens.border, borderRadius: 999, backgroundColor: tokens.canvas, color: tokens.text, fontFamily: tokens.font, fontSize: '0.875rem', fontWeight: 600 },
  deleteButton: { minHeight: 44, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7, padding: "0 14px", borderWidth: 0, backgroundColor: "transparent", color: tokens.danger, fontFamily: tokens.font, fontSize: '0.875rem', fontWeight: 600 },
  confirmRow: { minHeight: 52, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, padding: "4px 0" },
  confirmText: { marginRight: "auto", color: tokens.muted, fontSize: '0.8125rem' },
  dangerButton: { minHeight: 44, padding: "0 15px", borderWidth: 0, borderRadius: 999, backgroundColor: tokens.danger, color: tokens.canvas, fontFamily: tokens.font, fontSize: '0.875rem', fontWeight: 650 },
  textButton: { minHeight: 44, padding: "0 10px", borderWidth: 0, backgroundColor: "transparent", color: tokens.text, fontFamily: tokens.font, fontSize: '0.875rem', fontWeight: 600 },
  empty: { minHeight: 220, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 7, padding: 28, textAlign: "center", color: tokens.muted, fontSize: '0.875rem' },
  openDisclosure: { width: "100%", minHeight: 48, marginTop: 8, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "0 16px", borderWidth: 1, borderStyle: "solid", borderColor: tokens.border, borderRadius: 14, backgroundColor: tokens.canvas, color: tokens.text, fontFamily: tokens.font, fontSize: '0.875rem', fontWeight: 600 },
  openForm: { marginTop: 8, padding: 12, borderWidth: 1, borderStyle: "solid", borderColor: tokens.border, borderRadius: 14, backgroundColor: tokens.surface },
  openLabel: { display: "block", marginBottom: 8, color: tokens.text, fontSize: '0.875rem', fontWeight: 650 },
  openRow: { display: "flex", gap: 8 },
  openInput: { minWidth: 0, minHeight: 44, flex: 1, padding: "0 12px", borderWidth: 1, borderStyle: "solid", borderColor: tokens.border, borderRadius: 11, backgroundColor: tokens.canvas, color: tokens.text, fontFamily: tokens.font, fontSize: '1rem' },
  openButton: { minWidth: 70, minHeight: 44, padding: "0 14px", borderWidth: 0, borderRadius: 999, backgroundColor: tokens.text, color: tokens.canvas, fontFamily: tokens.font, fontSize: '0.875rem', fontWeight: 650 },
  srOnly: { position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", borderWidth: 0 },
})
