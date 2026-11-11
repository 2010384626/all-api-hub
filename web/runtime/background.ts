import { setupRuntimeMessageListeners } from "~/entrypoints/background/runtimeMessages"
import { initializeServices } from "~/entrypoints/background/servicesInit"
import {
  loadFingerprintKeys,
  loadFingerprintSources,
  resolveFingerprintCredential,
} from "~/features/ModelFingerprint/library"
import { accountQueries } from "~/services/accounts/accountStorage/accountQueries"
import type { RawBackupData } from "~/services/importExport/backupContracts"
import { importFromBackupObject } from "~/services/importExport/importExportService"
import { initializeWebCatalogScheduler } from "~/services/webCatalogs/scheduler"

/** Start upstream services after the Node browser API has been installed. */
export async function initialize() {
  setupRuntimeMessageListeners()
  await initializeServices()
  await initializeWebCatalogScheduler()
}

/** The same versioned importer used by the original Import/Export page. */
export async function importBackup(payload: RawBackupData) {
  const before = new Set(
    (await accountQueries.getAllAccounts()).map((account) => account.id),
  )
  const result = await importFromBackupObject(payload, { mode: "merge" })
  const after = await accountQueries.getAllAccounts()
  return {
    ...result,
    imported: after.filter((account) => !before.has(account.id)).length,
    skipped: [],
  }
}

/** Resolve saved credentials at execution time so rotations and deleted sources take effect. */
export async function resolveDetectionCredential(
  sourceId: string,
  keyId?: string,
) {
  const source = (await loadFingerprintSources()).find(
    (item) => item.id === sourceId,
  )
  if (!source) throw new Error("检测来源已删除或已停用")
  const keys =
    source.kind === "account" ? await loadFingerprintKeys(source) : []
  const key = keys.find((item) => item.id === keyId)
  if (source.kind === "account" && !key)
    throw new Error("所选调用密钥已不可用，请重新选择")
  const credential = await resolveFingerprintCredential(source, key)
  return {
    ...credential,
    sourceLabel: source.label,
    headers: credential.requestHeaders,
  }
}
