-- Run after all migrations, as a privileged role able to SET ROLE to anon
-- and authenticated. Use a disposable database: the transaction rolls back
-- its fixture and the deliberately widened grants used to test the trigger.
\set ON_ERROR_STOP on
BEGIN;

-- #given the platform grants used for a fresh Supabase installation
-- #then both browser roles have effective SELECT-only view privileges
DO $$
DECLARE
  caller_name text;
  privilege_name text;
  table_name text;
BEGIN
  FOREACH caller_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF NOT has_table_privilege(caller_name, 'public.public_sessions', 'SELECT') THEN
      RAISE EXCEPTION '% cannot read public_sessions', caller_name;
    END IF;
    FOREACH privilege_name IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(caller_name, 'public.public_sessions', privilege_name) THEN
        RAISE EXCEPTION '% unexpectedly has % on public_sessions', caller_name, privilege_name;
      END IF;
    END LOOP;
    IF has_function_privilege(caller_name, 'public.cleanup_stale_settlements(integer)', 'EXECUTE') THEN
      RAISE EXCEPTION '% can execute cleanup_stale_settlements', caller_name;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.cleanup_stale_settlements(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role cannot run settlement retention';
  END IF;
  FOREACH table_name IN ARRAY ARRAY['sessions', 'tx_log', 'providers', 'settlements'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || table_name)::regclass) THEN
      RAISE EXCEPTION '% is not protected by RLS', table_name;
    END IF;
  END LOOP;
END;
$$;

INSERT INTO public.sessions (id, channel_id, payee, payer, cumulative_amount, last_signature, channel_contract)
VALUES ('07160000-0000-4000-8000-000000000001', 'rls-public-sessions-716',
        'test-payee', 'test-payer', 0.25, 'private-test-signature', 'private-test-contract');

-- #when queries execute under each browser role
-- #then SELECT returns the fixture without private columns and DML is denied
DO $$
DECLARE
  caller_name text;
  statement text;
  session_data jsonb;
BEGIN
  FOREACH caller_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    EXECUTE format('SET LOCAL ROLE %I', caller_name);
    IF current_user <> caller_name THEN
      RAISE EXCEPTION 'test did not switch to %', caller_name;
    END IF;
    SELECT to_jsonb(s) INTO session_data FROM public.public_sessions s
      WHERE id = '07160000-0000-4000-8000-000000000001';
    IF session_data IS NULL OR (session_data ->> 'cumulative_amount')::numeric IS DISTINCT FROM 0.25 THEN
      RAISE EXCEPTION '% cannot read the session fixture', caller_name;
    END IF;
    IF session_data ?| ARRAY['last_signature', 'channel_contract', 'last_reconcile_error'] THEN
      RAISE EXCEPTION 'public_sessions exposes private columns to %', caller_name;
    END IF;
    FOREACH statement IN ARRAY ARRAY[
      $query$UPDATE public.public_sessions SET status = 'closed' WHERE id = '07160000-0000-4000-8000-000000000001'$query$,
      $query$DELETE FROM public.public_sessions WHERE id = '07160000-0000-4000-8000-000000000001'$query$,
      $query$INSERT INTO public.public_sessions (id, channel_id, payee, payer) VALUES ('07160000-0000-4000-8000-000000000002', 'rls-public-sessions-insert-716', 'test-payee', 'test-payer')$query$
    ] LOOP
      BEGIN
        EXECUTE statement;
        RAISE EXCEPTION '% unexpectedly executed %', caller_name, statement;
      EXCEPTION WHEN insufficient_privilege THEN
        -- SQLSTATE 42501 is the expected denial; every other error fails.
        CONTINUE;
      END;
    END LOOP;
    RESET ROLE;
  END LOOP;
END;
$$;

-- #given a future blanket grant accidentally reopens view DML privileges
-- #then the view itself rejects writes, independently of the ACL
GRANT ALL ON public.public_sessions TO anon, authenticated;
DO $$
DECLARE
  caller_name text;
  statement text;
BEGIN
  FOREACH caller_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    EXECUTE format('SET LOCAL ROLE %I', caller_name);
    IF current_user <> caller_name THEN
      RAISE EXCEPTION 'test did not switch to %', caller_name;
    END IF;
    FOREACH statement IN ARRAY ARRAY[
      $query$UPDATE public.public_sessions SET status = 'closed' WHERE id = '07160000-0000-4000-8000-000000000001'$query$,
      $query$DELETE FROM public.public_sessions WHERE id = '07160000-0000-4000-8000-000000000001'$query$,
      $query$INSERT INTO public.public_sessions (id, channel_id, payee, payer) VALUES ('07160000-0000-4000-8000-000000000002', 'rls-public-sessions-insert-716', 'test-payee', 'test-payer')$query$
    ] LOOP
      BEGIN
        EXECUTE statement;
        RAISE EXCEPTION '% bypassed the view write guard with %', caller_name, statement;
      EXCEPTION WHEN insufficient_privilege THEN
        IF SQLERRM <> 'public_sessions is read-only' THEN
          RAISE EXCEPTION 'write was not rejected by the view guard: %', SQLERRM;
        END IF;
      END;
    END LOOP;
    RESET ROLE;
  END LOOP;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.sessions
                 WHERE id = '07160000-0000-4000-8000-000000000001'
                   AND status = 'open' AND cumulative_amount = 0.25
                   AND last_signature = 'private-test-signature'
                   AND channel_contract = 'private-test-contract') THEN
    RAISE EXCEPTION 'denied view writes changed the underlying session';
  END IF;
END;
$$;

ROLLBACK;
\echo 'public_sessions regression checks passed'
