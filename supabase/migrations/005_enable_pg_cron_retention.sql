-- ─── Enable pg_cron and schedule settlement retention ─────────
--
-- Replaces the scheduling step in 004_settlement_retention.sql, which
-- checked whether pg_cron was already installed without enabling the
-- extension first. On fresh Supabase projects pg_cron is available in
-- pg_available_extensions but not enabled by default, leaving
-- settlement-retention-cleanup unscheduled.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     AND EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    BEGIN
      CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'pg_cron is available but could not be enabled: %', SQLERRM;
    END;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'settlement-retention-cleanup',
      '0 3 * * *',
      'SELECT cleanup_stale_settlements(7)'
    );
  ELSE
    RAISE WARNING 'pg_cron is not installed, so settlement-retention-cleanup was not scheduled. Run SELECT cleanup_stale_settlements(7) daily from an external scheduler.';
  END IF;
END $$;
