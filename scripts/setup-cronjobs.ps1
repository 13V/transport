# ============================================================================
#  cron-job.org bulk setup  (PowerShell — no git/node/repo needed)
#  Creates every indexer cron job via the cron-job.org REST API.
#  Edit the two secrets below, then run the whole file (or paste into PowerShell).
# ============================================================================

$apiKey     = "PASTE_YOUR_CRONJOB_ORG_API_KEY"   # cron-job.org -> Settings -> API -> Display API key
$cronSecret = ""                                  # your Vercel CRON_SECRET bearer; leave "" if endpoints are open
$base       = "https://transport-topaz-eight.vercel.app"

# --- TLS 1.2 (needed on Windows PowerShell 5.1) ---
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Arr($a) { "[" + ($a -join ",") + "]" }            # int array -> JSON "[..]"
function Every($n) { 0..59 | Where-Object { $_ % $n -eq 0 } }  # "every N minutes"
$EVERY = @(-1)                                              # cron-job.org "every value" sentinel

# Job list — mirrors CRON_SETUP.md. m = minutes, h = hours (default every hour).
$jobs = @(
  @{ t="drain-shard-0";       p="/api/cron/seed-wallets?maxWallets=30&shard=0&shards=4"; m=$EVERY },
  @{ t="drain-shard-1";       p="/api/cron/seed-wallets?maxWallets=30&shard=1&shards=4"; m=$EVERY },
  @{ t="drain-shard-2";       p="/api/cron/seed-wallets?maxWallets=30&shard=2&shards=4"; m=$EVERY },
  @{ t="drain-shard-3";       p="/api/cron/seed-wallets?maxWallets=30&shard=3&shards=4"; m=$EVERY },
  @{ t="index";               p="/api/cron/index?maxTokens=30";                          m=(Every 2) },
  @{ t="graduations-shard-0"; p="/api/cron/graduations?maxCoins=8&shard=0&shards=3";      m=(Every 3) },
  @{ t="graduations-shard-1"; p="/api/cron/graduations?maxCoins=8&shard=1&shards=3";      m=(Every 3) },
  @{ t="graduations-shard-2"; p="/api/cron/graduations?maxCoins=8&shard=2&shards=3";      m=(Every 3) },
  @{ t="chain-discovery";     p="/api/cron/chain-discovery";                             m=@(0,30) },
  @{ t="track-links";         p="/api/cron/track-links";                                 m=@(0); h=@(0,6,12,18) },
  @{ t="alerts";              p="/api/cron/alerts";                                      m=(Every 5) },
  @{ t="growth-alert";        p="/api/cron/growth-alert";                                m=@(0) },
  @{ t="snapshot";            p="/api/cron/snapshot";                                    m=@(0) }
)

if ($apiKey -eq "PASTE_YOUR_CRONJOB_ORG_API_KEY") { Write-Host "Edit `$apiKey first." -ForegroundColor Red; return }
$headers = @{ Authorization = "Bearer $apiKey" }
if ($cronSecret -eq "") { Write-Host "! No CRON_SECRET set: jobs created without an auth header (only works if endpoints are open).`n" -ForegroundColor Yellow }

# Skip any job whose title already exists (safe to re-run).
$existing = @()
try { $existing = (Invoke-RestMethod -Method Get -Uri "https://api.cron-job.org/jobs" -Headers $headers).jobs.title } catch {}

$created = 0; $skipped = 0; $failed = 0
foreach ($j in $jobs) {
  if ($existing -contains $j.t) { Write-Host "= skip   $($j.t)" -ForegroundColor DarkGray; $skipped++; continue }
  $hours = if ($j.ContainsKey('h')) { $j.h } else { $EVERY }
  $hdr   = if ($cronSecret -ne "") { '"headers":{"Authorization":"Bearer ' + $cronSecret + '"}' } else { '"headers":{}' }
  $json  = '{"job":{"url":"' + "$base$($j.p)" + '","enabled":true,"title":"' + $j.t +
           '","saveResponses":true,"requestTimeout":30,"requestMethod":0,"schedule":{"timezone":"UTC","expiresAt":0,"hours":' +
           (Arr $hours) + ',"mdays":[-1],"minutes":' + (Arr $j.m) + ',"months":[-1],"wdays":[-1]},"extendedData":{' + $hdr + '}}}'
  try {
    $r = Invoke-RestMethod -Method Put -Uri "https://api.cron-job.org/jobs" -Headers $headers -ContentType "application/json" -Body $json
    Write-Host "+ create $($j.t)  (id $($r.jobId))" -ForegroundColor Green
    $created++
  } catch {
    Write-Host "x fail   $($j.t): $($_.Exception.Message)" -ForegroundColor Red
    $failed++
  }
  Start-Sleep -Seconds 5   # cron-job.org rate-limits rapid creates (429); pace them
}
Write-Host "`nDone. created=$created skipped=$skipped failed=$failed"
