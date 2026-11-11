import { randomUUID } from "node:crypto"

const clone = (value) =>
  value === undefined ? undefined : structuredClone(value)
const fail = (message, status = 400) => {
  const error = new Error(message)
  error.status = status
  throw error
}
const unsupported = () =>
  fail("此操作需要本机浏览器扩展，纯服务端不提供浏览器标签页或登录会话", 400)

export function createEvent() {
  const listeners = new Set()
  return {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
    hasListener: (listener) => listeners.has(listener),
    hasListeners: () => listeners.size > 0,
    listeners,
    emit: (...args) => {
      for (const listener of listeners)
        Promise.resolve()
          .then(() => listener(...args))
          .catch(() => {})
    },
  }
}

export class RuntimeLocks {
  constructor({ leaseMs = 60_000, now = Date.now } = {}) {
    this.queues = new Map()
    this.leases = new Map()
    this.leaseMs = leaseMs
    this.now = now
  }
  request(name, options, callback) {
    if (typeof options === "function") {
      callback = options
      options = {}
    }
    const previous = this.queues.get(name) || Promise.resolve()
    const operation = previous
      .catch(() => {})
      .then(async () => {
        options?.signal?.throwIfAborted()
        return callback({ name, mode: "exclusive" })
      })
    this.queues.set(name, operation)
    void operation
      .finally(() => {
        if (this.queues.get(name) === operation) this.queues.delete(name)
      })
      .catch(() => {})
    return operation
  }
  acquire(name, clientId) {
    if (
      typeof name !== "string" ||
      !name.startsWith("all-api-hub:") ||
      name.length > 200
    )
      fail("锁名称无效")
    if (typeof clientId !== "string" || !/^[\w:-]{8,180}$/.test(clientId))
      fail("客户端标识无效")
    if (this.leases.size >= 128) fail("等待中的操作过多", 429)
    const id = randomUUID(),
      controller = new AbortController()
    let release
    const held = new Promise((resolve) => {
      release = resolve
    })
    this.leases.set(id, {
      clientId,
      controller,
      release,
      expires: this.now() + this.leaseMs,
    })
    return new Promise((resolve, reject) => {
      this.request(name, { signal: controller.signal }, async () => {
        resolve({ id })
        await held
      })
        .catch(reject)
        .finally(() => this.leases.delete(id))
    })
  }
  release(id, clientId) {
    const lease = this.leases.get(id)
    if (!lease) return
    if (lease.clientId !== clientId) fail("锁属于其他客户端", 403)
    this.leases.delete(id)
    lease.controller.abort()
    lease.release()
  }
  touch(clientId) {
    for (const lease of this.leases.values())
      if (lease.clientId === clientId) lease.expires = this.now() + this.leaseMs
  }
  releaseClient(sessionId) {
    for (const [id, lease] of this.leases)
      if (lease.clientId.startsWith(sessionId + ":"))
        this.release(id, lease.clientId)
  }
  expire() {
    for (const [id, lease] of this.leases)
      if (lease.expires <= this.now()) this.release(id, lease.clientId)
  }
  close() {
    for (const [id, lease] of this.leases) this.release(id, lease.clientId)
  }
}

