/** Browser APIs used by the original options UI, backed by the VPS extension. */
export function installWebBridge({
  baseUrl,
  manifest,
  id,
  csrfToken,
  eventCursor = 0,
  target = globalThis,
}) {
  const nativeFetch = target.fetch.bind(target)
  const base = new URL(baseUrl)
  const clientId = target.crypto.randomUUID()
  const listeners = new Map()
  const heldLocks = new Set()
  let cursor = eventCursor
  let stopped = false
  let pollTimer
  const runtime = { id, lastError: undefined }
  const event = (name) => {
    if (!listeners.has(name)) listeners.set(name, new Set())
    const subscriptions = listeners.get(name)
    return {
      addListener: (listener) => subscriptions.add(listener),
      removeListener: (listener) => subscriptions.delete(listener),
      hasListener: (listener) => subscriptions.has(listener),
      hasListeners: () => subscriptions.size > 0,
    }
  }

  async function api(route, body, options = {}) {
    const response = await nativeFetch(
      new URL(`api/extension/${route}`, base),
      {
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
          "x-aah-client": clientId,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        ...options,
      },
    )
    if (response.status === 401) {
      stopped = true
      target.location.replace(base.href)
      throw new Error("Session expired. Please sign in again.")
    }
    const value = await response.json()
    if (!response.ok)
      throw new Error(
        typeof value.error === "string"
          ? value.error
          : "The server operation failed.",
      )
    return value
  }

  function remote(path) {
    return (...args) => {
      const callback =
        typeof args.at(-1) === "function" ? args.pop() : undefined
      const pending = api("call", { path, args }).then((result) => result.value)
      if (!callback) return pending
      pending.then(
        (value) => callback(value),
        (error) => {
          runtime.lastError = { message: error.message }
          try {
            callback(undefined)
          } finally {
            runtime.lastError = undefined
          }
        },
      )
      return undefined
    }
  }

  const namespaced = (namespace, methods, events = []) =>
    Object.fromEntries([
      ...methods.map((method) => [method, remote(`${namespace}.${method}`)]),
      ...events.map((name) => [name, event(`${namespace}.${name}`)]),
    ])
  Object.assign(
    runtime,
    namespaced(
      "runtime",
      [
        "sendMessage",
        "getPlatformInfo",
        "getBrowserInfo",
        "requestUpdateCheck",
      ],
      [
        "onMessage",
        "onInstalled",
        "onStartup",
        "onSuspend",
        "onUpdateAvailable",
      ],
    ),
  )
  Object.assign(runtime, {
    getURL: (path) => new URL(String(path).replace(/^\//, ""), base).href,
    getManifest: () => structuredClone(manifest),
    openOptionsPage: async () => {
      target.location.assign(new URL("options.html", base))
    },
    reload: () => target.location.reload(),
    setUninstallURL: async () => {},
  })
  const storage = { onChanged: event("storage.onChanged") }
  for (const area of ["local", "sync", "session"]) {
    storage[area] = namespaced(
      `storage.${area}`,
      ["get", "set", "remove", "clear", "getBytesInUse"],
      ["onChanged"],
    )
  }
  const browser = {
    runtime,
    storage,
    tabs: namespaced(
      "tabs",
      [
        "query",
        "get",
        "create",
        "update",
        "remove",
        "sendMessage",
        "reload",
        "getCurrent",
      ],
      ["onUpdated", "onRemoved", "onActivated", "onCreated"],
    ),
    windows: namespaced(
      "windows",
      [
        "get",
        "getAll",
        "getCurrent",
        "getLastFocused",
        "create",
        "update",
        "remove",
      ],
      ["onCreated", "onRemoved", "onFocusChanged"],
    ),
    alarms: namespaced(
      "alarms",
      ["create", "get", "getAll", "clear", "clearAll"],
      ["onAlarm"],
    ),
    permissions: namespaced(
      "permissions",
      ["contains", "getAll", "request", "remove"],
      ["onAdded", "onRemoved"],
    ),
    cookies: namespaced(
      "cookies",
      ["get", "getAll", "getAllCookieStores", "set", "remove"],
      ["onChanged"],
    ),
    downloads: namespaced(
      "downloads",
      ["download", "search", "cancel", "erase"],
      ["onChanged"],
    ),
    notifications: namespaced(
      "notifications",
      ["create", "clear", "getPermissionLevel"],
      ["onClicked", "onClosed"],
    ),
    bookmarks: namespaced("bookmarks", [
      "getTree",
      "getSubTree",
      "get",
      "search",
      "create",
      "remove",
    ]),
    declarativeNetRequest: namespaced("declarativeNetRequest", [
      "getDynamicRules",
      "updateDynamicRules",
      "getSessionRules",
      "updateSessionRules",
    ]),
    scripting: namespaced("scripting", ["executeScript"]),
    extension: namespaced("extension", ["isAllowedIncognitoAccess"]),
    management: namespaced("management", ["getSelf"]),
    action: namespaced("action", [
      "setBadgeText",
      "setBadgeBackgroundColor",
      "setTitle",
      "setPopup",
    ]),
    contextMenus: namespaced(
      "contextMenus",
      ["create", "update", "remove", "removeAll"],
      ["onClicked"],
    ),
    i18n: {
      getUILanguage: () => target.navigator.language,
      getMessage: (name) =>
        manifest.name && name === "manifest_name" ? manifest.name : "",
    },
  }
  browser.tabs.create = async (options) => {
    const url = new URL(options.url, base)
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error(
        "Only HTTP(S) pages can be opened from the Web workspace.",
      )
    target.open(url.href, "_blank", "noopener,noreferrer")
    return {
      id: -1,
      url: url.href,
      active: Boolean(options.active),
      windowId: -1,
    }
  }
  browser.downloads.download = async (options) => {
    const url = new URL(options.url, base)
    if (!["blob:", "data:", "http:", "https:"].includes(url.protocol))
      throw new Error("Unsupported download URL.")
    const link = target.document.createElement("a")
    link.href = url.href
    link.download = options.filename || "all-api-hub-export.json"
    link.rel = "noopener noreferrer"
    target.document.body.append(link)
    link.click()
    link.remove()
    return Date.now()
  }
  target.__AAH_WEB__ = true
  target.chrome = browser
  target.browser = browser

  const originalLocks = target.navigator.locks
  const webLocks = {
    async request(name, options, callback) {
      if (typeof options === "function") {
        callback = options
        options = {}
      }
      if (!name.startsWith("all-api-hub:")) {
        if (!originalLocks) throw new Error("Web Locks are not available.")
        return originalLocks.request(name, options, callback)
      }
      options?.signal?.throwIfAborted()
      const lock = await api("lock/acquire", { name, clientId })
      heldLocks.add(lock.id)
      try {
        options?.signal?.throwIfAborted()
        return await callback({ name, mode: "exclusive" })
      } finally {
        await api("lock/release", { id: lock.id, clientId })
        heldLocks.delete(lock.id)
      }
    },
    query: () =>
      originalLocks?.query() ?? Promise.resolve({ held: [], pending: [] }),
  }
  Object.defineProperty(target.navigator, "locks", {
    configurable: true,
    value: webLocks,
  })

  const toBase64 = (bytes) => {
    let binary = ""
    for (let i = 0; i < bytes.length; i += 32768)
      binary += String.fromCharCode(...bytes.subarray(i, i + 32768))
    return target.btoa(binary)
  }
  target.fetch = async (input, init = {}) => {
    const inputUrl =
      input instanceof Request
        ? input.url
        : new URL(String(input), target.location.href).href
    const url = new URL(inputUrl)
    if (
      url.origin === base.origin ||
      !["http:", "https:"].includes(url.protocol)
    )
      return nativeFetch(input, init)
    const request = new Request(input, init)
    const body = ["GET", "HEAD"].includes(request.method)
      ? undefined
      : toBase64(new Uint8Array(await request.arrayBuffer()))
    const result = await api(
      "fetch",
      {
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(request.headers),
        bodyBase64: body,
      },
      { signal: request.signal },
    )
    const bytes = Uint8Array.from(target.atob(result.bodyBase64 || ""), (c) =>
      c.charCodeAt(0),
    )
    return new Response(
      [204, 205, 304].includes(result.status) || request.method === "HEAD"
        ? null
        : bytes,
      {
        status: result.status,
        statusText: result.statusText || "",
        headers: result.headers,
      },
    )
  }

  async function poll() {
    try {
      const response = await api(
        `events?after=${encodeURIComponent(cursor)}&clientId=${encodeURIComponent(clientId)}`,
      )
      for (const update of response.events || []) {
        const callbacks = listeners.get(update.event)
        for (const listener of callbacks || []) {
          try {
            listener(
              ...update.args,
              ...(update.event === "runtime.onMessage" ? [() => {}] : []),
            )
          } catch (error) {
            target.console.error(error)
          }
        }
        if (update.event === "storage.onChanged") {
          const [changes, area] = update.args
          for (const listener of listeners.get(`storage.${area}.onChanged`) ||
            [])
            listener(changes)
        }
      }
      cursor = response.cursor ?? cursor
    } catch (error) {
      if (!stopped)
        target.console.warn(
          "Workspace events temporarily unavailable:",
          error.message,
        )
    } finally {
      if (!stopped) pollTimer = target.setTimeout(poll, 750)
    }
  }
  pollTimer = target.setTimeout(poll, 0)
  const dispose = () => {
    stopped = true
    target.clearTimeout(pollTimer)
    for (const lockId of heldLocks)
      void api(
        "lock/release",
        { id: lockId, clientId },
        { keepalive: true },
      ).catch(() => {})
  }
  target.addEventListener("pagehide", dispose, { once: true })
  return { browser, api, dispose }
}
