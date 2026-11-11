import { installWebBridge } from "./web-bridge.mjs"

const base = new URL("./", import.meta.url)
const root = document.getElementById("root")
try {
  const sessionResponse = await fetch(new URL("api/session", base), {
    credentials: "same-origin",
  })
  const session = await sessionResponse.json()
  if (!session.authenticated) {
    location.replace(base.href)
  } else {
    const response = await fetch(new URL("api/extension/bootstrap", base), {
      credentials: "same-origin",
      headers: { "x-aah-client": crypto.randomUUID() },
    })
    const bootstrap = await response.json()
    if (!response.ok)
      throw new Error(
        bootstrap.error || "The server workspace could not be started.",
      )
    installWebBridge({
      ...bootstrap,
      baseUrl: base.href,
      csrfToken: session.csrfToken,
    })
    for (const script of document.querySelectorAll("script[data-aah-src]")) {
      const source = new URL(script.dataset.aahSrc.replace(/^\//, ""), base)
        .href
      if (script.dataset.aahType === "module") await import(source)
      else
        await new Promise((resolve, reject) => {
          const element = document.createElement("script")
          element.src = source
          element.onload = resolve
          element.onerror = () =>
            reject(new Error("Could not load the workspace. Reload to retry."))
          document.head.append(element)
        })
    }
    const logout = document.createElement("button")
    logout.type = "button"
    logout.className = "aah-web-logout"
    const updateLogoutLanguage = () => {
      logout.textContent = document.documentElement.lang.startsWith("zh")
        ? "退出登录"
        : "Sign out"
    }
    updateLogoutLanguage()
    const languageObserver = new MutationObserver(updateLogoutLanguage)
    languageObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["lang"],
    })
    addEventListener("pagehide", () => languageObserver.disconnect(), {
      once: true,
    })
    logout.addEventListener("click", async () => {
      logout.disabled = true
      try {
        const response = await fetch(new URL("api/logout", base), {
          method: "POST",
          headers: { "x-csrf-token": session.csrfToken },
        })
        if (!response.ok) throw new Error("Sign out failed")
        location.replace(base.href)
      } catch {
        logout.disabled = false
      }
    })
    document.body.append(logout)
  }
} catch (error) {
  if (root) {
    root.replaceChildren()
    const message = document.createElement("p")
    message.textContent = error.message
    const reload = document.createElement("button")
    reload.textContent = "重试 / Retry"
    reload.addEventListener("click", () => location.reload())
    root.append(message, reload)
  }
}
