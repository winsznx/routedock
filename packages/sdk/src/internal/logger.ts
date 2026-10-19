/**
 * Structured logging hook shared by the client and provider adapters.
 *
 * The SDK used to write straight to `console` in a couple of dozen error
 * paths, which is unusable on structured-logging runtimes (Cloudflare Workers,
 * Datadog, …) and untestable without spying on `console`. Every internal
 * diagnostic now goes through a {@link RouteDockLogger}, so a consumer can
 * silence it, redirect it, or attach correlation fields.
 *
 * The default implementation is console-backed, so behaviour is unchanged when
 * no logger is supplied.
 */

/** Severity of a log line. */
export type RouteDockLogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * Structured context attached to a log line, typically `{ error: err }`. Sinks
 * receive the values unresolved, so a serialising sink must project non-JSON
 * values such as `Error` itself.
 */
export type RouteDockLogFields = Record<string, unknown>

/**
 * Consumer-supplied log sink.
 *
 * `fields` carries the structured payload (the error, the channel id, …) that
 * a bare string would drop at the boundary.
 */
export type RouteDockLogger = (
  level: RouteDockLogLevel,
  message: string,
  fields?: RouteDockLogFields,
) => void

/**
 * Default logger that forwards to the console at the matching level. Field
 * values are spread as additional console arguments so `console.error(msg, err)`
 * spies (and existing log shippers) keep seeing the raw error object.
 */
export function createConsoleLogger(): RouteDockLogger {
  return (level, message, fields) => {
    const values = fields ? Object.values(fields) : []
    if (values.length > 0) {
      console[level](message, ...values)
    } else {
      console[level](message)
    }
  }
}

/** Shared console-backed logger — the default when none is configured. */
export const consoleLogger: RouteDockLogger = createConsoleLogger()

/** Logger that discards every line. */
export const noopLogger: RouteDockLogger = () => {}

/** Resolve an optional logger to a concrete sink, defaulting to `fallback`. */
export function resolveLogger(
  logger: RouteDockLogger | undefined,
  fallback: RouteDockLogger = consoleLogger,
): RouteDockLogger {
  return logger ?? fallback
}
