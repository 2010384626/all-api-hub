import { beforeEach, expect, it, vi } from "vitest"

import { runWebCatalogRefresh } from "~/services/webCatalogs/scheduler"

const mocks = vi.hoisted(() => ({
  accounts: [
    { id: "one", disabled: false },
    { id: "disabled", disabled: true },
  ],
  profiles: [{ id: "profile" }],
  keys: vi.fn(),
  models: vi.fn(),
  profileModels: vi.fn(),
  prune: vi.fn(),
  refresh: vi.fn(),
  record: vi.fn(),
  schedule: {
    keys: { enabled: false, everyMinutes: 60, lastAttempt: 0 },
    models: { enabled: false, everyMinutes: 60, lastAttempt: 0 },
  },
}))
vi.mock("~/services/accounts/accountStorage/accountQueries", () => ({
  accountQueries: { getAllAccountsOrThrow: async () => mocks.accounts },
}))
vi.mock("~/services/accounts/accountStorage/accountPresentation", () => ({
  accountPresentation: { convertToDisplayData: (value: unknown) => value },
}))
vi.mock("~/services/accounts/utils/apiServiceRequest", () => ({
  fetchDisplayAccountRuntimeKeys: mocks.keys,
}))
vi.mock("~/services/apiCredentialProfiles/modelCatalog", () => ({
  fetchApiCredentialModelIds: mocks.profileModels,
}))
vi.mock("~/services/apiCredentialProfiles/storage/profiles", () => ({
  apiCredentialProfilesStorage: { listProfiles: async () => mocks.profiles },
}))
vi.mock("~/services/modelCatalog/loader", () => ({
  loadAccountCatalogSource: mocks.models,
}))
vi.mock("~/utils/browser/webService", () => ({ isWebService: () => true }))
vi.mock("~/services/webCatalogs/snapshots", () => ({
  pruneWebCatalogOwners: mocks.prune,
  requestWebCatalogRefresh: mocks.refresh,
  recordWebCatalogRun: mocks.record,
  readWebCatalogSchedule: async (kind: "keys" | "models") =>
    mocks.schedule[kind],
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.keys.mockResolvedValue([])
  mocks.models.mockResolvedValue({})
  mocks.profileModels.mockResolvedValue([])
  mocks.schedule.keys = { enabled: false, everyMinutes: 60, lastAttempt: 0 }
  mocks.schedule.models = { enabled: false, everyMinutes: 60, lastAttempt: 0 }
})
it("warms imported active accounts and API profiles without enabling schedules", async () => {
  await runWebCatalogRefresh()
  expect(mocks.keys).toHaveBeenCalledTimes(1)
  expect(mocks.models).toHaveBeenCalledTimes(1)
  expect(mocks.profileModels).toHaveBeenCalledWith(
    expect.objectContaining({ ownerId: "profile:profile" }),
  )
  expect(mocks.prune).toHaveBeenCalledWith(
    new Set([
      "account:one",
      "account:disabled",
      "profile:profile",
      "credential-models",
    ]),
  )
  expect(mocks.refresh).not.toHaveBeenCalled()
})
it("alarm does no network work when schedules disabled or not due", async () => {
  await runWebCatalogRefresh([], true)
  expect(mocks.keys).not.toHaveBeenCalled()
  mocks.schedule.keys = {
    enabled: true,
    everyMinutes: 60,
    lastAttempt: Date.now(),
  }
  await runWebCatalogRefresh([], true)
  expect(mocks.keys).not.toHaveBeenCalled()
})
it("due keys schedule refreshes keys only and records failure without overlapping", async () => {
  mocks.schedule.keys.enabled = true
  mocks.keys.mockRejectedValueOnce(new Error("offline"))
  await runWebCatalogRefresh([], true)
  expect(mocks.refresh).toHaveBeenCalledWith("keys")
  expect(mocks.models).not.toHaveBeenCalled()
  expect(mocks.record).toHaveBeenCalledWith("keys", 1, expect.any(Number))
  let release!: () => void
  mocks.keys.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
  )
  const first = runWebCatalogRefresh([], true)
  await vi.waitFor(() => expect(release).toBeTypeOf("function"))
  await runWebCatalogRefresh([], true)
  expect(mocks.keys).toHaveBeenCalledTimes(2)
  release()
  await first
})
