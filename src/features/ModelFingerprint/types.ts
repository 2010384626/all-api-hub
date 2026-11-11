export type FingerprintCandidate = {
  model: string
  display_name?: string
  family_name?: string
  family?: string
  probability?: number | null
}

export type DetectionResult = {
  historyId?: string
  error?: string | null
  referenceBuiltAt?: string
  verificationPending?: boolean
  samples?: {
    state: string
    count: number
    text?: string
    error?: string | null
  }[]
  analysis?: {
    decision?: string
    prediction?: string
    prediction_name?: string
    family_prediction_name?: string
    probability?: number | null
    probability_status?: string
    used_outputs?: number
    results?: FingerprintCandidate[]
  } | null
}

export type DetectionTarget = {
  sourceId: string
  sourceLabel?: string
  keyId?: string
  model: string
  preset: string
  api: string
  userAgent: string
  headers: Record<string, string>
  baseUrl?: string
  apiKey?: string
  stream?: boolean
  parallel?: boolean
  looseMode?: boolean
  autoVerify?: boolean
  effort?: string
  serviceTier?: string
}

export type DetectionTiming =
  | { type: "interval"; everyMinutes: number }
  | { type: "daily"; at: string; timeZone: string }

export type DetectionSchedule = {
  id: string
  name: string
  enabled: boolean
  target: Pick<DetectionTarget, "sourceId" | "sourceLabel" | "model" | "keyId">
  timing: DetectionTiming
  nextRunAt?: string | number | null
  lastRunAt?: string | number | null
  lastError?: string | null
}

export type DetectionHistory = {
  id: string
  startedAt: string | number
  status:
    | "success"
    | "partial"
    | "failed"
    | "cancelled"
    | "running"
    | "interrupted"
    | "sampled"
  sourceLabel?: string
  sourceId?: string
  trigger?: string
  target: { model: string; sourceId?: string }
  result: DetectionResult | null
}
