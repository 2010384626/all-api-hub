import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  loadFingerprintKeys,
  loadFingerprintModels,
  loadFingerprintSources,
  resolveFingerprintCredential,
} from "~/features/ModelFingerprint/library"
import { accountPresentation } from "~/services/accounts/accountStorage/accountPresentation"
import { accountQueries } from "~/services/accounts/accountStorage/accountQueries"
import type { AccountRuntimeKey } from "~/services/accounts/keys/accountRuntimeKeys"
import {
  fetchDisplayAccountRuntimeKeys,
  resolveDisplayAccountRuntimeKeySecret,
} from "~/services/accounts/utils/apiServiceRequest"
import { fetchApiCredentialModelIds } from "~/services/apiCredentialProfiles/modelCatalog"
import { apiCredentialProfilesStorage } from "~/services/apiCredentialProfiles/storage/profiles"

vi.mock("~/services/accounts/accountStorage/accountQueries", () => ({
  accountQueries: { getAllAccountsOrThrow: vi.fn() },
}))
vi.mock("~/services/accounts/accountStorage/accountPresentation", () => ({
  accountPresentation: { convertToDisplayData: vi.fn() },
}))
vi.mock("~/services/accounts/utils/apiServiceRequest", () => ({
  fetchDisplayAccountRuntimeKeys: vi.fn(),
  resolveDisplayAccountRuntimeKeySecret: vi.fn(),
}))
vi.mock("~/services/accounts/utils/credentialExport", () => ({
  resolveAccountRuntimeKeyExternalApiBaseUrl: (
    _account: unknown,
    key: AccountRuntimeKey,
  ) => key.baseUrl,
}))
vi.mock("~/services/apiCredentialProfiles/storage/profiles", () => ({
  apiCredentialProfilesStorage: { listProfiles: vi.fn() },
}))
vi.mock("~/services/apiCredentialProfiles/modelCatalog", () => ({
  fetchApiCredentialModelIds: vi.fn(),
  normalizeApiCredentialModelIds: (ids: string[]) => [...new Set(ids)],
}))

describe("fingerprint library integration", () => {
  beforeEach(() => vi.clearAllMocks())
  it("reads all enabled account types and standalone credentials without copying or skipping Anyrouter/Relayfor", async () => {
    const accounts = [
      { id: "any", site_type: "anyrouter" },
      { id: "relay", site_type: "relayfor" },
      { id: "off", disabled: true },
    ]
    vi.mocked(accountQueries.getAllAccountsOrThrow).mockResolvedValue(
      accounts as never,
    )
    vi.mocked(accountPresentation.convertToDisplayData).mockImplementation(
      (input: any) =>
        input.map((a: any) => ({ id: a.id, name: a.site_type })) as never,
    )
    vi.mocked(apiCredentialProfilesStorage.listProfiles).mockResolvedValue([
      {
        id: "key",
        name: "API credential",
        apiKey: "private",
        baseUrl: "https://api.example.com",
      },
    ] as never)
    const sources = await loadFingerprintSources()
    expect(sources.map((s) => s.id)).toEqual([
      "account:any",
      "account:relay",
      "profile:key",
    ])
    expect(fetchDisplayAccountRuntimeKeys).not.toHaveBeenCalled()
  })
  it("only proposes active inference keys and resolves the selected key through the owner", async () => {
    const active = {
      id: "inference",
      status: "active",
      source: "service_credential",
      capabilities: { inference: true, verify: true, export: true },
      secret: "stored",
      modelAccess: { allowedModelIds: null },
    }
    vi.mocked(fetchDisplayAccountRuntimeKeys).mockResolvedValue([
      active,
      { ...active, id: "management", capabilities: { inference: false } },
      { ...active, id: "inactive", status: "inactive" },
    ] as never)
    const source = {
      id: "account:a",
      label: "Account",
      kind: "account",
      account: { id: "a" },
    } as const
    const keys = await loadFingerprintKeys(source as never)
    expect(keys.map((k) => k.id)).toEqual(["inference"])
    vi.mocked(resolveDisplayAccountRuntimeKeySecret).mockResolvedValue({
      ...active,
      secret: "resolved-key",
      baseUrl: "https://inference.example.com",
    } as never)
    const result = await resolveFingerprintCredential(source as never, keys[0])
    expect(result.apiKey).toBe("resolved-key")
    expect(result.baseUrl).toBe("https://inference.example.com")
  })
  it("keeps saved profile headers and uses Anthropic discovery for Messages", async () => {
    const profile = {
      id: "p",
      name: "Claude",
      apiKey: "profile-key",
      baseUrl: "https://api.example.com",
      requestHeaders: { "x-project": "private-project" },
    }
    const credential = await resolveFingerprintCredential({
      id: "profile:p",
      label: "Claude",
      kind: "profile",
      profile,
    } as never)
    vi.mocked(fetchApiCredentialModelIds).mockResolvedValue([
      "claude-model",
      "claude-model",
    ])
    expect(await loadFingerprintModels(credential, "messages")).toEqual([
      "claude-model",
    ])
    expect(fetchApiCredentialModelIds).toHaveBeenCalledWith(
      expect.objectContaining({
        apiType: "anthropic",
        apiKey: "profile-key",
        requestHeaders: profile.requestHeaders,
      }),
    )
    expect(resolveDisplayAccountRuntimeKeySecret).not.toHaveBeenCalled()
  })
  it("reports source load failures instead of replacing the library with empty data", async () => {
    vi.mocked(accountQueries.getAllAccountsOrThrow).mockRejectedValue(
      new Error("storage unavailable"),
    )
    vi.mocked(apiCredentialProfilesStorage.listProfiles).mockResolvedValue([])
    await expect(loadFingerprintSources()).rejects.toThrow(
      "storage unavailable",
    )
  })
  it("filters discovered models through the selected key's allow and deny rules", async () => {
    vi.mocked(fetchApiCredentialModelIds).mockResolvedValue([
      "allowed",
      "blocked",
      "outside",
    ])
    const runtimeKey = {
      source: "service_credential",
      status: "active",
      secret: "key",
      capabilities: { inference: true },
      modelAccess: {
        groups: null,
        allowedModelIds: ["allowed", "blocked"],
        deniedModelIds: ["blocked"],
        suggestedModelIds: [],
      },
    } as unknown as AccountRuntimeKey
    expect(
      await loadFingerprintModels(
        {
          id: "key",
          label: "Key",
          apiKey: "key",
          baseUrl: "https://api.example.com",
          runtimeKey,
        },
        "chat_completions",
      ),
    ).toEqual(["allowed"])
  })
})
