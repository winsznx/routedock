# RouteDock Demo Script (2:45)

## Setup (before recording)

**Terminal layout:**
- Left half: terminal running `node agent/dist/index.js` — agent logs with full timestamps
- Right half: browser at `https://routedock-web.vercel.app/dashboard` — Supabase Realtime live

**Pre-check:**
- Providers running and healthy: `curl https://provider-a.railway.app/health` + `curl https://provider-b.railway.app/health`
- Agent funded with XLM + USDC on testnet
- Dashboard open, showing at least the empty session table (Realtime subscribed)
- Agent built: `pnpm --filter @routedock/agent build`

---

## 0:00–0:20 — Problem hook

**Narrate (voice-over or caption):**
> "Three payment modes on Stellar. Three separate SDKs. Zero discovery for MPP endpoints. Agents have to hardcode every URL and manually wire each protocol. RouteDock solves this."

**On screen:** Show the mermaid architecture diagram from `README.md` or a static slide.

---

## 0:20–0:35 — Architecture

**Show:** The mermaid diagram rendered (or screenshot from README).

**Narrate:**
> "One manifest. One client. The mode router reads `routedock.json`, picks x402, MPP charge, or MPP session — the agent never makes that decision."

**Highlight in terminal:** Show the 3-line SDK usage code:
```ts
const client = new RouteDockClient({ wallet, network: 'testnet' })
const result = await client.pay('https://provider.railway.app/price')
// result.mode → 'x402' | 'mpp-charge' | 'mpp-session'
```

---

## 0:35–0:55 — x402 query (Round 1)

**Run in terminal:**
```bash
node agent/dist/index.js
```

**Watch for these log lines** (highlight them):
```
[INIT] Agent address: GCJD57...
[INIT] Starting USDC balance: 0.50

[ROUND 1 — x402]
→ Fetching manifest from https://provider-a.railway.app/.well-known/routedock.json
→ Selected mode: x402
→ Received 402, signing Soroban auth entry...
→ Settlement complete
✓ mode: x402 | txHash: [HASH-1] | amount: 0.001 USDC | data: { price: 0.099... }
```

**Pause, switch to browser:** Show Stellar Expert explorer with the USDC transfer.
URL: `https://stellar.expert/explorer/testnet/tx/[HASH-1]`

---

## 0:55–1:10 — MPP charge (Round 2)

**Watch for:**
```
[ROUND 2 — mpp-charge]
→ Selected mode: mpp-charge (natural selection — lower fee)
→ Charge intent submitted
✓ mode: mpp-charge | txHash: [HASH-2] | amount: 0.0008 USDC | data: { price: 0.099... }
```

**Dashboard right panel:** Tx Feed shows two new entries slide in at the top. Point this out.

---

## 1:10–1:40 — MPP session streaming (Round 3 — THE MONEY MOMENT)

**Watch for:**
```
[ROUND 3 — mpp-session]
→ Opening channel on contract C...
✓ Channel open | txHash: [HASH-3]

→ Voucher 10 | cumulative: $0.001
→ Voucher 20 | cumulative: $0.002
→ Voucher 30 | cumulative: $0.003
→ Voucher 40 | cumulative: $0.004
→ Voucher 50 | cumulative: $0.005
```

**Dashboard left panel:** Watch the "Vouchers Accumulated" metric card tick up in real time. The session row appears with `status: open` and a pulsing green dot.

At voucher 50, watch for:
```
→ Consumed 50 events. Closing session...
✓ Settlement | txHash: [HASH-4] | total: $0.005 for 50 interactions
```

**Pause — this is the key line to highlight:**

> "50 interactions. 2 on-chain transactions."

**Dashboard:** Session row flips from `open` → `closed`. Voucher Chart updates.

**Switch to browser:** Stellar Expert for `[HASH-3]` (channel open) and `[HASH-4]` (settlement).

---

## 1:40–2:05 — Policy rejection (Round 4)

**Watch for:**
```
[ROUND 4 — policy rejection]
→ Attempting payment... (spent 0.0018 so far, cap 0.002)
→ New spend would be 0.0028 > daily cap 0.002
✗ REJECTED: local_daily_cap_exceeded
  Nothing broadcast to Stellar.
```

**Narrate:**
> "The agent vault's daily cap is 0.002 USDC. We've spent 0.0018. The next attempt is rejected before anything hits the chain."

**Show Stellar Expert:** Search the agent address — confirm no transaction was broadcast for this round.

---

## 2:05–2:30 — SDK install moment

**Narrate:**
```bash
npm install @routedock/sdk
```

Show the provider middleware code (from README or terminal):
```ts
app.use('/price', routedock({ modes: ['x402', 'mpp-charge'], ... }))
```

> "Provider adds one middleware. Agent adds one client. That's the integration."

---

## 2:30–2:45 — Close

**Show:** Dashboard with all 4 tx hashes visible in the Tx Feed. Session row closed.

**Narrate:**
> "x402, MPP charge, MPP session — unified. Open source, deployed, running on Stellar testnet now."

**On screen:** `npm install @routedock/sdk` + npm badge + GitHub URL.

---

## Recording Notes

- Use a font size ≥ 16pt in terminal for legibility
- Keep browser zoom at 100% on dashboard
- Do not fast-forward — the real-time updates are the product
- If the session takes longer than expected at voucher 50, that's fine — keep the footage
- Export at 1080p minimum
