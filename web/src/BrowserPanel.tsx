import * as stylex from "@stylexjs/stylex"
import {
  ArrowLeft,
  ExternalLink,
  Focus,
  Globe2,
  Search,
  Send,
  Trash2,
  X,
} from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { formatRequestError } from "./errors"

import { tokens } from "./tokens.stylex"
import { focusDialogSurface } from "./ui"
import { useAutoRefresh } from "./useAutoRefresh"
import type { BrowserTab } from "./types"
import { getWebsiteUrl, isTabResponse, OPEN_IN_BROWSER_LABEL } from "./browser"

const TAB_REFRESH_INTERVAL_MS = 2_000
const PREVIEW_REFRESH_INTERVAL_MS = 1_000
const THUMBNAIL_REFRESH_INTERVAL_MS = 10_000
const ICON_SIZE = 20
const ICON_STROKE = 1.8

type BrowserPanelProps = {
  request: (path: string, init?: RequestInit) => Promise<Response>
  notify: (message: string, kind?: "error" | "success") => void
  onStart: (prompt: string) => void
  onClose: () => void
  sessionId?: string
  initialTargetId?: string
}

type PreviewStatus = "idle" | "loading" | "ready" | "asleep" | "missing" | "error"

export function BrowserPanel({ request, notify, onStart, onClose, sessionId, initialTargetId }: BrowserPanelProps) {
  const sessionQuery = sessionId ? `&session=${encodeURIComponent(sessionId)}` : ""
  const initialTargetRef = useRef(initialTargetId)
  const [tabs, setTabs] = useState<BrowserTab[]>([])
  const [selectedTab, setSelectedTab] = useState<BrowserTab>()
  const [query, setQuery] = useState("")
  const [isLoadingTabs, setIsLoadingTabs] = useState(true)
  const [listError, setListError] = useState<string>()
  const [instruction, setInstruction] = useState("")
  const [isOpenFormVisible, setIsOpenFormVisible] = useState(false)
  const [newTabUrl, setNewTabUrl] = useState("")
  const [previewUrl, setPreviewUrl] = useState<string>()
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>("idle")
  const [busyAction, setBusyAction] = useState<string>()
  const [isConfirmingClose, setIsConfirmingClose] = useState(false)
  const listGenerationRef = useRef(0)
  const captureGenerationRef = useRef(0)
  const previewUrlRef = useRef<string | undefined>(undefined)
  const panelRef = useRef<HTMLElement>(null)
  const backButtonRef = useRef<HTMLButtonElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const cancelCloseRef = useRef<HTMLButtonElement>(null)
  const wasClosingRef = useRef(false)
  const selectedTargetRef = useRef<string | undefined>(undefined)
  const selectedTabId = selectedTab?.targetId
  const websiteUrl = selectedTab && getWebsiteUrl(selectedTab.url)
  const isClosingTab = busyAction === "close"
  const isSelectedTabAsleep = selectedTab?.loaded === false
  const isSelectedTabMissing = !!selectedTabId && !tabs.some((tab) => tab.targetId === selectedTabId)

  useLayoutEffect(() => {
    const dialog = panelRef.current?.closest("dialog")
    if (dialog && document.activeElement === dialog) focusDialogSurface(dialog)
  }, [])

  useLayoutEffect(() => {
    if (selectedTab) {
      selectedTargetRef.current = selectedTab.targetId
      backButtonRef.current?.focus({ preventScroll: true })
    } else if (selectedTargetRef.current) {
      const buttons = [...panelRef.current?.querySelectorAll<HTMLButtonElement>("[data-browser-tab]") ?? []]
      const target = buttons.find((button) => button.dataset.browserTab === selectedTargetRef.current) ?? buttons[0] ?? searchInputRef.current
      target?.focus({ preventScroll: true })
      selectedTargetRef.current = undefined
    }
  }, [selectedTab?.targetId])

  useLayoutEffect(() => {
    if (isConfirmingClose) cancelCloseRef.current?.focus({ preventScroll: false })
  }, [isConfirmingClose])

  useLayoutEffect(() => {
    if (wasClosingRef.current && !isClosingTab) closeButtonRef.current?.focus({ preventScroll: true })
    wasClosingRef.current = isClosingTab
  }, [isClosingTab])

  const loadTabs = useCallback(async (signal?: AbortSignal) => {
    const generation = ++listGenerationRef.current
    setIsLoadingTabs(true)
    try {
      const response = await request(`/api/tabs?refresh=true${sessionQuery}`, { cache: "no-store", signal })
      const value: unknown = await response.json()
      if (signal?.aborted || generation !== listGenerationRef.current) return
      if (!isTabResponse(value)) throw new Error("Invalid tab list.")
      const sortedTabs = [...value.tabs].sort(
        (first, second) => (second.lastAccessed ?? 0) - (first.lastAccessed ?? 0),
      )
      setTabs(sortedTabs)
      const initialTarget = initialTargetRef.current
      setSelectedTab((current) => sortedTabs.find((tab) => tab.targetId === (current?.targetId ?? initialTarget)))
      if (sortedTabs.some((tab) => tab.targetId === initialTarget)) initialTargetRef.current = undefined
      setListError(undefined)
    } catch (error) {
      if (!signal?.aborted && generation === listGenerationRef.current) setListError(getErrorMessage(error))
    } finally {
      if (generation === listGenerationRef.current) setIsLoadingTabs(false)
    }
  }, [request, sessionQuery])

  useAutoRefresh(loadTabs, TAB_REFRESH_INTERVAL_MS)

  useEffect(() => {
    return () => {
      listGenerationRef.current += 1
    }
  }, [])

  const capturePreview = useCallback(async (signal: AbortSignal) => {
    if (!selectedTabId || isSelectedTabAsleep || isSelectedTabMissing) return
    const generation = ++captureGenerationRef.current
    setPreviewStatus("loading")
    try {
      const response = await request(
        `/api/tabs/${encodeURIComponent(selectedTabId)}/shot?fresh=true${sessionQuery}`,
        { cache: "no-store", signal },
      )
      const blob = await response.blob()
      if (!blob.type.startsWith("image/")) throw new Error("The preview was not an image.")
      const nextUrl = URL.createObjectURL(blob)
      if (signal.aborted || generation !== captureGenerationRef.current) {
        URL.revokeObjectURL(nextUrl)
        return
      }
      const previousUrl = previewUrlRef.current
      previewUrlRef.current = nextUrl
      setPreviewUrl(nextUrl)
      setPreviewStatus("ready")
      if (previousUrl) URL.revokeObjectURL(previousUrl)
    } catch (error) {
      if (signal.aborted || generation !== captureGenerationRef.current) return
      const status = getErrorStatus(error)
      setPreviewStatus(status === 409 ? "asleep" : status === 404 ? "missing" : "error")
    }
  }, [request, selectedTabId, isSelectedTabAsleep, isSelectedTabMissing, sessionQuery])

  useEffect(() => {
    captureGenerationRef.current += 1
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    previewUrlRef.current = undefined
    setPreviewUrl(undefined)
    setIsConfirmingClose(false)
    setPreviewStatus("idle")
    return () => { captureGenerationRef.current += 1 }
  }, [selectedTabId])

  useAutoRefresh(capturePreview, PREVIEW_REFRESH_INTERVAL_MS, !!selectedTabId && !isSelectedTabAsleep && !isSelectedTabMissing && !isClosingTab)

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    }
  }, [])

  const runTabAction = async (action: "focus" | "open" | "close") => {
    if (!selectedTab || busyAction) return
    setBusyAction(action)
    try {
      if (action === "focus") {
        await request(`/api/tabs/${encodeURIComponent(selectedTab.targetId)}/focus?${sessionQuery.slice(1)}`, { method: "POST" })
        notify("Focus request sent.", "success")
      } else if (action === "open") {
        await request(`/api/tabs?${sessionQuery.slice(1)}`, { method: "POST", body: JSON.stringify({ url: selectedTab.url }) })
        notify("Opened a new copy of the tab.", "success")
        await loadTabs()
      } else {
        try {
          await request(`/api/tabs/${encodeURIComponent(selectedTab.targetId)}?${sessionQuery.slice(1)}`, { method: "DELETE", signal: AbortSignal.timeout(60_000) })
        } catch (error) {
          if (getErrorStatus(error) !== 404) throw error
        }
        listGenerationRef.current += 1
        setTabs((current) => current.filter((tab) => tab.targetId !== selectedTab.targetId))
        notify("Tab closed.", "success")
        setSelectedTab(undefined)
        await loadTabs()
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
      await request(`/api/tabs?${sessionQuery.slice(1)}`, { method: "POST", body: JSON.stringify({ url }) })
      setNewTabUrl("")
      setIsOpenFormVisible(false)
      notify("Tab opened.", "success")
      await loadTabs()
    } catch (error) {
      notify(getErrorMessage(error), "error")
    } finally {
      setBusyAction(undefined)
    }
  }

  const availableTabs = tabs.filter((tab) => tab.loaded !== false)
  const filteredTabs = availableTabs.filter((tab) => {
    const needle = query.trim().toLocaleLowerCase()
    return (
      (!needle || tab.title.toLocaleLowerCase().includes(needle) || tab.url.toLocaleLowerCase().includes(needle))
    )
  })

  return (
    <section ref={panelRef} {...stylex.props(styles.panel)} aria-label="Browser tabs">
      <header {...stylex.props(styles.header)}>
        {selectedTab ? <button
          ref={backButtonRef}
          {...stylex.props(styles.iconButton)}
          type="button"
          aria-label="Back to tabs"
          disabled={!!busyAction}
          onClick={() => setSelectedTab(undefined)}
        >
          <ArrowLeft size={ICON_SIZE} strokeWidth={ICON_STROKE} />
        </button> : <span aria-hidden="true" />}
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

          {websiteUrl && <a href={websiteUrl} target="_blank" rel="noopener noreferrer external" {...stylex.props(styles.secondaryButton)}>
            <ExternalLink size={18} strokeWidth={ICON_STROKE} aria-hidden="true" /> {OPEN_IN_BROWSER_LABEL}
          </a>}

          <div {...stylex.props(styles.previewFrame)}>
            {previewUrl && !isSelectedTabAsleep && !isSelectedTabMissing && <img {...stylex.props(styles.preview)} src={previewUrl} alt={`Current view of ${selectedTab.title || "browser tab"}`} />}
            {(!previewUrl || isSelectedTabAsleep || isSelectedTabMissing) && <PreviewMessage status={isSelectedTabMissing ? "missing" : isSelectedTabAsleep ? "asleep" : previewStatus} />}
          </div>

          {(!previewUrl || isSelectedTabMissing || isSelectedTabAsleep || previewStatus === "asleep" || previewStatus === "error") && <div {...stylex.props(styles.previewBar)}>
            <span {...stylex.props(styles.status)}>
              {isSelectedTabMissing ? "Tab closed" : isSelectedTabAsleep || previewStatus === "asleep" ? "Tab asleep" : previewStatus === "error" ? "Reconnecting…" : "Connecting…"}
            </span>
          </div>}

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
            disabled={!!busyAction || !instruction.trim() || isSelectedTabAsleep || isSelectedTabMissing || previewStatus === "asleep" || previewStatus === "missing"}
            onClick={() => {
              const task = instruction.trim()
              if (!task) return
              onStart(`Use browser tab targetId=${selectedTab.targetId} (${selectedTab.title}, ${selectedTab.url}) and follow these instructions:\n\n${task}`)
            }}
          >
            <Send size={18} strokeWidth={ICON_STROKE} /> Start in chat
          </button>

          <div {...stylex.props(styles.actionGrid)}>
            <button {...stylex.props(styles.secondaryButton)} type="button" disabled={!!busyAction || isSelectedTabAsleep || isSelectedTabMissing || previewStatus === "missing"} onClick={() => void runTabAction("focus")}>
              <Focus size={18} strokeWidth={ICON_STROKE} /> Focus
            </button>
            <button {...stylex.props(styles.secondaryButton)} type="button" disabled={!!busyAction} onClick={() => void runTabAction("open")}>
              <ExternalLink size={18} strokeWidth={ICON_STROKE} /> Open copy
            </button>
          </div>
          <div {...stylex.props(styles.confirmRow)}>
            {isConfirmingClose && <span {...stylex.props(styles.confirmText)}>Close this tab?</span>}
            {isConfirmingClose && <button ref={cancelCloseRef} {...stylex.props(styles.textButton)} type="button" disabled={!!busyAction} onClick={() => { setIsConfirmingClose(false); closeButtonRef.current?.focus({ preventScroll: true }) }}>Cancel</button>}
            <button ref={closeButtonRef} {...stylex.props(isConfirmingClose ? styles.dangerButton : styles.deleteButton)} type="button" disabled={!!busyAction} aria-busy={isClosingTab} onClick={() => isConfirmingClose ? void runTabAction("close") : setIsConfirmingClose(true)}>
              {!isConfirmingClose && <Trash2 size={18} strokeWidth={ICON_STROKE} />}{isClosingTab ? "Closing…" : "Close tab"}
            </button>
          </div>
        </div>
      ) : (
        <div {...stylex.props(styles.listView)}>
          <div {...stylex.props(styles.searchRow)}>
            <label {...stylex.props(styles.searchBox)}>
              <Search size={18} strokeWidth={ICON_STROKE} />
              <span {...stylex.props(styles.srOnly)}>Search tabs</span>
              <input ref={searchInputRef} {...stylex.props(styles.searchInput)} value={query} placeholder="Search tabs" onChange={(event) => setQuery(event.target.value)} />
            </label>
          </div>
          <div {...stylex.props(styles.meta)}>{availableTabs.length} tabs</div>
          <div {...stylex.props(styles.list)}>
            {listError && <EmptyState title="Reconnecting…" detail={listError} />}
            {!listError && isLoadingTabs && tabs.length === 0 && <EmptyState title="Loading tabs…" detail="Chrome may take a moment to respond." />}
            {!listError && !isLoadingTabs && filteredTabs.length === 0 && <EmptyState title={availableTabs.length ? "No matching tabs" : "No browser tabs"} detail={availableTabs.length ? "Try a different search." : "Open a tab here or in Aside."} />}
            {filteredTabs.map((tab) => (
              <button key={tab.targetId} data-browser-tab={tab.targetId} title={tab.title || "Untitled tab"} {...stylex.props(styles.tabRow)} type="button" onClick={() => setSelectedTab(tab)}>
                <TabThumbnail tab={tab} request={request} sessionQuery={sessionQuery} />
                <span {...stylex.props(styles.tabCopy)}>
                  <span {...stylex.props(styles.rowTitle)}>{tab.title || "Untitled tab"}</span>
                  <span {...stylex.props(styles.rowMeta)}>{tab.loaded === false ? "Asleep" : tab.active ? "Active" : "Available"}</span>
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

function TabThumbnail({ tab, request, sessionQuery }: { tab: BrowserTab; request: BrowserPanelProps["request"]; sessionQuery: string }) {
  const [src, setSrc] = useState<string>()
  const [isVisible, setIsVisible] = useState(false)
  const thumbnailRef = useRef<HTMLSpanElement>(null)
  const objectUrlRef = useRef<string | undefined>(undefined)
  const isAsleep = tab.loaded === false

  useEffect(() => {
    const element = thumbnailRef.current
    if (!element) return
    const observer = new IntersectionObserver(([entry]) => setIsVisible(entry.isIntersecting))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const capture = useCallback(async (signal: AbortSignal) => {
    try {
      const response = await request(`/api/tabs/${encodeURIComponent(tab.targetId)}/shot?fresh=true${sessionQuery}`, { cache: "no-store", signal })
      const blob = await response.blob()
      if (signal.aborted || !blob.type.startsWith("image/")) return
      const previousUrl = objectUrlRef.current
      objectUrlRef.current = URL.createObjectURL(blob)
      setSrc(objectUrlRef.current)
      if (previousUrl) URL.revokeObjectURL(previousUrl)
    } catch {
      // Keep the last thumbnail while the next automatic capture retries.
    }
  }, [request, tab.targetId, sessionQuery])

  useAutoRefresh(capture, THUMBNAIL_REFRESH_INTERVAL_MS, isVisible && !isAsleep)

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    }
  }, [])
  return (
    <span ref={thumbnailRef} {...stylex.props(styles.thumbnail)}>
      {src && !isAsleep ? <img {...stylex.props(styles.thumbnailImage)} src={src} alt="" /> : tab.favicon ? <img {...stylex.props(styles.favicon)} src={tab.favicon} alt="" /> : <Globe2 size={20} strokeWidth={ICON_STROKE} />}
    </span>
  )
}

function PreviewMessage({ status }: { status: PreviewStatus }) {
  const copy = status === "asleep"
    ? ["This tab is asleep", "Open a copy to load it again."]
    : status === "missing"
      ? ["This tab is no longer available", "The tab list updates automatically."]
      : status === "error"
        ? ["Reconnecting…", "The preview will return automatically."]
        : ["Loading preview…", ""]
  return <div {...stylex.props(styles.previewMessage)}><strong>{copy[0]}</strong>{copy[1] && <span>{copy[1]}</span>}</div>
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div {...stylex.props(styles.empty)}><strong>{title}</strong><span>{detail}</span></div>
}


function getErrorStatus(error: unknown) {
  if (typeof error !== "object" || error === null) return undefined
  const status = Reflect.get(error, "status")
  return typeof status === "number" ? status : undefined
}

function getErrorMessage(error: unknown) {
  if (error instanceof DOMException && error.name === "TimeoutError") return formatRequestError({ status: 504 })
  if (getErrorStatus(error) === 404) return "This tab is no longer available."
  return formatRequestError({ message: error instanceof Error ? error.message : undefined })
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
  meta: { padding: "2px 18px 9px", color: tokens.muted, fontSize: '0.75rem' },
  list: { minHeight: 0, flex: 1, overflowY: "auto", overscrollBehavior: "contain", padding: "0 10px 18px" },
  tabRow: { width: "100%", minHeight: 76, display: "flex", alignItems: "center", gap: 12, padding: "9px 8px", borderWidth: 0, borderRadius: 14, textAlign: "left", backgroundColor: { default: "transparent", ":hover": tokens.surface }, color: tokens.text, fontFamily: tokens.font },
  thumbnail: { width: 84, height: 56, flexShrink: 0, display: "grid", placeItems: "center", overflow: "hidden", borderRadius: 10, borderWidth: 1, borderStyle: "solid", borderColor: tokens.border, backgroundColor: tokens.surface, color: tokens.muted },
  thumbnailImage: { display: "block", width: "100%", height: "100%", objectFit: "cover" },
  favicon: { width: 22, height: 22, objectFit: "contain" },
  tabCopy: { minWidth: 0, display: "flex", flexDirection: "column", gap: 4 },
  rowTitle: { overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflowWrap: "anywhere", fontSize: '0.9375rem', lineHeight: 1.35, fontWeight: 560 },
  rowMeta: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: tokens.muted, fontSize: '0.75rem' },
  detail: { minHeight: 0, flex: 1, overflowY: "auto", overscrollBehavior: "contain", padding: "16px", display: "flex", flexDirection: "column", gap: 12 },
  tabIdentity: { minWidth: 0, padding: "0 2px" },
  tabTitle: { margin: 0, overflowWrap: "anywhere", fontSize: '1.0625rem', lineHeight: 1.35, fontWeight: 650 },
  url: { marginTop: 3, overflowWrap: "anywhere", color: tokens.muted, fontSize: '0.75rem', lineHeight: 1.45, userSelect: "text" },
  previewFrame: { minHeight: 180, maxHeight: "min(46vh, 430px)", aspectRatio: "16 / 10", display: "grid", placeItems: "center", overflow: "hidden", borderWidth: 1, borderStyle: "solid", borderColor: tokens.border, borderRadius: 16, backgroundColor: tokens.surface },
  preview: { display: "block", width: "100%", height: "100%", objectFit: "contain", backgroundColor: tokens.canvas },
  previewMessage: { display: "flex", flexDirection: "column", alignItems: "center", gap: 5, padding: 24, textAlign: "center", color: tokens.muted, fontSize: '0.8125rem' },
  previewBar: { minHeight: 44, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 },
  status: { minWidth: 0, color: tokens.muted, fontSize: '0.75rem', overflowWrap: "anywhere" },
  textarea: { width: "100%", minHeight: 88, resize: "vertical", padding: "13px 14px", borderWidth: 1, borderStyle: "solid", borderColor: tokens.border, borderRadius: 14, backgroundColor: tokens.canvas, color: tokens.text, fontFamily: tokens.font, fontSize: '1rem', lineHeight: 1.45 },
  primaryButton: { minHeight: 48, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "0 18px", borderWidth: 0, borderRadius: 999, backgroundColor: tokens.text, color: tokens.canvas, fontFamily: tokens.font, fontSize: '0.9375rem', fontWeight: 650 },
  actionGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 },
  secondaryButton: { minHeight: 44, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7, padding: "0 14px", borderWidth: 1, borderStyle: "solid", borderColor: tokens.border, borderRadius: 999, backgroundColor: tokens.canvas, color: tokens.text, fontFamily: tokens.font, fontSize: '0.875rem', fontWeight: 600, textDecoration: "none" },
  deleteButton: { minHeight: 44, width: "100%", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7, padding: "0 14px", borderWidth: 0, backgroundColor: "transparent", color: tokens.danger, fontFamily: tokens.font, fontSize: '0.875rem', fontWeight: 600 },
  confirmRow: { minHeight: 52, display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: 8, padding: "4px 0" },
  confirmText: { flexBasis: "100%", color: tokens.muted, fontSize: '0.8125rem' },
  dangerButton: { minHeight: 44, padding: "0 15px", borderWidth: 0, borderRadius: 999, backgroundColor: tokens.danger, color: tokens.canvas, fontFamily: tokens.font, fontSize: '0.875rem', fontWeight: 650, whiteSpace: "nowrap" },
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
