// Minimal Web Push sender for the DSU demo server (RFC 8291 aes128gcm + RFC 8292 VAPID).
// No dependencies: Node crypto only. Subscriptions live in memory, grouped by a demo "room"
// (one classroom code per browser), and expire on their own.
import { createECDH, createPrivateKey, hkdfSync, randomBytes, createCipheriv, sign } from "node:crypto";

const b64url = buffer => Buffer.from(buffer).toString("base64url");
const fromB64url = text => Buffer.from(String(text ?? ""), "base64url");

// Push services browsers actually use. Anything else is refused, so the server cannot be
// pointed at arbitrary hosts.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.apple\.com$/, /^android\.googleapis\.com$/];
export function isAllowedEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && PUSH_HOSTS.some(pattern => pattern.test(url.hostname));
  } catch {
    return false;
  }
}

export function createVapidKeys({ publicKey, privateKey } = {}) {
  let pub = publicKey ? fromB64url(publicKey) : null;
  let priv = privateKey ? fromB64url(privateKey) : null;
  if (!pub || pub.length !== 65 || !priv || priv.length !== 32) {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    pub = ecdh.getPublicKey();
    priv = ecdh.getPrivateKey();
  }
  const key = createPrivateKey({
    format: "jwk",
    key: { kty: "EC", crv: "P-256", d: b64url(priv), x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)) },
  });
  return { publicKey: b64url(pub), key };
}

export function vapidAuthorization(endpoint, vapid, subject, now = Date.now()) {
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64url(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key: vapid.key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${vapid.publicKey}`;
}

export function encryptPayload(subscriptionKeys, plaintext, { salt = randomBytes(16), serverKeys = null } = {}) {
  const uaPublic = fromB64url(subscriptionKeys?.p256dh);
  const authSecret = fromB64url(subscriptionKeys?.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error("invalid subscription keys");
  const ecdh = serverKeys ?? createECDH("prime256v1");
  if (!serverKeys) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

const ROOM_PATTERN = /^[A-Z2-9]{6,10}$/;
const MAX_ROOMS = 2000;
const MAX_SUBS_PER_ROOM = 30;
const ROOM_TTL_MS = 14 * 24 * 3600_000;

export function createPushHub({ vapid = createVapidKeys(), subject = "https://stellar-connect.ax.dongseo.ac.kr", fetchImpl = globalThis.fetch } = {}) {
  const rooms = new Map();
  const prune = () => {
    const now = Date.now();
    for (const [room, entry] of rooms) if (now - entry.touched > ROOM_TTL_MS) rooms.delete(room);
  };
  return {
    publicKey: vapid.publicKey,
    validRoom: room => ROOM_PATTERN.test(String(room ?? "")),
    subscribe(room, subscription) {
      if (!ROOM_PATTERN.test(String(room ?? ""))) return { ok: false, error: "invalid-room" };
      if (!isAllowedEndpoint(subscription?.endpoint)) return { ok: false, error: "invalid-endpoint" };
      if (fromB64url(subscription?.keys?.p256dh).length !== 65 || fromB64url(subscription?.keys?.auth).length < 16) return { ok: false, error: "invalid-keys" };
      prune();
      let entry = rooms.get(room);
      if (!entry) {
        if (rooms.size >= MAX_ROOMS) return { ok: false, error: "full" };
        entry = { subs: new Map(), touched: Date.now() };
        rooms.set(room, entry);
      }
      entry.touched = Date.now();
      entry.subs.delete(subscription.endpoint);
      entry.subs.set(subscription.endpoint, { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } });
      while (entry.subs.size > MAX_SUBS_PER_ROOM) entry.subs.delete(entry.subs.keys().next().value);
      return { ok: true, devices: entry.subs.size };
    },
    unsubscribe(room, endpoint) {
      rooms.get(room)?.subs.delete(endpoint);
      return { ok: true };
    },
    devices: room => rooms.get(room)?.subs.size ?? 0,
    async send(room, message) {
      const entry = rooms.get(room);
      if (!entry || !entry.subs.size) return { sent: 0, failed: 0, devices: 0 };
      entry.touched = Date.now();
      const payload = JSON.stringify(message);
      let sent = 0;
      let failed = 0;
      await Promise.all([...entry.subs.values()].map(async subscription => {
        try {
          const response = await fetchImpl(subscription.endpoint, {
            method: "POST",
            headers: {
              authorization: vapidAuthorization(subscription.endpoint, vapid, subject),
              "content-encoding": "aes128gcm",
              "content-type": "application/octet-stream",
              ttl: "86400",
              urgency: "high",
            },
            body: encryptPayload(subscription.keys, payload),
            signal: AbortSignal.timeout(10_000),
          });
          if (response.status === 404 || response.status === 410) entry.subs.delete(subscription.endpoint);
          if (response.ok) sent += 1; else { failed += 1; console.warn(`[push] ${new URL(subscription.endpoint).hostname} -> ${response.status}`); }
        } catch (error) {
          failed += 1;
          console.warn(`[push] send failed: ${error.message}`);
        }
      }));
      return { sent, failed, devices: entry.subs.size };
    },
  };
}

// Service worker served at /sw.js. Shows the notification, keeps a copy for the app to import
// into the in-browser demo store, and opens the app on click.
export const SERVICE_WORKER = `
const PENDING = "/__stellar-push/pending";
async function remember(message) {
  const cache = await caches.open("stellar-push");
  const previous = await cache.match(PENDING).then(r => r ? r.json() : []).catch(() => []);
  const list = [...previous.filter(item => item.id !== message.id), message].slice(-20);
  await cache.put(PENDING, new Response(JSON.stringify(list), { headers: { "content-type": "application/json" } }));
}
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("push", event => {
  let message = {};
  try { message = event.data ? event.data.json() : {}; } catch { message = { title: "STELLAR CONNECT", body: event.data ? event.data.text() : "" }; }
  const title = message.title || "STELLAR CONNECT";
  event.waitUntil(Promise.all([
    remember(message),
    self.registration.showNotification(title, {
      body: message.body || "",
      tag: message.id || undefined,
      renotify: true,
      requireInteraction: message.required === true || message.kind === "notice" || message.kind === "reminder",
      icon: "/favicon.ico",
      badge: "/favicon.ico",
      data: { url: message.url || "/" },
    }),
    self.clients.matchAll({ type: "window" }).then(clients => clients.forEach(client => client.postMessage({ type: "stellar-push", message }))),
  ]));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clients => {
    const open = clients.find(client => client.url.startsWith(self.location.origin));
    if (open) { open.navigate(url).catch(() => {}); return open.focus(); }
    return self.clients.openWindow(url);
  }));
});
`;

export const MANIFEST = JSON.stringify({
  name: "STELLAR CONNECT",
  short_name: "STELLAR",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#f5efe7",
  theme_color: "#65243a",
  lang: "ko",
  icons: [{ src: "/favicon.ico", sizes: "any", type: "image/svg+xml", purpose: "any" }],
});
