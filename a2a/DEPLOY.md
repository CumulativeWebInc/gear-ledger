# $0 Deploy Path — CWI A2A Gateway

Goal: one public HTTPS URL serving the A2A JSON-RPC endpoint, for $0/month.
No secrets, no credentials, no wallet: the gateway is auth-free by design
(open intake, rate-limited at 60 req/min/IP).

**Status: NOT YET LIVE.** The static Agent Cards point at the planned endpoint
below and carry `deployment.status: "planned"`. Flip them to live only after
this runbook is executed and verified end to end.

## Primary path: Render free tier

Render's free web-service tier ($0, 750 hrs/month; sleeps on idle — fine for a
discovery/intake endpoint).

1. **Render account** (free) → Dashboard → **New → Web Service**.
2. **Connect GitHub** → select `CumulativeWebInc/gear-ledger` (public repo,
   no private access needed).
3. Settings:
   - **Root Directory:** `a2a`
   - **Build Command:** *(leave empty — zero dependencies)*
   - **Start Command:** `node server.js`
   - **Environment:** Render injects `PORT` automatically; the server reads it.
     Optional: `A2A_DATA_DIR=./data` (default).
4. **Deploy.** Note the public URL, expected:
   `https://cwi-a2a.onrender.com/` (name may differ — use the real one).
5. **Verify live:**
   ```bash
   curl -s https://<your-url>/health
   curl -s https://<your-url>/.well-known/agent-card.json | head -c 300
   curl -s https://<your-url>/ -H 'content-type: application/json' -d \
     '{"jsonrpc":"2.0","id":1,"method":"message/send",
       "params":{"message":{"role":"user","parts":[{"kind":"text","text":"A2A go-live probe."}]}}}'
   ```
   Expect: health ok, fleet card, and a task with `status.state: "completed"`
   plus a `queue-receipt.json` artifact.
6. **Flip the cards to live:** regenerate with the real URL and push:
   ```bash
   node a2a/tools/build-cards.js --agents a2a/agents.json \
     --out /tmp/a2a-cards --endpoint https://<your-url>/
   # then set deployment.status/live in each card (script flag --live),
   # commit the 10 cards + index.json to CumulativeWebInc/cwi-learn
   # under .well-known/agents/<HANDLE>/agent-card.json
   ```
   (Until a `--live` flag exists, flip the two `deployment` fields by hand —
   two fields × 11 files, then verify via the Contents API.)
7. **Record the go-live date** at the bottom of this file. The 3-week kill-rule
   clock starts then.

## Honest limitations of the $0 path

- **Ephemeral disk on free tier:** `data/` (tasks.json, requests.log,
  inbox queues) does not survive restarts/sleeps. The measurement still works:
  every request is also in Render's log stream — export/screenshot the weekly
  external-request count. For durable queues, the options are Render's paid
  disk or a periodic backup job pushing `data/` to a private repo (script
  TBD — do not store secrets to do it).
- **Cold starts:** free tier sleeps after inactivity; first request after idle
  takes ~30–60s. A2A clients should retry with a timeout ≥ 90s.
- **No auth:** by design. Abuse lever is the 60 req/min/IP rate limit plus
  Render's own protections. If abused: add an allowlist or API key (code
  change, still $0).

## Alternatives (also $0, not primary)

- **Fly.io** free allowance: `fly launch` in `a2a/`, similar env story.
- **Oracle Cloud Always Free** VM: full control, more setup.
- **Cloudflare Workers:** would require porting server.js off `node:http`
  (Workers runtime) — noted, not recommended for v1.

## Go-live log

| Date (UTC) | Event | URL | Verified by |
|---|---|---|---|
| — | not yet live | planned: `https://cwi-a2a.onrender.com/` | — |
