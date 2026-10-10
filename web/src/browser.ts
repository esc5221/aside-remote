import type { BrowserTab } from "./types"

export const OPEN_IN_BROWSER_LABEL = "Open in your browser"

export function getWebsiteUrl(value: string) {
  try {
    const url = new URL(value)
    if (url.protocol === "https:" || url.protocol === "http:") return url.href
  } catch { }
}

export function isTabResponse(value: unknown): value is { tabs: BrowserTab[] } {
  if (typeof value !== "object" || value === null) return false
  const tabs = Reflect.get(value, "tabs")
  return Array.isArray(tabs) && tabs.every((tab) => {
    if (typeof tab !== "object" || tab === null) return false
    const loaded = Reflect.get(tab, "loaded")
    const favicon = Reflect.get(tab, "favicon")
    const lastAccessed = Reflect.get(tab, "lastAccessed")
    return typeof Reflect.get(tab, "targetId") === "string"
      && typeof Reflect.get(tab, "url") === "string"
      && typeof Reflect.get(tab, "title") === "string"
      && typeof Reflect.get(tab, "active") === "boolean"
      && (loaded === null || typeof loaded === "boolean")
      && (favicon == null || typeof favicon === "string")
      && (lastAccessed == null || typeof lastAccessed === "number" && Number.isFinite(lastAccessed))
  })
}
