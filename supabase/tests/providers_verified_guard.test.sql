-- pgTAP test for 009_providers_verified_guard.sql. Run with `supabase test db`.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(10);

-- The provider apps connect with the service key, i.e. as service_role.
GRANT ALL ON providers TO service_role;

-- Seed (as the migration/admin user): an old row, unverified.
INSERT INTO providers (name, base_url, modes, payee, manifest, first_registered_at, last_seen_at)
VALUES ('p', 'https://p.test', ARRAY['x402'], 'GPAYEE', '{}'::jsonb,
        '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z');

-- 1-2: the admin role can flip the flag both ways.
SELECT lives_ok(
  $$UPDATE providers SET verified = true WHERE base_url = 'https://p.test'$$,
  'admin can set verified = true');
SELECT lives_ok(
  $$UPDATE providers SET verified = false WHERE base_url = 'https://p.test'$$,
  'admin can set verified = false');

SET LOCAL ROLE service_role;

-- 3: re-registration the way registerProvider does it (no verified in the payload).
SELECT lives_ok(
  $$INSERT INTO providers (name, base_url, modes, payee, manifest, manifest_digest, last_seen_at)
    VALUES ('p2', 'https://p.test', ARRAY['x402'], 'GPAYEE', '{}'::jsonb, 'abc', '2030-01-01T00:00:00Z')
    ON CONFLICT (base_url) DO UPDATE SET
      name = EXCLUDED.name, manifest_digest = EXCLUDED.manifest_digest,
      last_seen_at = EXCLUDED.last_seen_at$$,
  'service role can re-register without touching verified');

-- 4-5: the service role cannot set verified, by update or by insert.
SELECT throws_ok(
  $$UPDATE providers SET verified = true WHERE base_url = 'https://p.test'$$,
  '42501', NULL, 'service role cannot set verified via update');
SELECT throws_ok(
  $$INSERT INTO providers (name, base_url, modes, payee, manifest, verified)
    VALUES ('x', 'https://x.test', ARRAY['x402'], 'GPAYEE', '{}'::jsonb, true)$$,
  '42501', NULL, 'service role cannot insert a verified row');

-- 6: a plain insert takes the column default.
INSERT INTO providers (name, base_url, modes, payee, manifest)
VALUES ('y', 'https://y.test', ARRAY['x402'], 'GPAYEE', '{}'::jsonb);

RESET ROLE;

SELECT is((SELECT verified FROM providers WHERE base_url = 'https://p.test'), false,
  'verified stays false after re-registration');
SELECT is((SELECT verified FROM providers WHERE base_url = 'https://y.test'), false,
  'new rows default to unverified');
SELECT is((SELECT first_registered_at FROM providers WHERE base_url = 'https://p.test'),
  '2020-01-01T00:00:00Z'::timestamptz, 'first_registered_at does not change on re-registration');
SELECT is((SELECT last_seen_at FROM providers WHERE base_url = 'https://p.test'),
  '2030-01-01T00:00:00Z'::timestamptz, 'last_seen_at is updated on re-registration');
SELECT is((SELECT registered_at FROM providers WHERE base_url = 'https://p.test'),
  '2020-01-01T00:00:00Z'::timestamptz, 'registered_at aliases first_registered_at');

SELECT * FROM finish();
ROLLBACK;
