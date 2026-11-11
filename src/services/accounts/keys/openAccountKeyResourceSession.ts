import { createDisplayAccountApiContext } from "~/services/accounts/utils/apiServiceRequest"
import type { ResourceOperationOptions } from "~/services/apiAdapters/contracts/resourceNative"
import { bindApiTransportRequest } from "~/services/apiTransport/recovery"
import { API_DIRECT_REQUEST_REASONS } from "~/services/apiTransport/type"
import type { ProtectionBypassExecution } from "~/services/protectionBypass/contracts"
import { persistWebKeySession } from "~/services/webCatalogs/keySession"
import { accountCatalogContext } from "~/services/webCatalogs/snapshots"
import type { DisplaySiteData } from "~/types"

/** Opens native key capabilities with the caller's execution policy, without listing resources. */
export async function openAccountKeyResourceSession(
  account: DisplaySiteData,
  protectionBypassExecution: ProtectionBypassExecution,
  options: ResourceOperationOptions,
) {
  const context = createDisplayAccountApiContext(account)
  if (!context.accountKeyResources) return null
  const session = await context.accountKeyResources.open(
    {
      account: {
        id: account.id,
        name: account.name,
        siteType: account.siteType,
      },
      request: bindApiTransportRequest(
        { ...context.request, protectionBypassExecution },
        API_DIRECT_REQUEST_REASONS.CallerManaged,
      ),
    },
    options,
  )
  return persistWebKeySession(
    session,
    `account:${account.id}`,
    accountCatalogContext(account),
  )
}
