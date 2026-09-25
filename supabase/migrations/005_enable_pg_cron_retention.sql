-- ─── Enable and schedule settlement retention ─────────────────
-- Migration 004 deliberately creates the cleanup function without assuming
-- that pg_cron is installed. Supabase projects normally make the extension
-- available, while local/self-hosted projects may not.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     AND EXISTS (
       SELECT 1
       FROM pg_available_extensions
       WHERE name = 'pg_cron'
     ) THEN
    BEGIN
      CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING
        'pg_cron is available but could not be enabled; configure an external cleanup scheduler: %',
        SQLERRM;
    END;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'settlement-retention-cleanup',
      '0 3 * * *',
      'SELECT cleanup_stale_settlements(7)'
    );
  ELSE
    RAISE WARNING
      'pg_cron is not installed, so settlement-retention-cleanup was not scheduled. '
      'Run SELECT cleanup_stale_settlements(7) daily from an external scheduler.';
  END IF;
END $$;
