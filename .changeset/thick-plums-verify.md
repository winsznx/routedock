---
"@routedock/routedock": patch
---

Fix mpp-session provider adapters (Hono and Express) committing an unverified Payment header's signature and payer to session state before mppx verified the credential. Voucher state is now written only from a credential onVerifiedCredential has confirmed mppx actually verified, so a crafted, unverified header can no longer poison the signature or payer a later close or orphan-recovery uses.

Also: the verified voucher record now survives handler-instance eviction (e.g. a Cloudflare Durable Object recycling) by reloading it from the session store before it's needed, and the Express adapter no longer flags a healthy session "orphaned" after every single successfully completed voucher request — it only does so for a connection that actually drops before its response finishes.
