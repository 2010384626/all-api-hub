import { createServer } from "node:http"

import { createApp } from "./app.mjs"
import { createExtensionRuntime } from "./extension-runtime.mjs"
import { migrateLegacyWebState } from "./legacy-migration.mjs"

const app = await createApp({
  runtimeFactory: async ({ store, fetchImpl }) => {
    await migrateLegacyWebState(store)
    return createExtensionRuntime({ store, fetchImpl })
  },
})
const port = Number(process.env.PORT || 3000)
const server = createServer(
  { requestTimeout: 30_000, headersTimeout: 15_000 },
  app.handler,
)
server.listen(port, process.env.HOST || "0.0.0.0", () =>
  console.log(`All API Hub Web listening on port ${port}${app.base}`),
)
const timer = setInterval(
  () =>
    app
      .tick()
      .catch(() =>
        console.error(
          "Scheduled check-in failed; check encrypted storage and configuration.",
        ),
      ),
  60_000,
)
timer.unref()
void app.tick().catch(() => console.error("Initial scheduled check-in failed."))
const shutdown = async () => {
  clearInterval(timer)
  server.close()
  await app.close()
  setTimeout(() => process.exit(0), 10_000).unref()
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
