import { accountPresentation } from "~/services/accounts/accountStorage/accountPresentation"
import { accountQueries } from "~/services/accounts/accountStorage/accountQueries"
import {
  isAccountRuntimeKeyCompatibleWithModel,
  isInferenceCapableAccountRuntimeKey,
  isSelectableAccountRuntimeKey,
  type AccountRuntimeKey,
} from "~/services/accounts/keys/accountRuntimeKeys"
import {
  fetchDisplayAccountRuntimeKeys,
  resolveDisplayAccountRuntimeKeySecret,
} from "~/services/accounts/utils/apiServiceRequest"
import { resolveAccountRuntimeKeyExternalApiBaseUrl } from "~/services/accounts/utils/credentialExport"
import {
  fetchApiCredentialModelIds,
  normalizeApiCredentialModelIds,
} from "~/services/apiCredentialProfiles/modelCatalog"
import { apiCredentialProfilesStorage } from "~/services/apiCredentialProfiles/storage/profiles"
import { API_TYPES } from "~/services/verification/aiApiVerification"
import type { DisplaySiteData } from "~/types"
import type { ApiCredentialProfile } from "~/types/apiCredentialProfiles"

export type FingerprintSource =
  | { id: string; label: string; kind: "account"; account: DisplaySiteData }
  | {
      id: string
      label: string
      kind: "profile"
      profile: ApiCredentialProfile
    }

export type FingerprintCredential = {
  id: string
  label: string
  baseUrl: string
  apiKey: string
  requestHeaders?: Record<string, string>
  runtimeKey?: AccountRuntimeKey
}

/** Reload the existing owners; importing here would duplicate account storage. */
export async function loadFingerprintSources(): Promise<FingerprintSource[]> {
  const [accounts, profiles] = await Promise.all([
    accountQueries.getAllAccountsOrThrow(),
    apiCredentialProfilesStorage.listProfiles(),
  ])
  return [
    ...accountPresentation
      .convertToDisplayData(accounts.filter((a) => !a.disabled))
      .map((account) => ({
        id: `account:${account.id}`,
        label: account.name,
        kind: "account" as const,
        account,
      })),
    ...profiles.map((profile) => ({
      id: `profile:${profile.id}`,
      label: profile.name,
      kind: "profile" as const,
      profile,
    })),
  ]
}

/** This is read-only inventory: never issue or rotate a key to run a detection. */
export async function loadFingerprintKeys(
  source: FingerprintSource,
  signal?: AbortSignal,
  forceRefresh = false,
): Promise<AccountRuntimeKey[]> {
  if (source.kind === "profile") return []
  return (
    await fetchDisplayAccountRuntimeKeys(source.account, {
      signal,
      forceRefresh,
    })
  ).filter(
    (key) =>
      key.status === "active" &&
      isInferenceCapableAccountRuntimeKey(key) &&
      isSelectableAccountRuntimeKey(key),
  )
}

/** Resolve a selected inference credential using its canonical secret owner. */
export async function resolveFingerprintCredential(
  source: FingerprintSource,
  key?: AccountRuntimeKey,
  signal?: AbortSignal,
): Promise<FingerprintCredential> {
  if (source.kind === "profile") {
    const profile = source.profile
    return {
      id: source.id,
      label: profile.name,
      baseUrl: profile.baseUrl,
      apiKey: profile.apiKey,
      requestHeaders: profile.requestHeaders,
    }
  }
  if (!key) throw new Error("No inference credential selected")
  const resolved = await resolveDisplayAccountRuntimeKeySecret(
    source.account,
    key,
    { abortSignal: signal },
  )
  return {
    id: resolved.id,
    label: resolved.label,
    baseUrl: resolveAccountRuntimeKeyExternalApiBaseUrl(
      source.account,
      resolved,
    ),
    apiKey: resolved.secret,
    runtimeKey: resolved,
  }
}

/** Model discovery uses the same provider-specific client as API credentials. */
export async function loadFingerprintModels(
  credential: FingerprintCredential,
  protocol: string,
  signal?: AbortSignal,
  forceRefresh = false,
) {
  const models = normalizeApiCredentialModelIds(
    await fetchApiCredentialModelIds({
      ownerId: credential.id.startsWith("profile:")
        ? credential.id
        : "credential-models",
      forceRefresh,
      apiType:
        protocol === "messages"
          ? API_TYPES.ANTHROPIC
          : API_TYPES.OPENAI_COMPATIBLE,
      baseUrl: credential.baseUrl,
      apiKey: credential.apiKey,
      requestHeaders: credential.requestHeaders,
      abortSignal: signal,
    }),
  )
  return credential.runtimeKey
    ? models.filter((id) =>
        isAccountRuntimeKeyCompatibleWithModel(credential.runtimeKey!, { id }),
      )
    : models
}
