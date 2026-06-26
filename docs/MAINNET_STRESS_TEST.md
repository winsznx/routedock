\# Mainnet Stress Test Report



\## Objective



Validate RouteDock production readiness through concurrent simulated sessions on Stellar testnet.



\## Test Configuration



| Metric | Value |

|----------|--------|

| Concurrent agents | 50 |

| Payments/session | 10 |

| Network | Stellar Testnet |

| Dispute simulation | Enabled |

| Ramp-up | Random 0–3s |

| Channel type | MPP Session |



\## Metrics Captured



\- Channel open latency

\- Payment latency

\- Channel close latency

\- p50 latency

\- p95 latency

\- p99 latency

\- Failure count

\- Dispute execution count



\## Execution



Run:



```bash

pnpm stress:test

```



Results are automatically stored:



```bash

docs/stress-results/run-<timestamp>.json

```



\## Example Output



```json

{

&#x20; "sessions":50,

&#x20; "open":{

&#x20;   "p50":0,

&#x20;   "p95":0,

&#x20;   "p99":0

&#x20; },

&#x20; "payment":{

&#x20;   "p50":0,

&#x20;   "p95":0,

&#x20;   "p99":0

&#x20; },

&#x20; "close":{

&#x20;   "p50":0,

&#x20;   "p95":0,

&#x20;   "p99":0

&#x20; },

&#x20; "disputes":5,

&#x20; "failures":0

}

```



\## Production Readiness Criteria



\- p95 open latency within acceptable operational limits

\- p95 payment latency stable under load

\- p95 close latency stable under load

\- zero unexpected failures

\- dispute handling executes successfully

