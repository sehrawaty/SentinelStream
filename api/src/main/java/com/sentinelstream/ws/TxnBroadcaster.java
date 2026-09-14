package com.sentinelstream.ws;

import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

/**
 * CLAUDE.md §6 / §8 D-05 -- {@code /topic/txn} is sampled to ~8 msg/s
 * (roughly one row per the settlement tape's 120ms print-in cycle); flagged
 * transactions always pass. Unlike alerts:live/rings:live this does NOT go
 * through Redis Pub/Sub: it is not in the §4.1 key registry, and sampling
 * is inherently a single-process, in-memory decision (a fixed minimum
 * interval between forwarded rows) -- there is exactly one API instance in
 * this design, so a Redis hop here would add latency and a channel to name
 * for no benefit.
 *
 * Deliberately NOT called from the hot path's step 9 for its blocking cost:
 * it costs one volatile read/CAS per transaction, same order of magnitude
 * as the pipelined Redis round trip in step 3, so it stays synchronous
 * there rather than adding a queue for something this cheap.
 */
@Component
public class TxnBroadcaster {

    private static final long MIN_INTERVAL_MS = 125; // ~8/s

    private final SimpMessagingTemplate stomp;
    private final AtomicLong lastSentAt = new AtomicLong(0);

    public TxnBroadcaster(SimpMessagingTemplate stomp) {
        this.stomp = stomp;
    }

    public void maybePublish(Map<String, String> v, boolean flagged, boolean declined) {
        long now = System.currentTimeMillis();
        if (!flagged) {
            long prev = lastSentAt.get();
            if (now - prev < MIN_INTERVAL_MS || !lastSentAt.compareAndSet(prev, now)) {
                return; // sampled out -- not this row's turn
            }
        } else {
            lastSentAt.set(now); // flagged rows don't consume/reset the sampling gate unfairly, but do mark activity
        }

        Map<String, Object> payload = Map.of(
            "txnId", v.get("txnId"),
            "cardId", v.get("cardId"),
            "amount", v.get("amount"),
            "city", v.get("city"),
            "merchantName", v.getOrDefault("merchantName", ""),
            "ts", v.get("ts"),
            "flagged", flagged,
            "declined", declined
        );
        stomp.convertAndSend("/topic/txn", payload);
    }
}
