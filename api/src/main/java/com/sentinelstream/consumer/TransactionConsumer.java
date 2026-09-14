package com.sentinelstream.consumer;

import com.sentinelstream.detect.RulesEngine;
import com.sentinelstream.detect.WindowService;
import com.sentinelstream.generator.StreamProperties;
import com.sentinelstream.graph.GraphProjector;
import com.sentinelstream.graph.RingQueryTrigger;
import com.sentinelstream.persist.AlertWriter;
import com.sentinelstream.persist.MongoBulkWriter;
import com.sentinelstream.persist.TransactionMapper;
import com.sentinelstream.ws.TxnBroadcaster;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.bson.Document;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.connection.stream.MapRecord;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

/**
 * CLAUDE.md §7 — the frozen consumer side-effect order. This slice (S12)
 * implements all 10 steps.
 *
 * Used both by the live stream listener and by {@link StreamConsumerConfig}'s
 * PEL reclaimer, so a redelivered message (live or reclaimed) goes through
 * identical logic.
 */
@Component
public class TransactionConsumer {

    private static final Logger log = LoggerFactory.getLogger(TransactionConsumer.class);
    private static final String BLOCKLIST_KEY = "blocklist:cards";
    private static final String IDEM_KEY_PREFIX = "idem:txn:";
    private static final String ALERTS_CHANNEL = "alerts:live";

    private final StringRedisTemplate redis;
    private final StreamProperties streamProps;
    private final RedisKeysProperties keysProps;
    private final MongoBulkWriter bulkWriter;
    private final TransactionMapper mapper;
    private final WindowService windows;
    private final RulesEngine rulesEngine;
    private final AlertWriter alertWriter;
    private final GraphProjector graphProjector;
    private final RingQueryTrigger ringQueryTrigger;
    private final TxnBroadcaster txnBroadcaster;
    private final ObjectMapper objectMapper;
    private final AtomicLong processedTotal = new AtomicLong(0);
    private final AtomicLong alertsTotal = new AtomicLong(0);

    public TransactionConsumer(StringRedisTemplate redis, StreamProperties streamProps,
                                RedisKeysProperties keysProps, MongoBulkWriter bulkWriter,
                                TransactionMapper mapper, WindowService windows,
                                RulesEngine rulesEngine, AlertWriter alertWriter,
                                GraphProjector graphProjector, RingQueryTrigger ringQueryTrigger,
                                TxnBroadcaster txnBroadcaster, ObjectMapper objectMapper) {
        this.redis = redis;
        this.streamProps = streamProps;
        this.keysProps = keysProps;
        this.bulkWriter = bulkWriter;
        this.mapper = mapper;
        this.windows = windows;
        this.rulesEngine = rulesEngine;
        this.alertWriter = alertWriter;
        this.graphProjector = graphProjector;
        this.ringQueryTrigger = ringQueryTrigger;
        this.txnBroadcaster = txnBroadcaster;
        this.objectMapper = objectMapper;
    }

