import { accountPresentation } from "~/services/accounts/accountStorage/accountPresentation"
import { accountQueries } from "~/services/accounts/accountStorage/accountQueries"
import { fetchDisplayAccountRuntimeKeys } from "~/services/accounts/utils/apiServiceRequest"
import { fetchApiCredentialModelIds } from "~/services/apiCredentialProfiles/modelCatalog"
import { apiCredentialProfilesStorage } from "~/services/apiCredentialProfiles/storage/profiles"
import {
  ACCOUNT_STORAGE_KEYS,
  API_CREDENTIAL_PROFILES_STORAGE_KEYS,
} from "~/services/core/storageKeys"
import { loadAccountCatalogSource } from "~/services/modelCatalog/loader"
import { createAlarm, onAlarm } from "~/utils/browser/alarms"
import { onStorageChanged } from "~/utils/browser/storage"
import { isWebService } from "~/utils/browser/webService"

import {
  pruneWebCatalogOwners,
  readWebCatalogSchedule,
  recordWebCatalogRun,
  requestWebCatalogRefresh,
  type CatalogKind,
} from "./snapshots"

const ALARM = "web-catalog-refresh"
let active = false
let warmupPending = false

/** Warm imported sources once and refresh only the explicitly enabled schedules. */
export async function runWebCatalogRefresh(
  forceKinds: CatalogKind[] = [],
  scheduledOnly = false,
) {
  if (!isWebService()) return
  if (active) {
    if (!scheduledOnly) warmupPending = true
    return
  }
  active = true
  try {
    const stored = await accountQueries.getAllAccountsOrThrow()
    const profiles = await apiCredentialProfilesStorage.listProfiles()
    const owners = new Set([
      ...stored.map((account) => `account:${account.id}`),
      ...profiles.map((profile) => `profile:${profile.id}`),
      "credential-models",
    ])
    await pruneWebCatalogOwners(owners)
    const accounts = accountPresentation.convertToDisplayData(
      stored.filter((account) => !account.disabled),
    )
    const now = Date.now()
    for (const kind of ["keys", "models"] as const) {
      const schedule = await readWebCatalogSchedule(kind)
      const forced =
        forceKinds.includes(kind) ||
        (schedule.enabled &&
          (!schedule.lastAttempt ||
            now - schedule.lastAttempt >= schedule.everyMinutes * 60_000))
      if (scheduledOnly && !forced) continue
      if (forced) await requestWebCatalogRefresh(kind)
      let failures = 0
      for (const account of accounts) {
        try {
          if (kind === "keys") await fetchDisplayAccountRuntimeKeys(account)
          else
            await loadAccountCatalogSource({
              account,
              loadScope: {},
              includeRuntimeKeyCatalogs: true,
            })
        } catch {
          failures++
        }
      }
      if (kind === "models")
        for (const profile of profiles) {
          try {
            await fetchApiCredentialModelIds({
              ...profile,
              ownerId: `profile:${profile.id}`,
            })
          } catch {
            failures++
          }
        }
      if (forced) await recordWebCatalogRun(kind, failures, now)
    }
  } finally {
    active = false
    if (warmupPending) {
      warmupPending = false
      void runWebCatalogRefresh().catch(() => {})
    }
  }
}

/** Called once in the persistent Node worker, never from a page lifecycle. */
export function initializeWebCatalogScheduler() {
  if (!isWebService()) return
  let pending: ReturnType<typeof setTimeout> | undefined
  const scheduleWarmup = () => {
    clearTimeout(pending)
    pending = setTimeout(() => {
      void runWebCatalogRefresh().catch(() => {})
    }, 500)
  }
  onStorageChanged((changes, area) => {
    if (
      area === "local" &&
      (changes[ACCOUNT_STORAGE_KEYS.ACCOUNTS] ||
        changes[API_CREDENTIAL_PROFILES_STORAGE_KEYS.API_CREDENTIAL_PROFILES])
    )
      scheduleWarmup()
  })
  onAlarm((alarm) => {
    if (alarm.name === ALARM)
      void runWebCatalogRefresh([], true).catch(() => {})
  })
  void createAlarm(ALARM, { periodInMinutes: 1 })
  scheduleWarmup()
}
