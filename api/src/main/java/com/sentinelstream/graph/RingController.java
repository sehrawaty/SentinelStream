package com.sentinelstream.graph;

import org.bson.Document;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** CLAUDE.md §4.4 / §6 -- the two ring queries, REST-reachable. */
@RestController
public class RingController {

    private final RingQueryService ringQueryService;
    private final MongoTemplate mongoTemplate;

    public RingController(RingQueryService ringQueryService, MongoTemplate mongoTemplate) {
        this.ringQueryService = ringQueryService;
        this.mongoTemplate = mongoTemplate;
    }

    /** Live RING_FOR_CARD -- real-time Neo4j traversal, shaped for Cytoscape. */
    @GetMapping("/api/rings/{cardId}")
    public Map<String, Object> ringForCard(@PathVariable String cardId) {
        RingQueryService.RingResult ring = ringQueryService.ringForCard(cardId);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("seedCardId", cardId);
        body.put("cardNodes", ring.cardNodes());
        body.put("entityNodes", ring.entityNodes());
        body.put("edges", ring.edges());
        body.put("queryMs", ring.queryMs());
        body.put("found", !ring.isEmpty());
        return body;
    }

    /** Most recently persisted snapshot for a seed card -- Mongo, fast, no Neo4j round trip. */
    @GetMapping("/api/rings/{cardId}/snapshot")
    public Document latestSnapshot(@PathVariable String cardId) {
        return mongoTemplate.getCollection("ring_snapshots")
            .find(new Document("seedCardId", cardId))
            .sort(new Document("discoveredAt", -1))
            .limit(1)
            .first();
    }

    /** Ring history, newest first -- index #15 ({discoveredAt: -1}). */
    @GetMapping("/api/rings/snapshots")
    public List<Document> snapshots(@RequestParam(defaultValue = "12") int limit) {
        List<Document> out = new ArrayList<>();
        mongoTemplate.getCollection("ring_snapshots")
            .find()
            .projection(new Document("_id", 0).append("edges", 0))
            .sort(new Document("discoveredAt", -1))
            .limit(Math.min(limit, 50))
            .into(out);
        return out;
    }

    /** ALL_RINGS -- global sweep, powers the cuttable "all rings" panel. */
    @GetMapping("/api/rings")
    public List<RingQueryService.FanoutEntity> allRings(
            @RequestParam(defaultValue = "3") int minFanout,
            @RequestParam(defaultValue = "20") int limit) {
        return ringQueryService.allRings(minFanout, limit);
    }
}
