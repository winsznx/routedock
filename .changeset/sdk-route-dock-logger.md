---
"@routedock/routedock": minor
---

Route every SDK diagnostic through an injectable `RouteDockLogger` instead of writing straight to `console`. Provider adapters (Express, Fastify, Hono) accept a `logger` option, and the client reads it too: `RouteDockClientConfig.logger` now reaches `RetryPolicy`, `MppSessionClient`, `NulthClient`, `InMemorySeenTxStore`, `InMemorySpendStore`, and `runStartupReconciliation`. `createConsoleLogger`, `consoleLogger`, `noopLogger`, and `resolveLogger` are exported, and the default remains console-backed so behaviour is unchanged when no logger is supplied.

**Breaking (runtime, type-compatible):** `RouteDockLogger` changes from `(message: string) => void` to `(level, message, fields?) => void`. An existing `(message) => …` callback still type-checks — TypeScript accepts a shorter parameter list — but it now receives the level as its first argument, so its log line silently changes. Move the message to the second parameter (or use the new signature) when upgrading. `RouteDockLogLevel` and `RouteDockLogFields` are exported alongside it.
