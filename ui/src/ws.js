import { useEffect, useRef, useState } from 'react';
import { Client } from '@stomp/stompjs';

// CLAUDE.md §6 -- one shared STOMP connection to /ws (raw WebSocket; the
// server's SockJS registration also accepts a plain "ws://" upgrade, so no
// sockjs-client dependency is needed).
const client = new Client({
  brokerURL: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/websocket`,
  reconnectDelay: 3000,
  heartbeatIncoming: 10000,
  heartbeatOutgoing: 10000,
});

// Multiple components subscribe to the same three topics independently
// (settlement tape + alert feed both want /topic/alerts, say). One
// client-level STOMP subscription per destination is kept here and fanned
// out to every registered handler, rather than each component opening its
// own -- and, critically, resubscribed from a single onConnect callback on
// every reconnect. (A per-hook `client.onConnect = ...` would overwrite the
// previous hook's callback instead of composing with it, silently dropping
// that topic's resubscription after a reconnect -- caught before it shipped,
// not live, by tracing what happens when two components mount.)
const handlers = new Map(); // destination -> Set<handler>
const liveSubs = new Map(); // destination -> stomp Subscription
const connectListeners = new Set();

client.onConnect = () => {
  for (const dest of handlers.keys()) {
    subscribeDestination(dest);
  }
  connectListeners.forEach((fn) => fn(true));
};
client.onDisconnect = () => connectListeners.forEach((fn) => fn(false));
client.onWebSocketClose = () => connectListeners.forEach((fn) => fn(false));

function subscribeDestination(dest) {
  if (liveSubs.has(dest)) return;
  liveSubs.set(dest, client.subscribe(dest, (msg) => {
    let body = msg.body;
    try { body = JSON.parse(msg.body); } catch { /* leave as string */ }
    handlers.get(dest)?.forEach((h) => h(body));
  }));
}

client.activate();

/** Subscribes to a STOMP topic; onMessage receives the JSON-parsed body. */
export function useStompTopic(destination, onMessage) {
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;

  useEffect(() => {
    const fn = (body) => handlerRef.current(body);
    if (!handlers.has(destination)) handlers.set(destination, new Set());
    handlers.get(destination).add(fn);
    if (client.connected) subscribeDestination(destination);

    return () => {
      const set = handlers.get(destination);
      set?.delete(fn);
      if (set && set.size === 0) {
        handlers.delete(destination);
        liveSubs.get(destination)?.unsubscribe();
        liveSubs.delete(destination);
      }
    };
  }, [destination]);
}

/** True once the shared STOMP connection is live -- drives the topbar's live dot. */
export function useStompConnected() {
  const [connected, setConnected] = useState(client.connected);
  useEffect(() => {
    connectListeners.add(setConnected);
    return () => connectListeners.delete(setConnected);
  }, []);
  return connected;
}
