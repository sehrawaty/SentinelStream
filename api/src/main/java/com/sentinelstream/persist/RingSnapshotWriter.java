package com.sentinelstream.persist;

import com.mongodb.client.MongoCollection;
import com.sentinelstream.graph.RingQueryService;
import jakarta.annotation.PostConstruct;
import org.bson.Document;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.stereotype.Component;

import java.util.Date;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

/**
 * CLAUDE.md §7 step 8 / §4.2 ring_snapshots -- persists a RING_FOR_CARD
 * result so the demo can re-render a past ring without re-querying Neo4j.
 * ringId counter seeds from the max issued id (D-23's fix, applied here
 * from the start rather than discovered the same way twice).
 */
@Component
public class RingSnapshotWriter {

    private static final Logger log = LoggerFactory.getLogger(RingSnapshotWriter.class);

    private final MongoTemplate mongoTemplate;
    private final RingQueryService ringQueryService;
    private final AtomicLong counter = new AtomicLong(0);

    public RingSnapshotWriter(MongoTemplate mongoTemplate, RingQueryService ringQueryService) {
        this.mongoTemplate = mongoTemplate;
        this.ringQueryService = ringQueryService;
    }

    @PostConstruct
    void seedCounter() {
        Document doc = mongoTemplate.getCollection("ring_snapshots")
            .find().sort(new Document("ringId", -1)).limit(1).first();
        long seed = 0;
        if (doc != null) {
            String id = doc.getString("ringId");
            if (id != null && id.startsWith("R-")) {
                try {
                    seed = Long.parseLong(id.substring(2));
                } catch (NumberFormatException ignored) { }
            }
        }
        counter.set(seed);
        log.info("RingSnapshotWriter seeded ringId counter at {}", seed);
    }

    /** Returns the persisted ringId, or null if the ring was empty (nothing to snapshot). */
    public String write(String seedCardId, RingQueryService.RingResult ring) {
        if (ring.isEmpty()) {
            return null;
        }
        String ringId = String.format("R-%04d", counter.incrementAndGet());

        List<String> cardIds = ring.cardNodes().stream().map(c -> String.valueOf(c.get("id"))).toList();
        List<Map<String, Object>> sharedEntities = ringQueryService.sharedEntitiesFrom(ring);
        List<Document> edges = ring.edges().stream()
            .map(e -> new Document()
                .append("from", e.get("from"))
                .append("to", e.get("to"))
                .append("type", e.get("rel")))
            .toList();

        Document snapshot = new Document()
            .append("ringId", ringId)
            .append("discoveredAt", new Date())
            .append("seedCardId", seedCardId)
            .append("cardIds", cardIds)
            .append("sharedEntities", sharedEntities.stream().map(Document::new).toList())
            .append("edges", edges)
            .append("hopDepth", 2) // card->entity->card is the minimal ring topology; see CLAUDE.md §4.4
            // (int) cast: ring_snapshots.queryMs schema allows ["int","double"], and a
            // plain `long` serialises as BSON int64, which isn't in that list -- caught
            // live (§8 D-29). Millisecond query times never approach int range.
            .append("queryMs", (int) ring.queryMs());

        MongoCollection<Document> coll = mongoTemplate.getCollection("ring_snapshots");
        coll.insertOne(snapshot);
        log.info("Ring snapshot {} persisted: seed={} cards={} entities={} ({}ms)",
            ringId, seedCardId, cardIds.size(), sharedEntities.size(), ring.queryMs());
        return ringId;
    }
}