export function createBrowserRuntime({
  initialState = {},
  manifest = {},
  persist,
  emit = () => {},
}) {
  let state = {
    local: clone(initialState.local || {}),
    sync: clone(initialState.sync || {}),
    alarms: clone(initialState.alarms || {}),
  }
  let session = {},
    writes = Promise.resolve(),
    persistError
  const locks = new RuntimeLocks(),
    timers = new Map(),
    notifications = new Map()
  const onMessage = createEvent(),
    storageChanged = createEvent(),
    alarmEvent = createEvent()
  const runtime = {
    id: "all-api-hub-web",
    lastError: undefined,
    getManifest: () => clone(manifest),
    getURL: (value) => `aah-extension:///${String(value).replace(/^\//, "")}`,
    onMessage,
    onConnect: createEvent(),
    onInstalled: createEvent(),
    onStartup: createEvent(),
    onSuspend: createEvent(),
    getPlatformInfo: async () => ({
      os: process.platform === "win32" ? "win" : "linux",
      arch: "x86-64",
    }),
    getBrowserInfo: async () => ({
      name: "All API Hub Node",
      version: "0.2.0",
      vendor: "self-hosted",
    }),
    setUninstallURL: async () => {},
    requestUpdateCheck: async () => ({ status: "no_update" }),
    async sendMessage(message) {
      emit("runtime.onMessage", [clone(message), { id: runtime.id }])
      return dispatch(message)
    },
  }
  function callbackApi(fn) {
    return (...args) => {
      const callback = typeof args.at(-1) === "function" ? args.pop() : null
      const operation = Promise.resolve().then(() => fn(...args))
      if (callback) {
        operation.then(
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
      return operation
    }
  }
  function mutate(operation) {
    const pending = writes
      .catch(() => {})
      .then(async () => {
        const next = clone(state),
          result = operation(next)
        await persist(next)
        state = next
        persistError = null
        return result
      })
    writes = pending
    pending.catch((error) => {
      persistError = error
    })
    return pending
  }
  function area(name) {
    const getStore = () => (name === "session" ? session : state[name])
    const publish = (changes) => {
      if (Object.keys(changes).length) {
        storageChanged.emit(changes, name)
        emit("storage.onChanged", [changes, name])
      }
    }
    const change = async (operation) => {
      let changes
      if (name === "session") {
        const next = clone(session)
        changes = operation(next)
        session = next
      } else changes = await mutate((next) => operation(next[name]))
      publish(changes)
    }
    return {
      get: callbackApi(async (keys) => {
        await writes.catch(() => {})
        if (persistError) throw persistError
        const data = getStore()
        if (keys == null) return clone(data)
        if (typeof keys === "string")
          return Object.hasOwn(data, keys) ? { [keys]: clone(data[keys]) } : {}
        if (Array.isArray(keys))
          return Object.fromEntries(
            keys
              .filter((key) => Object.hasOwn(data, key))
              .map((key) => [key, clone(data[key])]),
          )
        return Object.fromEntries(
          Object.entries(keys).map(([key, fallback]) => [
            key,
            clone(Object.hasOwn(data, key) ? data[key] : fallback),
          ]),
        )
      }),
      set: callbackApi((values) =>
        change((data) => {
          if (!values || typeof values !== "object" || Array.isArray(values))
            fail("Storage values must be an object")
          const changes = {}
          for (const [key, value] of Object.entries(values)) {
            if (["__proto__", "constructor", "prototype"].includes(key))
              fail("Invalid storage key")
            changes[key] = {
              oldValue: clone(data[key]),
              newValue: clone(value),
            }
            data[key] = clone(value)
          }
          return changes
        }),
      ),
      remove: callbackApi((keys) =>
        change((data) => {
          const changes = {}
          for (const key of Array.isArray(keys) ? keys : [keys])
            if (Object.hasOwn(data, key)) {
              changes[key] = { oldValue: clone(data[key]) }
              delete data[key]
            }
          return changes
        }),
      ),
      clear: callbackApi(() =>
        change((data) => {
          const changes = Object.fromEntries(
            Object.entries(data).map(([key, value]) => [
              key,
              { oldValue: clone(value) },
            ]),
          )
          for (const key of Object.keys(data)) delete data[key]
          return changes
        }),
      ),
      getBytesInUse: callbackApi(async (keys) =>
        Buffer.byteLength(JSON.stringify(await storage[name].get(keys))),
      ),
      setAccessLevel: callbackApi(async () => {}),
    }
  }
  const storage = {
    local: area("local"),
    sync: area("sync"),
    session: area("session"),
    onChanged: storageChanged,
  }
  async function dispatch(message) {
    return new Promise((resolve, reject) => {
      let waiting = false,
        settled = false
      const finish = (value) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve(value)
        }
      }
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          reject(new Error("后台消息处理超时"))
        }
      }, 150_000)
      timer.unref()
      try {
        for (const listener of onMessage.listeners) {
          const value = listener(
            clone(message),
            { id: runtime.id, url: runtime.getURL("options.html") },
            finish,
          )
          if (value === true) waiting = true
          else if (value && typeof value.then === "function") {
            waiting = true
            value.then((result) => {
              if (result !== undefined) finish(result)
            }, reject)
          } else if (value !== undefined && value !== false) finish(value)
        }
        if (!waiting && !settled) finish(undefined)
      } catch (error) {
        clearTimeout(timer)
        reject(error)
      }
    })
  }
  function arm(alarm) {
    clearTimeout(timers.get(alarm.name))
    const delay = Math.max(
      1,
      Math.min(2_147_000_000, alarm.scheduledTime - Date.now()),
    )
    const timer = setTimeout(async () => {
      if (alarm.scheduledTime > Date.now()) {
        arm(alarm)
        return
      }
      try {
        const next = alarm.periodInMinutes
          ? {
              ...alarm,
              scheduledTime: Date.now() + alarm.periodInMinutes * 60_000,
            }
          : null
        await mutate((state) => {
          if (next) state.alarms[alarm.name] = next
          else delete state.alarms[alarm.name]
        })
        if (next) arm(next)
        else timers.delete(alarm.name)
        alarmEvent.emit(clone(alarm))
        emit("alarms.onAlarm", [clone(alarm)])
      } catch {
        /* Persist failure prevents claiming that a schedule advanced. */
      }
    }, delay)
    timer.unref()
    timers.set(alarm.name, timer)
  }
  const alarms = {
    onAlarm: alarmEvent,
    create: callbackApi(async (name, info = {}) => {
      const alarm = {
        name,
        scheduledTime: Number(
          info.when ??
            Date.now() +
              (info.delayInMinutes ?? info.periodInMinutes ?? 0) * 60_000,
        ),
        ...(info.periodInMinutes
          ? { periodInMinutes: info.periodInMinutes }
          : {}),
      }
      if (
        !Number.isFinite(alarm.scheduledTime) ||
        (alarm.periodInMinutes && alarm.periodInMinutes < 0)
      )
        fail("Invalid alarm time")
      await mutate((state) => {
        state.alarms[name] = alarm
      })
      arm(alarm)
    }),
    get: callbackApi(async (name) => clone(state.alarms[name])),
    getAll: callbackApi(async () => Object.values(clone(state.alarms))),
    clear: callbackApi(async (name) => {
      const exists = Object.hasOwn(state.alarms, name)
      await mutate((state) => {
        delete state.alarms[name]
      })
      clearTimeout(timers.get(name))
      timers.delete(name)
      return exists
    }),
    clearAll: callbackApi(async () => {
      await mutate((state) => {
        state.alarms = {}
      })
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      return true
    }),
  }
  const permissions = {
    onAdded: createEvent(),
    onRemoved: createEvent(),
    getAll: callbackApi(async () => ({
      permissions: ["storage", "alarms", "notifications"],
      origins: ["https://*/*"],
    })),
    contains: callbackApi(async (query) =>
      (query.permissions || []).every((permission) =>
        ["storage", "alarms", "notifications"].includes(permission),
      ),
    ),
    request: callbackApi(async () => false),
    remove: callbackApi(async () => false),
  }
  const tabs = {
    onCreated: createEvent(),
    onUpdated: createEvent(),
    onRemoved: createEvent(),
    onActivated: createEvent(),
    query: callbackApi(async () => []),
    get: callbackApi(unsupported),
    create: callbackApi(unsupported),
    update: callbackApi(unsupported),
    remove: callbackApi(unsupported),
    sendMessage: callbackApi(unsupported),
  }
  const windows = {
    onRemoved: createEvent(),
    onFocusChanged: createEvent(),
    WINDOW_ID_CURRENT: -2,
    WINDOW_ID_NONE: -1,
    getAll: callbackApi(async () => []),
    get: callbackApi(unsupported),
    getCurrent: callbackApi(unsupported),
    create: callbackApi(unsupported),
    update: callbackApi(unsupported),
    remove: callbackApi(unsupported),
  }
  const browser = {
    runtime,
    storage,
    alarms,
    permissions,
    tabs,
    windows,
    i18n: {
      getMessage: (name) => name,
      getUILanguage: () => "en",
      getAcceptLanguages: callbackApi(async () => ["en", "zh-CN"]),
    },
    management: {
      getSelf: callbackApi(async () => ({
        id: runtime.id,
        installType: "normal",
        version: manifest.version,
      })),
    },
    notifications: {
      onClicked: createEvent(),
      onClosed: createEvent(),
      getPermissionLevel: callbackApi(async () => "granted"),
      create: callbackApi(async (id, value) => {
        notifications.set(id, value)
        emit("notifications.onCreated", [id, value])
        return id
      }),
      clear: callbackApi(async (id) => notifications.delete(id)),
      getAll: callbackApi(async () => Object.fromEntries(notifications)),
    },
    cookies: {
      onChanged: createEvent(),
      get: callbackApi(unsupported),
      getAll: callbackApi(unsupported),
      getAllCookieStores: callbackApi(async () => []),
      set: callbackApi(unsupported),
      remove: callbackApi(unsupported),
    },
    contextMenus: {
      onClicked: createEvent(),
      create: () => "",
      removeAll: callbackApi(async () => {}),
      update: callbackApi(async () => {}),
    },
    action: {
      onClicked: createEvent(),
      setBadgeText: callbackApi(async () => {}),
      setBadgeBackgroundColor: callbackApi(async () => {}),
      setTitle: callbackApi(async () => {}),
      setPopup: callbackApi(async () => {}),
    },
    declarativeNetRequest: {
      getSessionRules: callbackApi(async () => []),
      getDynamicRules: callbackApi(async () => []),
      updateSessionRules: callbackApi(unsupported),
      updateDynamicRules: callbackApi(unsupported),
    },
    webRequest: {
      onBeforeRequest: createEvent(),
      onHeadersReceived: createEvent(),
      onBeforeSendHeaders: createEvent(),
      onCompleted: createEvent(),
      onErrorOccurred: createEvent(),
    },
    scripting: { executeScript: callbackApi(unsupported) },
    extension: { inIncognitoContext: false },
  }
  const ALLOWED = new Set([
    ...["local", "sync", "session"].flatMap((area) =>
      ["get", "set", "remove", "clear", "getBytesInUse"].map(
        (method) => `storage.${area}.${method}`,
      ),
    ),
    ...Object.entries({
      runtime: ["sendMessage", "getPlatformInfo", "getBrowserInfo"],
      alarms: ["get", "getAll", "create", "clear", "clearAll"],
      permissions: ["contains", "getAll", "request", "remove"],
      tabs: ["query", "get", "create", "update", "remove", "sendMessage"],
      windows: ["get", "getAll", "getCurrent", "create", "update", "remove"],
      cookies: ["get", "getAll", "set", "remove", "getAllCookieStores"],
      management: ["getSelf"],
      notifications: ["create", "clear", "getAll", "getPermissionLevel"],
      declarativeNetRequest: [
        "getSessionRules",
        "getDynamicRules",
        "updateSessionRules",
        "updateDynamicRules",
      ],
    }).flatMap(([area, methods]) =>
      methods.map((method) => `${area}.${method}`),
    ),
  ])
  return {
    browser,
    locks,
    async call(method, args) {
      if (!ALLOWED.has(method) || !Array.isArray(args) || args.length > 8)
        fail("不支持的扩展 API")
      const parts = method.split("."),
        name = parts.pop(),
        owner = parts.reduce((value, part) => value[part], browser)
      return clone(await owner[name](...clone(args)))
    },
    startAlarms() {
      for (const alarm of Object.values(state.alarms)) arm(alarm)
    },
    async close() {
      locks.close()
      for (const timer of timers.values()) clearTimeout(timer)
      await writes
    },
  }
}
