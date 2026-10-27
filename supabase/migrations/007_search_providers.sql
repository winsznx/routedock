-- Fuzzy provider search over the trigram indexes created in 001.
--
-- PostgREST has no operator for pg_trgm's `%` or for similarity(), so the
-- indexes on providers(name) and providers(description) were maintained on
-- every write and never read. This function wraps the query so a client can
-- reach it with supabase.rpc('search_providers', ...).
--
-- SECURITY INVOKER keeps the existing public_read_providers RLS policy in
-- charge: the function reads exactly the rows the caller could already select.
--
-- Matching: `name % query` and `description % query` are the index-backed
-- trigram conditions, and `tags @> ARRAY[query]` is served by idx_providers_tags,
-- so the three can be combined in one bitmap-OR. The similarity threshold is
-- set on the function (0.15) because the default of 0.3 is too strict for a
-- multi-word capability query matched against a short provider name.
--
-- Ranking: the better of name and description similarity, plus 1 when the query
-- is exactly one of the provider's tags.

CREATE OR REPLACE FUNCTION search_providers(
  query         text,
  network       text    DEFAULT NULL,
  verified_only boolean DEFAULT true,
  max_results   int     DEFAULT 20
)
RETURNS SETOF providers
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
SET pg_trgm.similarity_threshold = 0.15
AS $$
  SELECT p.*
  FROM providers p
  WHERE (search_providers.network IS NULL OR p.network = search_providers.network)
    AND (NOT COALESCE(search_providers.verified_only, true) OR p.verified IS TRUE)
    AND (
      p.name % search_providers.query
      OR p.description % search_providers.query
      OR p.tags @> ARRAY[search_providers.query]
    )
  ORDER BY
    GREATEST(
      similarity(p.name, search_providers.query),
      similarity(COALESCE(p.description, ''), search_providers.query)
    )
    + CASE WHEN p.tags @> ARRAY[search_providers.query] THEN 1 ELSE 0 END DESC,
    p.registered_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(search_providers.max_results, 20), 50));
$$;

REVOKE ALL ON FUNCTION search_providers(text, text, boolean, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION search_providers(text, text, boolean, int) TO anon, authenticated;
