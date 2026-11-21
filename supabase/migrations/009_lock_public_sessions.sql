-- ─── Read-only public session metadata ────────────────────────
-- Supabase's default privileges grant ALL on new public tables and views.
-- The owner-rights public_sessions view is automatically updatable, so
-- granting SELECT alone never removed its inherited write privileges.
-- Keep owner-rights reads: security_invoker would apply sessions RLS to anon
-- and hide the dashboard's metadata. Revoke writes and reject DML in an
-- INSTEAD OF row trigger so a future blanket grant cannot reopen them.
-- Unlike DO INSTEAD NOTHING rules, the trigger reports a permission error
-- instead of allowing a caller to mistake a discarded write for success.

REVOKE ALL ON public.public_sessions FROM anon, authenticated, PUBLIC;
GRANT SELECT ON public.public_sessions TO anon, authenticated;

CREATE FUNCTION public.reject_public_sessions_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'public_sessions is read-only' USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER public_sessions_read_only
  INSTEAD OF INSERT OR UPDATE OR DELETE ON public.public_sessions
  FOR EACH ROW EXECUTE FUNCTION public.reject_public_sessions_write();

REVOKE EXECUTE ON FUNCTION public.reject_public_sessions_write()
  FROM anon, authenticated, PUBLIC;

-- sessions, tx_log, providers and settlements already enable RLS. Their
-- policies restrict base-table access despite Supabase's default grants;
-- this owner-rights view needed its own write protection. Retention is an
-- administrative operation, so remove the function's default PUBLIC grant
-- while preserving the service role and the owner's scheduled cleanup.
REVOKE EXECUTE ON FUNCTION public.cleanup_stale_settlements(integer)
  FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.cleanup_stale_settlements(integer) TO service_role;
