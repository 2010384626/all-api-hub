import { setupRuntimeMessageListeners } from "~/entrypoints/background/runtimeMessages"
import { initializeServices } from "~/entrypoints/background/servicesInit"
import { accountQueries } from "~/services/accounts/accountStorage/accountQueries"
import type { RawBackupData } from "~/services/importExport/backupContracts"
import { importFromBackupObject } from "~/services/importExport/importExportService"

/** Start upstream services after the Node browser API has been installed. */
export async function initialize() {
  setupRuntimeMessageListeners()
  await initializeServices()
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
