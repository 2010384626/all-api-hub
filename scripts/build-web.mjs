import { spawnSync } from "node:child_process"
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const destination = path.join(root, "web/dist")
if (!process.argv.includes("--from-build")) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "node_modules/wxt/bin/wxt.mjs"), "build"],
    {
      cwd: root,
      env: {
        ...process.env,
        AAH_WEB_BUILD: "1",
        VITE_PUBLIC_POSTHOG_PROJECT_TOKEN: "",
        VITE_PUBLIC_POSTHOG_HOST: "",
      },
      stdio: "inherit",
    },
  )
  if (result.status !== 0) process.exit(result.status || 1)
}
const source = path.join(root, ".output/chrome-mv3")
await readFile(path.join(source, "manifest.json"))
for (const directory of [destination]) {
  if (!directory.startsWith(path.join(root, "web") + path.sep))
    throw new Error("Unexpected build output")
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })
  await cp(source, directory, { recursive: true })
}
for (const name of await readdir(destination)) {
  if (!name.endsWith(".html")) continue
  const filename = path.join(destination, name)
  let html = await readFile(filename, "utf8")
  html = html.replace(/\b(href|src)="\/([^"/][^"]*)"/g, '$1="$2"')
  html = html.replace(/\b(href|src)="(?:\.\.\/)+(chunks|assets)\//g, '$1="$2/')
  html = html.replace(
    /<script\b([^>]*?)\bsrc="([^"]+)"([^>]*)><\/script>/g,
    (_match, before, url, after) => {
      const type = /type="module"/.test(before + after) ? "module" : "classic"
      return `<script type="application/json" data-aah-src="${url}" data-aah-type="${type}"></script>`
    },
  )
  html = html.replace(
    "</head>",
    '<link rel="stylesheet" href="web.css"><script type="module" src="web-bootstrap.mjs"></script></head>',
  )
  await writeFile(filename, html)
}
await cp(
  path.join(root, "web/client/bridge.mjs"),
  path.join(destination, "web-bridge.mjs"),
)
await cp(
  path.join(root, "web/client/bootstrap.mjs"),
  path.join(destination, "web-bootstrap.mjs"),
)
await cp(
  path.join(root, "web/client/web.css"),
  path.join(destination, "web.css"),
)
console.log("Built original UI for the Web service.")
const { build } = await import("vite")
await build({
  configFile: false,
  root,
  publicDir: false,
  resolve: {
    alias: [
      { find: /^~~\//, replacement: root },
      { find: /^~\//, replacement: path.join(root, "src") + "/" },
    ],
  },
  define: {
    "import.meta.env.BROWSER": JSON.stringify("chrome"),
    "import.meta.env.FIREFOX": "false",
    __AAH_DEV_IDENTITY__: "null",
    __AAH_BUILD_REVISION__: "null",
    __AAH_DISTRIBUTION_CHANNEL__: JSON.stringify("unknown"),
  },
  ssr: { noExternal: true },
  build: {
    ssr: path.join(root, "web/runtime/background.ts"),
    outDir: path.join(root, "web/server/generated"),
    emptyOutDir: true,
    target: "node24",
    rollupOptions: { output: { entryFileNames: "background.mjs" } },
  },
})
console.log("Built original background services for Node.js.")
