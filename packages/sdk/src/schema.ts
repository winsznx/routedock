/**
 * Canonical RouteDock manifest JSON Schema (draft-07).
 *
 * Single source of truth for the manifest contract. Provider apps must import
 * this via the `@routedock/routedock/schema` subpath export rather than keeping
 * their own copy, so a field addition only has to be made in one place.
 *
 * @example
 * ```ts
 * import Ajv from 'ajv'
 * import schema from '@routedock/routedock/schema'
 *
 * const validate = new Ajv().compile(schema)
 * ```
 */
import routedockSchema from './schemas/routedock.schema.json'

export const schema: Record<string, unknown> = routedockSchema

export default schema