    public void process(MapRecord<String, String, String> record) {
        Map<String, String> v = record.getValue();
        String txnId = v.get("txnId");
        String cardId = v.get("cardId");

        try {
            // 1. BLOCKLIST CHECK
            boolean blocked = Boolean.TRUE.equals(redis.opsForSet().isMember(BLOCKLIST_KEY, cardId));

            // 2. IDEMPOTENCY GUARD
            Boolean acquired = redis.opsForValue().setIfAbsent(
                IDEM_KEY_PREFIX + txnId, "1", Duration.ofSeconds(keysProps.getIdempotencyTtl()));
            if (!Boolean.TRUE.equals(acquired)) {
                log.debug("Redelivery of already-processed txn {} — no side effects repeated", txnId);
                ack(record);
                return;
            }

            String deviceId = v.get("deviceId");
            String ip = v.get("ip");
            String city = v.get("city");
            double amount = Double.parseDouble(v.get("amount"));
            double lat = Double.parseDouble(v.get("lat"));
            double lon = Double.parseDouble(v.get("lon"));
            long ts = Long.parseLong(v.get("ts"));

            RulesEngine.Evaluation eval = null;
            if (!blocked) {
                // 3. WINDOW UPDATES — pipelined trim+add+expire, single round trip.
                windows.updateWindows(cardId, deviceId, ip, txnId, amount, lat, lon, ts);

                // 4. EVALUATE DETECTORS — pure reads over the windows just written.
                eval = rulesEngine.evaluate(cardId, deviceId, ip, txnId, amount, city);
            }
            // A blocked card updates neither: §7 ordering rationale -- "a blocked
            // card should not update behavioural windows."

            // 5. PERSIST TRANSACTION (buffer) — non-blocking enqueue, MongoBulkWriter
            //    flushes on 200 docs or 500ms (implementation plan Part 5). Upsert on
            //    txnId makes this safe to repeat on redelivery. flagged/score come
            //    from step 4's evaluation, already computed above (D-11 denormalisation).
            boolean flagged = eval != null && eval.score() > 0;
            int score = eval != null ? eval.score() : 0;
            Document txnDoc = mapper.toDocument(v, blocked, flagged, score);
            bulkWriter.enqueue(txnDoc);

            // 6. PERSIST ALERT (sync) — only when at least one rule fired.
            Document alertDoc = null;
            if (eval != null && eval.score() > 0) {
                alertDoc = alertWriter.write(txnId, cardId, ts, eval);
                if (alertDoc != null) {
                    alertsTotal.incrementAndGet();
                }
            }

            // 7. ENQUEUE GRAPH EDGES — non-blocking, batched by GraphProjector.
            //    Unconditional (not gated on `blocked` like steps 3-4): the
            //    entity graph tracks what a card *attempted*, blocked or not.
            graphProjector.enqueue(cardId, deviceId, ip, ts);

            // 8. RING QUERY — cooldown-gated, async, never inline (§7). Fires
            //    only when ENTITY_FANOUT actually fired this evaluation, not
            //    on every alert -- this is the exact handoff spec §4 narrates.
            if (eval != null && eval.firedRules().stream().anyMatch(r -> "ENTITY_FANOUT".equals(r.type()))) {
                ringQueryTrigger.maybeTrigger(cardId);
            }

            // 9. PUBLISH — alerts:live (Redis, relayed onto /topic/alerts by
            //    RedisStompBridge) always when an alert fired; /topic/txn
            //    sampled directly (§6, §8 D-05) regardless of alert status.
            String alertId = alertDoc == null ? null : alertDoc.getString("alertId");
            if (alertDoc != null) {
                publishAlert(alertDoc);
            }
            txnBroadcaster.maybePublish(v, alertId != null, blocked);

            log.debug("txn {} card={} amount={}{}{}", txnId, cardId, v.get("amount"),
                blocked ? " [BLOCKED — declined at step 1]" : "",
                alertId != null ? " [ALERT " + alertId + " " + eval.severity() + " score=" + eval.score() + "]" : "");
            long total = processedTotal.incrementAndGet();
            if (total % 1000 == 0) {
                log.info("Processed {} transactions, {} alerts total (bulk writer queue depth={})",
                    total, alertsTotal.get(), bulkWriter.queueDepth());
            }

            // 10. XACK — always last
            ack(record);
        } catch (Exception e) {
            // Deliberately do NOT ack on failure: the entry stays in the PEL and
            // is redelivered / reclaimed (§7 "why XACK last"). Idempotency guard
            // (step 2) makes the redelivery safe.
            log.error("Processing failed for txn {} (card {}) — leaving unacked for redelivery", txnId, cardId, e);
        }
    }

    private void ack(MapRecord<String, String, String> record) {
        redis.opsForStream().acknowledge(streamProps.getConsumerGroup(), record);
    }

    /**
     * CLAUDE.md §4.1 alerts:live -- PUBLISH the full alert document (§6: "full
     * alert document, unsampled"), relayed onto /topic/alerts by
     * {@link com.sentinelstream.ws.RedisStompBridge}. Serialised with the
     * app's own Spring-managed Jackson ObjectMapper -- NOT Document.toJson()
     * (BSON's extended-JSON, which wraps dates as {"$date": "..."} and would
     * need unwrapping the REST API doesn't require) -- specifically so a live
     * alert arrives shaped identically to GET /api/alerts/{alertId}'s
     * response: same Document type through the same Spring codec produces
     * the same plain-ISO-string dates either way.
     */
    private void publishAlert(Document alertDoc) {
        String alertId = alertDoc.getString("alertId");
        try {
            redis.convertAndSend(ALERTS_CHANNEL, objectMapper.writeValueAsString(alertDoc));
        } catch (Exception e) {
            // Publishing is best-effort -- the alert is already durably persisted (step 6);
            // a missed pub/sub notification does not lose data, only a live-UI nudge.
            log.warn("Failed to publish alert {} to {}", alertId, ALERTS_CHANNEL, e);
        }
    }
}
