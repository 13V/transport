# Cost Notes — drain cron down-tuning

## (a) What changed and why

The every-minute `seed-wallets` drain crons (`drain-shard-0..3`) were the dominant
Helius spend. They are now largely redundant for VERIFIED wallets: the Helius
webhook ingests the verified smart set's new trades in real time, so there is no
need to re-drain those wallets every minute.

Change: in `scripts/setup-cronjobs.ps1` the four `drain-shard-*` jobs were moved
from `m=$EVERY` (every minute) to `m=(Every 5)` (every 5 minutes). This cuts
roughly 80% of drain Helius calls while still running a steady backlog pass.

The drain is NOT killed — it is still required for DISCOVERY/verification of
NEW/unverified wallets (which webhooks do not cover). Every-5-min keeps clearing
that backlog. All 4 shards, `maxWallets=30`, and `timeBudgetMs=24000` are
unchanged. Index / graduations / alerts / etc. were left as-is.

`vercel.json` was inspected and contains **no `crons` array** (only `buildCommand`
and `framework`), so there is no Vercel Cron / cron-job.org double-driving and the
file was left untouched. cron-job.org remains the sole driver.

## (b) The live cron-job.org jobs must be retuned too

`scripts/setup-cronjobs.ps1` is the source of truth for NEW setups, but it skips
any job whose title already exists (it only creates missing jobs — it does not
edit already-created jobs). The four `drain-shard-*` jobs already live on
cron-job.org will keep firing every minute until they are patched directly via the
API. Use the snippet below to retune them.

## (c) PowerShell snippet — PATCH the live drain jobs to every-5-min

Mirrors the patterns already in the setup script (Bearer auth, TLS 1.2,
`GET /jobs`, find by title). cron-job.org uses `PATCH /jobs/{id}` for updates.

```powershell
$apiKey = "PASTE_YOUR_CRONJOB_ORG_API_KEY"   # cron-job.org -> Settings -> API
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$headers = @{ Authorization = "Bearer $apiKey" }

# every-5-min: minutes [0,5,10,...,55]
$every5 = 0..59 | Where-Object { $_ % 5 -eq 0 }
$titles = @("drain-shard-0","drain-shard-1","drain-shard-2","drain-shard-3")

# GET all jobs, find the drain shards by title
$all = (Invoke-RestMethod -Method Get -Uri "https://api.cron-job.org/jobs" -Headers $headers).jobs
foreach ($t in $titles) {
  $job = $all | Where-Object { $_.title -eq $t } | Select-Object -First 1
  if (-not $job) { Write-Host "= not found  $t" -ForegroundColor DarkGray; continue }

  # PATCH only the schedule.minutes; leave the rest of the schedule intact
  $body = '{"job":{"schedule":{"minutes":[' + ($every5 -join ",") + ']}}}'
  try {
    Invoke-RestMethod -Method Patch -Uri "https://api.cron-job.org/jobs/$($job.jobId)" `
      -Headers $headers -ContentType "application/json" -Body $body | Out-Null
    Write-Host "~ retuned  $t (id $($job.jobId)) -> every 5 min" -ForegroundColor Green
  } catch {
    Write-Host "x fail     $t : $($_.Exception.Message)" -ForegroundColor Red
  }
  Start-Sleep -Seconds 2   # pace requests; cron-job.org rate-limits rapid calls
}
```

### Push/credit tradeoff

Each drain firing is a push of work (a batch of wallets through Helius) that costs
Helius credits. Every-5-min trades a small amount of verification latency for new
wallets (up to ~5 min vs ~1 min before) in exchange for ~80% fewer drain pushes
and the corresponding Helius credit savings. Because webhooks cover verified
wallets' new trades in real time, this latency tradeoff only affects the
discovery/verification path, not freshness of the already-verified smart set.
