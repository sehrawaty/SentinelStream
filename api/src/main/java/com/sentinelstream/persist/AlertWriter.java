package com.sentinelstream.persist;

import com.mongodb.MongoWriteException;
import com.mongodb.client.MongoCollection;
import com.sentinelstream.detect.RulesEngine;
import jakarta.annotation.PostConstruct;
import org.bson.Document;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.stereotype.Component;

import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Function;

/**
 * CLAUDE.md §7 step 6 -- synchronous insertOne into `alerts`. Deliberately
 * not buffered: alerts are ~1/s, not 150/s, they are the durable record, and
 * step 9's PUBLISH must not announce an alert the API cannot yet serve
 * (CLAUDE.md §8 D-13).
 */
@Component
public class AlertWriter {

    private static final Logger log = LoggerFactory.getLogger(AlertWriter.class);

    private final MongoTemplate mongoTemplate;
    private final AlertMapper mapper;
    private final AtomicLong counter = new AtomicLong(0);

    public AlertWriter(MongoTemplate mongoTemplate, AlertMapper mapper) {
        this.mongoTemplate = mongoTemplate;
        this.mapper = mapper;
    }

    /**
     * Seeds from the highest alertId number ever issued (found in either
     * `alerts` or `alerts_archive`), not countDocuments(). A count undershoots
     * badly once anything has ever been deleted -- caught live during S6
     * testing: after deleting most test alerts, the counter restarted near
     * zero while thousands of already-used ids still existed ahead of it,
     * exhausting the retry budget on collision after collision instead of a
     * rare one-off. alertId's fixed-width zero-padding ("A-%07d") makes
     * lexicographic string sort agree with numeric sort, so this is a plain
     * indexed sort, not a table scan.
     */
    @PostConstruct
    void seedCounter() {
        long seed = Math.max(
            maxIssuedId("alerts", "alertId"),
            maxIssuedId("alerts_archive", "originalId"));
        counter.set(seed);
        log.info("AlertWriter seeded alertId counter at {}", seed);
    }

    private long maxIssuedId(String collection, String field) {
        Document doc = mongoTemplate.getCollection(collection)
            .find().sort(new Document(field, -1)).limit(1).first();
        String value = doc == null ? null : doc.getString(field);
        if (value == null || !value.startsWith("A-")) {
            return 0;
        }
        try {
            return Long.parseLong(value.substring(2));
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    /** Returns the persisted alertId, or null if the write failed after retries. */
    public String write(String txnId, String cardId, long ts, RulesEngine.Evaluation eval) {
        return insertWithRetry(alertId -> mapper.toDocument(alertId, txnId, cardId, ts, eval), "txn " + txnId);
    }

    /** PLAN.md Part 2 "Create" -- analyst-raised, no detector behind it. Returns the persisted alertId. */
    public String writeManual(String cardId, String severity, String reason, String author) {
        return insertWithRetry(
            alertId -> mapper.toManualDocument(alertId, cardId, severity, reason, author),
            "manual alert for card " + cardId);
    }

    private String insertWithRetry(Function<String, Document> docBuilder, String context) {
        MongoCollection<Document> coll = mongoTemplate.getCollection("alerts");

        for (int attempt = 0; attempt < 10; attempt++) {
            String alertId = String.format("A-%07d", counter.incrementAndGet());
            Document doc = docBuilder.apply(alertId);
            try {
                coll.insertOne(doc);
                return alertId;
            } catch (MongoWriteException e) {
                if (e.getError().getCategory() == com.mongodb.ErrorCategory.DUPLICATE_KEY) {
                    log.warn("alertId {} collided (attempt {}), retrying with next id", alertId, attempt);
                    continue;
                }
                log.error("Failed to persist alert ({})", context, e);
                return null;
            }
        }
        log.error("Exhausted retries generating a unique alertId ({})", context);
        return null;
    }
}
