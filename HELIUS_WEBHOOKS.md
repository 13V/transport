# Helius Webhooks — real-time smart-wallet swaps

## What it does

Instead of polling Helius on a 1–3 minute cron, this pipeline lets Helius **push**
smart-wallet swaps to us the moment they land on-chain:

- **`POST /api/helius/webhook`** — the receiver. Helius calls it whenever one of the
  watched wallets makes a swap; the trade is written straight into the `trades` table.
- **`GET /api/cron/sync-webhook`** — the registrar. It self-registers the Helius
  webhook (creating it on first run) and keeps the webhook's watched address list in
  sync with the current smart set, so newly-promoted wallets start streaming and
  dropped wallets stop.

Result: the Live feed and alerts update within seconds of a swap, and Helius spend
drops because we receive pushes instead of repeatedly polling (push instead of poll).

## Required environment variables (Vercel)

| Var | Status | Purpose |
| --- | --- | --- |
| `HELIUS_API_KEY` | already set | Authenticates calls to the Helius API (create/update the webhook). |
| `HELIUS_WEBHOOK_SECRET` | **new — add this** | A random shared secret. `sync-webhook` registers it as the webhook's `authHeader`; the receiver verifies the incoming `Authorization` header against it. |

`HELIUS_WEBHOOK_SECRET` is what keeps the receiver safe: the receiver **fails closed**
if the secret is missing or the incoming header doesn't match, so nobody can POST fake
trades into the `trades` table.

Generate a strong random value:

```powershell
# PowerShell
[Convert]::ToBase64String((1..32 | %{Get-Random -Max 256}))
```

```bash
# macOS / Linux
openssl rand -base64 32
```

## Setup

### 1. Set the env vars and redeploy

In Vercel → Project → Settings → Environment Variables, add `HELIUS_WEBHOOK_SECRET`
(and confirm `HELIUS_API_KEY` is present). Redeploy so the new value is live.

### 2. Trigger the first registration

Hit the sync endpoint once to create the webhook on Helius:

```powershell
Invoke-RestMethod -Uri "https://transport-topaz-eight.vercel.app/api/cron/sync-webhook"
```

If `CRON_SECRET` is set in Vercel, add the bearer header:

```powershell
Invoke-RestMethod -Uri "https://transport-topaz-eight.vercel.app/api/cron/sync-webhook" -Headers @{ Authorization = "Bearer <secret>" }
```

### 3. Add the recurring cron-job.org job

The address list must stay current as the smart set changes, so run `sync-webhook`
every 30 minutes. This job is **already included** in `scripts/setup-cronjobs.ps1` —
re-run that script and it will be created (existing jobs are skipped). To add it
manually on cron-job.org, create a job with:

- **URL:** `https://transport-topaz-eight.vercel.app/api/cron/sync-webhook`
- **Schedule:** every 30 minutes (minutes `0,30`)
- **Method:** GET
- **Auth header:** add `Authorization: Bearer <CRON_SECRET>` only if `CRON_SECRET` is set in Vercel; otherwise none.

## Verify

- **Sync response** returns `{ action, webhookId, addressCount }` — `action` shows
  whether it created or updated the webhook, and `addressCount` is the number of
  watched wallets.
- **Helius dashboard** → Dashboard → Webhooks lists the webhook pointing at
  `/api/helius/webhook`.
- **Live feed** shows new bursts appearing within seconds of a smart-wallet swap.
