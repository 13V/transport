# Web Push Alerts

Browser/desktop push notifications so web users get real-time smart-money burst
alerts without Telegram. When a burst clears the quality gate + cooldown in the
Helius webhook (`app/api/helius/webhook/route.ts` → `runBurstAlerts`), the SAME
gated event that fires the Telegram alert ALSO fans out to every opted-in browser
subscriber via `lib/push.ts` (`sendWebPushToAll`).

## 1. Generate VAPID keys

VAPID keys authenticate your server to the browsers' push services. Generate a
pair once:

```bash
npx web-push generate-vapid-keys
```

This prints a `Public Key` and a `Private Key`.

## 2. Set environment variables (Vercel → Project → Settings → Environment Variables)

| Variable | Value | Notes |
| --- | --- | --- |
| `VAPID_PUBLIC_KEY` | the generated public key | server-side |
| `VAPID_PRIVATE_KEY` | the generated private key | server-only, **never expose** |
| `VAPID_SUBJECT` | `mailto:you@example.com` | a contact URI (mailto: or https:) |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | the SAME public key as `VAPID_PUBLIC_KEY` | exposed to the browser for `applicationServerKey` |

`NEXT_PUBLIC_VAPID_PUBLIC_KEY` must equal `VAPID_PUBLIC_KEY`. The client prefers
this public env; the `GET /api/push/subscribe` route also returns the key as a
fallback.

If any of the three server VAPID vars are missing, the fan-out is a silent no-op
and never throws. If `NEXT_PUBLIC_VAPID_PUBLIC_KEY` is missing, the **🔔 Alerts**
button hides itself.

## 3. Run the migration

Run `supabase/migrations/0006_push_subscriptions.sql` in the Supabase SQL editor
(idempotent). It creates the `push_subscriptions` table that stores each browser
subscription, keyed by endpoint.

## 4. Opt in

In the Live feed, users click the **🔔 Alerts** button in the header. This:

1. registers `/sw.js` (the push service worker),
2. requests Notification permission,
3. subscribes via `PushManager` using `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, and
4. POSTs the subscription + the device's stable owner id (the same
   `sm_owner_id` used by the watchlist) to `/api/push/subscribe`.

Clicking again unsubscribes (removes the subscription locally and server-side).

Dead subscriptions (browsers that return `404`/`410 Gone`) are pruned
automatically the next time a push is attempted, so the table self-heals.
