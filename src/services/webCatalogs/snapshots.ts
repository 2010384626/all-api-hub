import { Storage } from "@plasmohq/storage"

import { STORAGE_LOCKS } from "~/services/core/storageKeys"
import { withExtensionStorageWriteLock } from "~/services/core/storageWriteLock"
import { isWebService } from "~/utils/browser/webService"
import { safeRandomUUID } from "~/utils/core/identifier"

export const WEB_CATALOG_STORAGE_KEY = "web_catalog_snapshots_v1"
export type CatalogKind = "keys" | "models"
type Entry = {
  kind: CatalogKind
  owner: string
  context: string
  value: unknown
  updatedAt: number
  refreshRequested?: boolean
}
export type CatalogSchedule = {
  enabled: boolean
  everyMinutes: number
  lastAttempt?: number
  lastSuccess?: number
  failures?: number
}
type State = {
  entries: Record<string, Entry>
  pending?: Record<string, { kind: CatalogKind; owner: string; id: string }>
  schedules: Record<CatalogKind, CatalogSchedule>
}
const storage = new Storage({ area: "local" })
const defaults = (): State => ({
  entries: {},
  schedules: {
    keys: { enabled: false, everyMinutes: 60 },
    models: { enabled: false, everyMinutes: 60 },
  },
})
const read = async (): Promise<State> =>
  (await storage.get<State>(WEB_CATALOG_STORAGE_KEY)) ?? defaults()
const mutate = <T>(change: (state: State) => T) =>
  withExtensionStorageWriteLock(
    STORAGE_LOCKS.WEB_CATALOG_SNAPSHOTS,
    async () => {
      const state = await read()
      const result = change(state)
      await storage.set(WEB_CATALOG_STORAGE_KEY, state)
      return result
    },
  )

/** Web snapshots have no implicit expiry; failures leave the last successful value intact. */
export async function readWebCatalogSnapshot<T>(
  kind: CatalogKind,
  owner: string,
  scope: string,
  context: string,
  load: () => Promise<T>,
  force = false,
): Promise<T> {
  if (!isWebService()) return load()
  const key = JSON.stringify([kind, owner, scope])
  const requestId = safeRandomUUID()
  const admission = await withExtensionStorageWriteLock(
    STORAGE_LOCKS.WEB_CATALOG_SNAPSHOTS,
    async () => {
      const state = await read()
      const entry = state.entries[key]
      if (!force && entry?.context === context && !entry.refreshRequested)
        return { cached: true as const, value: entry.value as T }
      state.pending ??= {}
      state.pending[key] = { kind, owner, id: requestId }
      await storage.set(WEB_CATALOG_STORAGE_KEY, state)
      return { cached: false as const }
    },
  )
  if (admission.cached) return admission.value
  let value: T
  try {
    value = await load()
  } catch (error) {
    await mutate((state) => {
      const saved = state.entries[key]
      if (state.pending?.[key]?.id === requestId) {
        if (saved?.context === context) saved.refreshRequested = false
        delete state.pending[key]
      }
    })
    throw error
  }
  await mutate((state) => {
    if (state.pending?.[key]?.id === requestId) {
      state.entries[key] = {
        kind,
        owner,
        context,
        value,
        updatedAt: Date.now(),
      }
      delete state.pending[key]
    }
  })
  return value
}

/** Mark for replacement without deleting the last successful snapshot. */
export async function requestWebCatalogRefresh(
  kind: CatalogKind,
  owner?: string,
) {
  if (!isWebService()) return
  await mutate((state) => {
    for (const entry of Object.values(state.entries))
      if (entry.kind === kind && (!owner || owner === entry.owner))
        entry.refreshRequested = true
    for (const [key, pending] of Object.entries(state.pending || {}))
      if (pending.kind === kind && (!owner || owner === pending.owner))
        delete state.pending![key]
  })
}

/** Remove snapshots and pending reads for deleted sources. */
export async function pruneWebCatalogOwners(owners: Set<string>) {
  await mutate((state) => {
    for (const [key, entry] of Object.entries(state.entries))
      if (!owners.has(entry.owner)) delete state.entries[key]
    for (const [key, pending] of Object.entries(state.pending || {}))
      if (!owners.has(pending.owner)) delete state.pending![key]
  })
}

/** Read the saved refresh settings for one catalog. */
export async function readWebCatalogSchedule(kind: CatalogKind) {
  return (await read()).schedules[kind]
}
/** Save the explicit refresh interval without replacing run history. */
export async function saveWebCatalogSchedule(
  kind: CatalogKind,
  enabled: boolean,
  everyMinutes: number,
) {
  if (
    !Number.isInteger(everyMinutes) ||
    everyMinutes < 5 ||
    everyMinutes > 43200
  )
    throw new Error("Interval must be between 5 and 43200 minutes")
  await mutate((state) => {
    state.schedules[kind] = { ...state.schedules[kind], enabled, everyMinutes }
  })
}
/** Record the latest refresh attempt and its failure count. */
export async function recordWebCatalogRun(
  kind: CatalogKind,
  failures: number,
  at = Date.now(),
) {
  await mutate((state) => {
    const schedule = state.schedules[kind]
    schedule.lastAttempt = at
    schedule.failures = failures
    if (!failures) schedule.lastSuccess = at
  })
}

/** Include credential identity inside encrypted storage, never in a public cache key. */
export function accountCatalogContext(account: {
  baseUrl: string
  siteType: string
  userId: string
  authType: string
  token: string
  cookieAuthSessionCookie?: string
}) {
  return JSON.stringify([
    account.baseUrl,
    account.siteType,
    account.userId,
    account.authType,
    account.token,
    account.cookieAuthSessionCookie || "",
  ])
}
