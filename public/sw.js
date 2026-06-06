/*
 * SERVICE WORKER — web-push notifications only.
 *
 * No precaching, no fetch interception. Its sole job is to render push payloads
 * delivered by lib/push.ts (sendWebPushToAll) and to focus/open the target URL
 * when the user clicks a notification. Registered by components/LiveFeed.tsx
 * when the user opts in via the 🔔 Alerts button.
 *
 * Payload shape (JSON): { title, body, url }
 */

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = {};
  }

  const title = payload.title || 'Smart-money alert';
  const options = {
    body: payload.body || '',
    icon: '/icon.png',
    badge: '/icon.png',
    data: { url: payload.url || '/' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // Focus an existing tab if one is open; otherwise open a new one.
        for (const client of clientList) {
          if ('focus' in client) {
            client.focus();
            if ('navigate' in client) {
              try {
                client.navigate(target);
              } catch (e) {
                /* ignore navigation errors */
              }
            }
            return;
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(target);
      })
  );
});
