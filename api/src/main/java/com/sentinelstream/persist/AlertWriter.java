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

    @PostConstruct
    void seedCounter() {
        long existing = mongoTemplate.getCollection("alerts").countDocuments();
        counter.set(existing);
        log.info("AlertWriter seeded alertId counter at {}", existing);
    }

    /** Returns the persisted alertId, or null if the write failed after retries. */
    public String write(String txnId, String cardId, long ts, RulesEngine.Evaluation eval) {
        MongoCollection<Document> coll = mongoTemplate.getCollection("alerts");

        for (int attempt = 0; attempt < 3; attempt++) {
            String alertId = String.format("A-%07d", counter.incrementAndGet());
            Document doc = mapper.toDocument(alertId, txnId, cardId, ts, eval);
            try {
                coll.insertOne(doc);
                return alertId;
            } catch (MongoWriteException e) {
                if (e.getError().getCategory() == com.mongodb.ErrorCategory.DUPLICATE_KEY) {
                    log.warn("alertId {} collided (attempt {}), retrying with next id", alertId, attempt);
                    continue;
                }
                log.error("Failed to persist alert for txn {} (card {})", txnId, cardId, e);
                return null;
            }
        }
        log.error("Exhausted retries generating a unique alertId for txn {}", txnId);
        return null;
    }
}
