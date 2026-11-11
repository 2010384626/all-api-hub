export function legacyAccountsToBackup(records) {
  const now = Date.now()
  const accounts = [],
    profiles = []
  for (const old of records) {
    if (old.siteType !== "credential") {
      accounts.push({
        id: old.id,
        site_name: old.name,
        site_url: old.baseUrl,
        site_type: old.siteType,
        authType: "access_token",
        exchange_rate: 7.2,
        tagIds: [],
        notes: "",
        health: { status: "unknown" },
        disabled: false,
        excludeFromTotalBalance: false,
        excludeFromTodayIncome: false,
        account_info: {
          id: old.userId || "",
          access_token: old.token || "",
          username: old.name,
          quota: (old.balance || 0) * 500000,
          balanceUnavailable: old.balance == null,
          today_prompt_tokens: 0,
          today_completion_tokens: 0,
          today_quota_consumption: 0,
          today_requests_count: 0,
          today_income: 0,
        },
        created_at: Date.parse(old.createdAt) || now,
        updated_at: now,
        user_updated_at: now,
        last_sync_time: Date.parse(old.lastRefresh) || 0,
        configVersion: 8,
        checkIn: {
          automaticExecutionEnabled: Boolean(old.autoCheckin),
          methodKnowledge: { methods: {} },
          selection: { mode: "automatic" },
        },
      })
    }
    if (old.apiKey)
      profiles.push({
        id: `web-${old.id}`,
        name: old.name,
        apiType: "openai-compatible",
        baseUrl: old.baseUrl.replace(/\/v1\/?$/, ""),
        apiKey: old.apiKey,
        tagIds: [],
        notes: "",
        createdAt: Date.parse(old.createdAt) || now,
        updatedAt: now,
      })
  }
  return {
    version: "4.0",
    timestamp: now,
    accounts: {
      accounts,
      bookmarks: [],
      pinnedAccountIds: [],
      orderedAccountIds: accounts.map((a) => a.id),
      deletedEntryRecords: {},
      last_updated: now,
    },
    apiCredentialProfiles: {
      version: 8,
      profiles,
      links: [],
      linkTombstones: [],
      lastUpdated: now,
    },
  }
}

/** Move the released v0.1 Web data into the original application's storage schema. */
export async function migrateLegacyWebState(store) {
  const current = await store.read()
  if (current.extensionState) return false
  await store.mutate((state) => {
    if (state.extensionState) return
    const backup = legacyAccountsToBackup(state.accounts)
    state.extensionState = {
      local: {
        site_accounts: JSON.stringify(backup.accounts),
        api_credential_profiles: JSON.stringify(backup.apiCredentialProfiles),
      },
      sync: {},
    }
    // Keep the old snapshot in the encrypted file for rollback; the native runtime owns future writes.
    state.nativeMigrationAt = backup.timestamp
  })
  return true
}
