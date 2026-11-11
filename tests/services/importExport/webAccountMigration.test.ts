import { beforeEach, describe, expect, it, vi } from "vitest"

import { BACKUP_VERSION } from "~/constants/importExport"
import { SITE_TYPES } from "~/constants/siteType"
import { accountDataTransfer } from "~/services/accounts/accountStorage/accountDataTransfer"
import { accountQueries } from "~/services/accounts/accountStorage/accountQueries"
import { apiCredentialProfilesStorage } from "~/services/apiCredentialProfiles/storage/profiles"
import { importFromBackupObject } from "~/services/importExport/importExportService"
import { API_TYPES } from "~/services/verification/aiApiVerification"
import { AuthTypeEnum, SiteHealthStatus, type SiteAccount } from "~/types"
import {
  API_CREDENTIAL_PROFILES_CONFIG_VERSION,
  type ApiCredentialProfile,
} from "~/types/apiCredentialProfiles"

const { persisted } = vi.hoisted(() => ({
  persisted: new Map<string, unknown>(),
}))
vi.mock("@plasmohq/storage", () => ({
  Storage: class {
    async get(key: string) {
      return structuredClone(persisted.get(key))
    }
    async set(key: string, value: unknown) {
      persisted.set(key, structuredClone(value))
    }
    async remove(key: string) {
      persisted.delete(key)
    }
  },
}))

/** Full canonical account fixtures, including cookie-only Anyrouter sessions. */
const account = (
  siteType: SiteAccount["site_type"],
  id: string,
  cookie = false,
): SiteAccount => ({
  id,
  configVersion: 8,
  site_name: siteType === SITE_TYPES.ANYROUTER ? "Anyrouter" : "Relayfor",
  site_type: siteType,
  site_url: `https://${siteType}.example.com`,
  authType: cookie ? AuthTypeEnum.Cookie : AuthTypeEnum.AccessToken,
  ...(cookie
    ? { cookieAuth: { sessionCookie: "session=fake-anyrouter-cookie" } }
    : {}),
  account_info: {
    id: "42",
    username: "import-user",
    access_token: cookie ? "" : "fake-relayfor-token",
    quota: 1250000,
    today_prompt_tokens: 0,
    today_completion_tokens: 0,
    today_quota_consumption: 0,
    today_requests_count: 0,
    today_income: 0,
  },
  health: { status: SiteHealthStatus.Healthy },
  exchange_rate: 7.2,
  disabled: false,
  excludeFromTotalBalance: false,
  excludeFromTodayIncome: false,
  last_sync_time: 100,
  updated_at: 100,
  user_updated_at: 100,
  created_at: 100,
  notes: "Keep provider-specific state",
  tagIds: [],
  checkIn: {
    automaticExecutionEnabled: false,
    methodKnowledge: { methods: {} },
    selection: { mode: "automatic" },
  },
})
const profile: ApiCredentialProfile = {
  id: "saved-profile",
  name: "Imported model credential",
  apiType: API_TYPES.OPENAI_COMPATIBLE,
  baseUrl: "https://inference.example.com",
  apiKey: "fake-inference-key",
  requestHeaders: { "x-project": "fixture-project" },
  tagIds: [],
  notes: "preserve this credential",
  createdAt: 100,
  updatedAt: 100,
}
const backup = () => ({
  version: BACKUP_VERSION,
  timestamp: 100,
  accounts: {
    accounts: [
      account(SITE_TYPES.ANYROUTER, "anyrouter", true),
      account(SITE_TYPES.RELAYFOR, "relayfor"),
    ],
    bookmarks: [],
    pinnedAccountIds: ["relayfor"],
    orderedAccountIds: ["anyrouter", "relayfor"],
    last_updated: 100,
  },
  apiCredentialProfiles: {
    version: API_CREDENTIAL_PROFILES_CONFIG_VERSION,
    profiles: [profile],
    links: [],
    linkTombstones: [],
    lastUpdated: 100,
  },
})

describe("native backup importer for the VPS workspace", () => {
  beforeEach(() => persisted.clear())

  it("preserves Anyrouter cookie accounts, Relayfor tokens, profile headers and account ordering", async () => {
    const result = await importFromBackupObject(backup(), {
      plan: { accounts: "replace", apiCredentialProfiles: "replace" },
    })
    expect(result.allImported).toBe(true)
    expect(result.sections).toMatchObject({
      accounts: true,
      apiCredentialProfiles: true,
    })
    const accounts = await accountQueries.getAllAccountsOrThrow()
    expect(accounts.map((item) => item.site_type)).toEqual([
      SITE_TYPES.ANYROUTER,
      SITE_TYPES.RELAYFOR,
    ])
    expect(accounts[0]).toMatchObject({
      id: "anyrouter",
      authType: AuthTypeEnum.Cookie,
      cookieAuth: { sessionCookie: "session=fake-anyrouter-cookie" },
      account_info: { access_token: "", quota: 1250000 },
    })
    expect(accounts[1]).toMatchObject({
      id: "relayfor",
      account_info: { access_token: "fake-relayfor-token" },
    })
    expect(await apiCredentialProfilesStorage.listProfiles()).toEqual([
      expect.objectContaining(profile),
    ])
    expect(await accountDataTransfer.exportData()).toMatchObject({
      pinnedAccountIds: ["relayfor"],
      orderedAccountIds: ["anyrouter", "relayfor"],
    })
  })

  it("merges the same backup without duplicates or dropping previously saved accounts and credentials", async () => {
    await accountDataTransfer.importData({
      accounts: [account(SITE_TYPES.NEW_API, "existing")],
    })
    await apiCredentialProfilesStorage.importConfig({
      version: API_CREDENTIAL_PROFILES_CONFIG_VERSION,
      profiles: [
        { ...profile, id: "existing-profile", apiKey: "existing-key" },
      ],
      links: [],
      linkTombstones: [],
      lastUpdated: 100,
    })
    await importFromBackupObject(backup(), { mode: "merge" })
    await importFromBackupObject(backup(), { mode: "merge" })
    expect(
      (await accountQueries.getAllAccountsOrThrow()).map((item) => item.id),
    ).toEqual(["existing", "anyrouter", "relayfor"])
    expect(
      (await apiCredentialProfilesStorage.listProfiles())
        .map((item) => item.id)
        .sort(),
    ).toEqual(["existing-profile", "saved-profile"])
  })
})
