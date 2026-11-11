import type {
  AccountKeyResourceEditor,
  AccountKeyResourceSession,
} from "~/services/apiAdapters/contracts/accountKeyResource"
import { isWebService } from "~/utils/browser/webService"

import { readWebCatalogSnapshot, requestWebCatalogRefresh } from "./snapshots"

/** Persist inventory reads while leaving native editing and secret disclosure live. */
export function persistWebKeySession(
  session: AccountKeyResourceSession,
  owner: string,
  context: string,
): AccountKeyResourceSession {
  if (!isWebService()) return session
  const cached = <T>(scope: string, read: () => Promise<T>) =>
    readWebCatalogSnapshot("keys", owner, scope, context, read)
  const edit = (
    editor: AccountKeyResourceEditor,
  ): AccountKeyResourceEditor => ({
    ...editor,
    async submit(values, options) {
      const result = await editor.submit(values, options)
      await requestWebCatalogRefresh("keys", owner)
      return result
    },
  })
  return {
    ...session,
    resolveDefaultScope: (options) =>
      cached("default-scope", () => session.resolveDefaultScope(options)),
    listScopes: (options) =>
      cached("scopes", () => session.listScopes(options)),
    async openCreateEditor(...args) {
      return edit(await session.openCreateEditor(...args))
    },
    ...(session.listScopeInventory
      ? {
          listScopeInventory: (options) =>
            cached("scope-inventory", () =>
              session.listScopeInventory!(options),
            ),
        }
      : {}),
    async openCollection(scope, options) {
      const collection = await session.openCollection(scope, options)
      return {
        ...collection,
        async openEditEditor(...args) {
          return edit(await collection.openEditEditor(...args))
        },
        list: (query, options) =>
          cached(`list:${scope}:${JSON.stringify(query || {})}`, () =>
            collection.list(query, options),
          ),
        async delete(ref, options) {
          await collection.delete(ref, options)
          await requestWebCatalogRefresh("keys", owner)
        },
        ...(collection.revoke
          ? {
              async revoke(ref, options) {
                const result = await collection.revoke!(ref, options)
                await requestWebCatalogRefresh("keys", owner)
                return result
              },
            }
          : {}),
      }
    },
  }
}
