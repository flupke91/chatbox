import platform from '@/platform'
import { getLogger } from '@/lib/utils'

const log = getLogger('telemetry')

const ENDPOINT = '/api/telemetry'
const MAX_PER_SESSION = 40
const DEDUPE_WINDOW_MS = 60_000
const MAX_MESSAGE_CHARS = 500
const MAX_STACK_CHARS = 4000

type TelemetryKind =
  | 'window_error'
  | 'unhandled_rejection'
  | 'attachment_preprocess_error'
  | 'rag_index_error'
  | 'rag_query_error'
  | 'rag_query_result'

interface TelemetryPayload {
  kind: TelemetryKind
  message: string
  stack?: string
  context?: Record<string, unknown>
  /** Overrides the dedupe key when several distinct events share the same kind+message. */
  dedupeKey?: string
}

let installed = false
let sentCount = 0
const seen = new Map<string, number>()

function isEnabled(): boolean {
  // Only the browser build has a server to receive these; desktop/mobile keep local logs.
  if (platform.type !== 'web' || typeof window === 'undefined') return false
  try {
    if (window.localStorage.getItem('telemetry') === '0') return false
  } catch {
    // private mode — keep telemetry on
  }
  return true
}

function trim(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function shouldSend(message: string): boolean {
  if (sentCount >= MAX_PER_SESSION) return false
  const now = Date.now()
  const last = seen.get(message)
  if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return false
  seen.set(message, now)
  sentCount += 1
  return true
}

/**
 * Best-effort, fire-and-forget report of a client-side failure.
 *
 * Deliberately small and privacy-scoped: error text, stack, route and a few structured context
 * fields. No conversation content, no attachment text, no credentials, no user identifiers.
 */
export function reportTelemetry(payload: TelemetryPayload): void {
  if (!isEnabled()) return
  const message = trim(payload.message, MAX_MESSAGE_CHARS) ?? 'unknown error'
  if (!shouldSend(payload.dedupeKey ?? `${payload.kind}:${message}`)) return

  const body = JSON.stringify({
    kind: payload.kind,
    message,
    stack: trim(payload.stack, MAX_STACK_CHARS),
    context: payload.context,
    route: window.location.pathname,
    version: window.localStorage.getItem('app-version') ?? undefined,
    ua: navigator.userAgent,
    at: new Date().toISOString(),
  })

  try {
    void fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => undefined)
  } catch {
    // never let telemetry break the app
  }
}

export function installWebTelemetry(): void {
  if (installed || !isEnabled()) return
  installed = true

  window.addEventListener('error', (event) => {
    const error = event.error as Error | undefined
    reportTelemetry({
      kind: 'window_error',
      message: error?.message || event.message || 'unknown window error',
      stack: error?.stack,
      context: { source: event.filename, line: event.lineno, col: event.colno },
    })
  })

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason as { message?: string; stack?: string } | undefined
    reportTelemetry({
      kind: 'unhandled_rejection',
      message: String(reason?.message ?? reason ?? 'unhandled rejection'),
      stack: reason?.stack,
    })
  })

  log.debug('web telemetry installed')
}
