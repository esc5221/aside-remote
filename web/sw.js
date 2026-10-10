self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let notification;
  try { notification = event.data?.json()?.notification; } catch { }
  const target = conversationUrl(notification?.navigate);
  event.waitUntil(self.registration.showNotification(notification?.title || 'Aside', {
    body: notification?.body || 'Your response is ready. Tap to open the conversation.',
    icon: '/icons/icon-192.png',
    tag: notification?.tag,
    data: { url: target.href },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = conversationUrl(event.notification.data?.url);
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if (new URL(client.url).origin !== target.origin) continue;
      const destination = await client.navigate(target.href);
      if (destination) { await destination.focus(); return; }
    }
    await self.clients.openWindow(target.href);
  })());
});

function conversationUrl(value) {
  try {
    const url = new URL(value, self.location.origin);
    if (url.origin === self.location.origin && /^\/c\/[A-Za-z0-9]{12,32}$/.test(url.pathname)) return url;
  } catch { }
  return new URL('/', self.location.origin);
}
