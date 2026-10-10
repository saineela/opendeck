/**
 * Song recommendations between registered OpenDeck accounts, plus Web Push
 * subscription management.
 *
 * Every recommendations call accepts the session cookie or a bearer API key
 * (the server uses `requireAuth`), so a future mobile client can reuse this
 * module against the same endpoints unchanged.
 */

export interface Recommendation {
  id: string;
  senderUserId: string;
  senderName: string;
  recipientUserId: string;
  videoId: string;
  title: string;
  artist: string;
  album: string | null;
  artworkUrl: string | null;
  durationSeconds: number | null;
  note: string | null;
  createdAt: number;
  readAt: number | null;
}

export interface DirectoryEntry {
  id: string;
  name: string;
  picture: string | null;
}

export interface SendRecommendationInput {
  recipientId: string;
  videoId: string;
  title: string;
  artist?: string;
  album?: string;
  artworkUrl?: string;
  durationSeconds?: number;
  note?: string;
}

async function requestJson<T>(pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/recommendations${pathname}`, {
    credentials: "same-origin",
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) {
    throw new Error(payload?.error ?? `Recommendation request failed with HTTP ${response.status}.`);
  }
  return payload as unknown as T;
}

export async function fetchDirectory(): Promise<DirectoryEntry[]> {
  const payload = await requestJson<{ users: DirectoryEntry[] }>("/directory");
  return payload.users;
}

export async function fetchInbox(options: { unreadOnly?: boolean } = {}): Promise<{
  recommendations: Recommendation[];
  unreadCount: number;
}> {
  const query = options.unreadOnly ? "?unread=1" : "";
  return requestJson<{ recommendations: Recommendation[]; unreadCount: number }>(query);
}

export async function fetchSent(): Promise<Recommendation[]> {
  const payload = await requestJson<{ recommendations: Recommendation[] }>("/sent");
  return payload.recommendations;
}

export async function sendRecommendation(input: SendRecommendationInput): Promise<Recommendation> {
  const payload = await requestJson<{ recommendation: Recommendation }>("/", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return payload.recommendation;
}

export async function markRecommendationRead(id: string): Promise<void> {
  await requestJson<{ ok: true }>(`/${encodeURIComponent(id)}/read`, { method: "POST" });
}

export async function deleteRecommendation(id: string): Promise<void> {
  await requestJson<{ ok: true }>(`/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// --- Web Push ---------------------------------------------------------------

export function pushSupported(): boolean {
  return typeof navigator !== "undefined"
    && "serviceWorker" in navigator
    && "PushManager" in window
    && typeof Notification !== "undefined";
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const base64Url = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64Url);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes;
}

async function pushRequestJson<T>(pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/push${pathname}`, {
    credentials: "same-origin",
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) {
    throw new Error(payload?.error ?? `Push request failed with HTTP ${response.status}.`);
  }
  return payload as unknown as T;
}

export async function getVapidPublicKey(): Promise<string> {
  const payload = await pushRequestJson<{ publicKey: string }>("/vapid-public-key");
  return payload.publicKey;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register("/sw.js");
}

/**
 * Subscribes this device for push and registers it server-side.
 * Returns the active subscription, or null when permission was denied.
 */
export async function enablePushNotifications(): Promise<PushSubscription | null> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return null;

  const registration = await registerServiceWorker();
  await navigator.serviceWorker.ready;
  const publicKey = await getVapidPublicKey();
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  await pushRequestJson("/subscribe", {
    method: "POST",
    body: JSON.stringify(subscription.toJSON()),
  });
  return subscription;
}

/** Unsubscribes this device and removes it server-side. Safe to call anytime. */
export async function disablePushNotifications(): Promise<void> {
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  await pushRequestJson("/unsubscribe", {
    method: "POST",
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });
  await subscription.unsubscribe();
}

/** True when this device is currently subscribed for push. */
export async function pushNotificationsEnabled(): Promise<boolean> {
  if (!pushSupported()) return false;
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  return Boolean(subscription);
}
