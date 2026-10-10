/*
 * OpenDeck service worker — Web Push delivery only.
 *
 * Kept dependency-free and tiny on purpose: it receives a push event,
 * surfaces the notification (with the recommendation's artwork as icon),
 * and focuses the app when the notification is clicked. Registered by
 * `internal/recommendationsClient.ts` when the user enables notifications.
 */

self.addEventListener("install", () => {
  // Nothing to cache — skip waiting so a new worker activates immediately.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = { title: "OpenDeck", body: "You have a new notification." };
  try {
    if (event.data) {
      const parsed = event.data.json();
      if (parsed && typeof parsed === "object") {
        payload = {
          title: typeof parsed.title === "string" ? parsed.title : payload.title,
          body: typeof parsed.body === "string" ? parsed.body : payload.body,
        };
        if (typeof parsed.icon === "string") payload.icon = parsed.icon;
      }
    }
  } catch {
    // Non-JSON push (e.g. from another sender) — fall back to defaults.
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: payload.icon || "/favicon.ico",
      badge: "/favicon.ico",
      data: { url: "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // Focus an already-open tab instead of opening a second one.
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow(targetUrl);
    }),
  );
});
