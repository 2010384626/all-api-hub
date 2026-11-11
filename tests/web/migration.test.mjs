import assert from "node:assert/strict"
import test from "node:test"

import {
  legacyAccountsToBackup,
  migrateLegacyWebState,
} from "../../web/server/legacy-migration.mjs"

test("v0.1 upgrade retains accounts and moves inference keys into the native credential library once", async () => {
  const state = {
    accounts: [
      {
        id: "one",
        name: "Relay",
        siteType: "new-api",
        baseUrl: "https://relay.example",
        token: "management",
        apiKey: "inference",
        userId: "42",
        balance: 2,
        autoCheckin: true,
      },
      {
        id: "two",
        name: "Standalone",
        siteType: "credential",
        baseUrl: "https://api.example/v1",
        apiKey: "standalone",
      },
    ],
    history: [{ action: "refresh" }],
  }
  const store = {
    read: async () => structuredClone(state),
    mutate: async (fn) => fn(state),
  }
  assert.equal(await migrateLegacyWebState(store), true)
  const local = state.extensionState.local
  const accounts = JSON.parse(local.site_accounts).accounts
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0].account_info.access_token, "management")
  assert.equal(accounts[0].account_info.quota, 1000000)
  assert.equal(accounts[0].checkIn.automaticExecutionEnabled, true)
  const profiles = JSON.parse(local.api_credential_profiles).profiles
  assert.deepEqual(
    profiles.map((p) => p.apiKey),
    ["inference", "standalone"],
  )
  assert.equal(profiles[1].baseUrl, "https://api.example")
  state.extensionState.local.extra = "retained"
  assert.equal(await migrateLegacyWebState(store), false)
  assert.equal(state.extensionState.local.extra, "retained")
  assert.equal(state.history.length, 1)
})

test("unavailable legacy balance stays unavailable, and empty backup is accepted", () => {
  const backup = legacyAccountsToBackup([
    {
      id: "one",
      name: "Pending",
      baseUrl: "https://relay.example",
      siteType: "sub2api",
      token: "token",
    },
  ])
  assert.equal(
    backup.accounts.accounts[0].account_info.balanceUnavailable,
    true,
  )
  assert.deepEqual(legacyAccountsToBackup([]).accounts.accounts, [])
})
