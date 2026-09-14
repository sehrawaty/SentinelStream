package com.sentinelstream.triage;

import com.mongodb.client.ClientSession;
import com.mongodb.client.MongoClient;
import com.mongodb.client.MongoCollection;
import com.mongodb.client.MongoDatabase;
import com.mongodb.client.model.Filters;
import com.mongodb.client.model.ReplaceOptions;
import com.mongodb.client.model.Updates;
import org.bson.Document;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

import java.util.Date;

/**
 * CLAUDE.md §8 D-10 -- the block-card write-back, the clearest single
 * demonstration of "why polyglot": a multi-document Mongo transaction
 * (rs0, only possible because Mongo runs as a real replica set) commits
 * durably first, and only then does the Redis mirror update, which the
 * consumer's step 1 (`SISMEMBER blocklist:cards`) reads on the hot path.
 * Block a card here and its next transactions render DECLINED in the live
 * tape -- a MongoDB write visibly altering the live stream through Redis.
 */
@Service
public class CardBlockService {

    private static final Logger log = LoggerFactory.getLogger(CardBlockService.class);
    private static final String BLOCKLIST_KEY = "blocklist:cards";

    private final MongoClient mongoClient;
    private final MongoTemplate mongoTemplate;
    private final StringRedisTemplate redis;

    public CardBlockService(MongoClient mongoClient, MongoTemplate mongoTemplate, StringRedisTemplate redis) {
        this.mongoClient = mongoClient;
        this.mongoTemplate = mongoTemplate;
        this.redis = redis;
    }

    public void block(String cardId, String reason, String by, String sourceAlertId) {
        Date now = new Date();

        try (ClientSession session = mongoClient.startSession()) {
            session.withTransaction(() -> {
                MongoDatabase db = mongoTemplate.getDb();
                MongoCollection<Document> blockedCards = db.getCollection("blocked_cards");
                MongoCollection<Document> alerts = db.getCollection("alerts");

                Document blockDoc = new Document()
                    .append("cardId", cardId)
                    .append("blockedBy", by)
                    .append("blockedAt", now)
                    .append("reason", reason)
                    .append("sourceAlertId", sourceAlertId)
                    .append("active", true)
                    .append("unblockedAt", null);
                blockedCards.replaceOne(session, Filters.eq("cardId", cardId), blockDoc,
                    new ReplaceOptions().upsert(true));

                // cardBlocked is a side-channel flag, not a status transition, so it
                // does not touch statusHistory (documented as strictly {from,to,by,at}
                // status-change entries, §4.2) -- the block's own audit trail lives in
                // blocked_cards.blockedBy/blockedAt/reason instead.
                alerts.updateMany(session,
                    Filters.and(Filters.eq("cardId", cardId), Filters.ne("status", "FALSE_POSITIVE")),
                    Updates.set("cardBlocked", true));

                return null;
            });
        }

        // Redis mirror only after the Mongo transaction has durably committed --
        // Mongo is the record of truth, Redis is the hot-path cache (§4.2).
        redis.opsForSet().add(BLOCKLIST_KEY, cardId);
        log.info("Blocked card {} (by {}, reason: {}) -- blocklist:cards mirrored", cardId, by, reason);
    }

    public void unblock(String cardId, String by) {
        Date now = new Date();
        MongoCollection<Document> blockedCards = mongoTemplate.getCollection("blocked_cards");
        Document updated = blockedCards.findOneAndUpdate(
            Filters.eq("cardId", cardId),
            Updates.combine(Updates.set("active", false), Updates.set("unblockedAt", now)));

        if (updated == null) {
            throw new org.springframework.web.server.ResponseStatusException(
                org.springframework.http.HttpStatus.NOT_FOUND, "Card " + cardId + " is not on record as blocked");
        }

        redis.opsForSet().remove(BLOCKLIST_KEY, cardId);
        log.info("Unblocked card {} (by {})", cardId, by);
    }
}
