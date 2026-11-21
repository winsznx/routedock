-- CI-only bootstrap for an empty, disposable PostgreSQL database.
-- Apply the migrations as a non-superuser owner with Supabase's default
-- table/view grants; testing with PostgreSQL's narrower defaults hides #716.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE routedock_migrations NOLOGIN;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT USAGE, CREATE ON SCHEMA public TO routedock_migrations;
ALTER DEFAULT PRIVILEGES FOR ROLE routedock_migrations IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE routedock_migrations IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE routedock_migrations IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

-- Provision the extension as the bootstrap administrator. The schema
-- migrations and publication are owned by the ordinary migration role.
CREATE EXTENSION pg_trgm;
DO $$
BEGIN
  EXECUTE format('GRANT CREATE ON DATABASE %I TO routedock_migrations', current_database());
END;
$$;
SET ROLE routedock_migrations;
CREATE PUBLICATION supabase_realtime;
RESET ROLE;
