-- ─── providers.verified is operator-only ─────────────────────
--
-- registerProvider used to write `verified = true` and `registered_at = now()`
-- on every isolate start / Durable Object construction, so an operator could
-- not un-verify a provider and `registered_at` carried no information.
--
-- This migration:
--   * splits registered_at into first_registered_at (set once, on insert) and
--     last_seen_at (refreshed on re-registration); registered_at stays as a
--     read-only alias of first_registered_at for existing readers.
--   * adds manifest_digest so an unchanged manifest can skip the write.
--   * guards `verified` with a trigger: only a member of routedock_admin (or a
--     superuser) may insert a verified row or change the flag. The service key
--     the provider apps use is not a member, so it cannot set it even by
--     mistake.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'routedock_admin') THEN
    CREATE ROLE routedock_admin NOLOGIN;
  END IF;
  -- Supabase's SQL editor / migrations run as postgres; keep operators able to
  -- flip the flag there.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    GRANT routedock_admin TO postgres;
  END IF;
END
$$;

ALTER TABLE providers RENAME COLUMN registered_at TO first_registered_at;

ALTER TABLE providers
  ADD COLUMN last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN manifest_digest TEXT;

-- Existing registered_at values were overwritten on every cold start, so the
-- best available "last seen" is that same value.
UPDATE providers SET last_seen_at = first_registered_at;

ALTER TABLE providers
  ADD COLUMN registered_at TIMESTAMPTZ GENERATED ALWAYS AS (first_registered_at) STORED;

CREATE OR REPLACE FUNCTION providers_guard_verified()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_has_role(current_user, 'routedock_admin', 'MEMBER') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.verified IS TRUE THEN
      RAISE EXCEPTION 'providers.verified can only be set by an admin role'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW.verified IS DISTINCT FROM OLD.verified THEN
    RAISE EXCEPTION 'providers.verified can only be changed by an admin role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER providers_guard_verified
  BEFORE INSERT OR UPDATE ON providers
  FOR EACH ROW
  EXECUTE FUNCTION providers_guard_verified();
