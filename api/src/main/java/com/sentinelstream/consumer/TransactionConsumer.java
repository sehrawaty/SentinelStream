package com.sentinelstream.consumer;

import com.sentinelstream.generator.StreamProperties;
import com.sentinelstream.persist.MongoBulkWriter;
import com.sentinelstream.persist.TransactionMapper;
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
 * CLAUDE.md §7 — the frozen consumer side-effect order. This slice (S4)
 * implements steps 1, 2, 5, 9 (partial) and 10; steps 3, 4, 6, 7, 8 are
 * ordered stubs filled in by later slices (S5 detectors, S11 Neo4j
 * projector, S12 ring query, S14 STOMP) — the numbering in the comments
 * below is not decorative, it is where each future slice's code goes, in
 * this exact position, because §7's order is frozen.
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

    private final StringRedisTemplate redis;
    private final StreamProperties streamProps;
    private final RedisKeysProperties keysProps;
    private final MongoBulkWriter bulkWriter;
    private final TransactionMapper mapper;
    private final AtomicLong processedTotal = new AtomicLong(0);

    public TransactionConsumer(StringRedisTemplate redis, StreamProperties streamProps,
                                RedisKeysProperties keysProps, MongoBulkWriter bulkWriter,
                                TransactionMapper mapper) {
        this.redis = redis;
        this.streamProps = streamProps;
        this.keysProps = keysProps;
        this.bulkWriter = bulkWriter;
        this.mapper = mapper;
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

            // 3. WINDOW UPDATES               — TODO Slice 5 (detectors)
            // 4. EVALUATE DETECTORS           — TODO Slice 5

            // 5. PERSIST TRANSACTION (buffer) — non-blocking enqueue, MongoBulkWriter
            //    flushes on 200 docs or 500ms (implementation plan Part 5). Upsert on
            //    txnId makes this safe to repeat on redelivery.
            Document txnDoc = mapper.toDocument(v, blocked);
            bulkWriter.enqueue(txnDoc);

            // 6. PERSIST ALERT (sync)         — TODO Slice 5/6
            // 7. ENQUEUE GRAPH EDGES          — TODO Slice 11 (Neo4j projector)
            // 8. RING QUERY                   — TODO Slice 12
            // 9. PUBLISH                      — TODO Slice 5 (alerts:live), Slice 14 (/topic/txn)

            log.debug("txn {} card={} amount={}{}", txnId, cardId, v.get("amount"),
                blocked ? " [BLOCKED — declined at step 1]" : "");
            long total = processedTotal.incrementAndGet();
            if (total % 1000 == 0) {
                log.info("Processed {} transactions (bulk writer queue depth={})", total, bulkWriter.queueDepth());
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
}
