import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import { Button, Input, Label } from "~/components/ui"
import {
  readWebCatalogSchedule,
  saveWebCatalogSchedule,
  WEB_CATALOG_STORAGE_KEY,
  type CatalogKind,
  type CatalogSchedule,
} from "~/services/webCatalogs/snapshots"
import { onStorageChanged } from "~/utils/browser/storage"
import { isWebService } from "~/utils/browser/webService"

/** Controls the server-owned refresh schedule shared by all saved sources. */
export function WebCatalogSchedule({ kind }: { kind: CatalogKind }) {
  const { t } = useTranslation("catalogPersistence")
  const [schedule, setSchedule] = useState<CatalogSchedule | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [minutes, setMinutes] = useState(60)
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!isWebService()) return
    let disposed = false
    const load = async (updateForm = false) => {
      try {
        const next = await readWebCatalogSchedule(kind)
        if (disposed) return
        setSchedule(next)
        if (updateForm) {
          setEnabled(next.enabled)
          setMinutes(next.everyMinutes)
        }
      } catch {
        if (!disposed) setError(t("loadFailed"))
      }
    }
    void load(true)
    const changed = (changes: Record<string, unknown>) => {
      if (changes[WEB_CATALOG_STORAGE_KEY]) void load()
    }
    const unsubscribe = onStorageChanged(changed)
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [kind, t])
  if (!isWebService()) return null
  return (
    <details
      className="mb-4 rounded-lg border border-border bg-card p-3"
      data-testid={`catalog-schedule-${kind}`}
    >
      <summary className="cursor-pointer text-sm font-medium">
        {t("title")}
      </summary>
      <p className="mt-2 text-sm text-muted-foreground">{t("description")}</p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <Label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          {t("enabled")}
        </Label>
        <div>
          <Label htmlFor={`catalog-minutes-${kind}`}>{t("interval")}</Label>
          <Input
            id={`catalog-minutes-${kind}`}
            className="mt-1 w-32"
            type="number"
            min={5}
            max={43200}
            value={minutes}
            onChange={(event) => setMinutes(Number(event.target.value))}
          />
        </div>
        <Button
          size="sm"
          loading={saving}
          onClick={async () => {
            setSaving(true)
            setError("")
            try {
              await saveWebCatalogSchedule(kind, enabled, minutes)
              setSchedule(await readWebCatalogSchedule(kind))
            } catch {
              setError(t("saveFailed"))
            } finally {
              setSaving(false)
            }
          }}
        >
          {t("save")}
        </Button>
      </div>
      {schedule?.lastAttempt && (
        <p className="mt-2 text-xs text-muted-foreground">
          {t("lastAttempt", {
            time: new Date(schedule.lastAttempt).toLocaleString(),
            count: schedule.failures || 0,
          })}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive-text">
          {error}
        </p>
      )}
    </details>
  )
}
