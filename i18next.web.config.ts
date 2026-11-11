import { defineConfig } from "i18next-cli"

import sharedConfig from "./i18next.config"

/** The Web-only page is offered in the two languages supported by that host. */
export default defineConfig({
  ...sharedConfig,
  locales: ["zh-CN", "en"],
  extract: {
    ...sharedConfig.extract,
    input: [
      "src/features/ModelFingerprint/**/*.{ts,tsx}",
      "src/features/WebCatalogSchedule/**/*.{ts,tsx}",
      "src/features/OptionsMenu/getMenuItemLabel.ts",
    ],
    // Keep existing application namespace files outside this scoped pass.
    ignore: ["src/locales/*/!(modelFingerprint|catalogPersistence).json"],
    ignoreNamespaces: ["ui"],
    primaryLanguage: "zh-CN",
    secondaryLanguages: ["en"],
    // This Web-specific error is also rendered by shared account/key flows.
    preservePatterns: ["catalogPersistence:credentialRedacted"],
  },
})
