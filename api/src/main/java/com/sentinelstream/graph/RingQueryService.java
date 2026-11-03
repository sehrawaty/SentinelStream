package com.sentinelstream.graph;

import jakarta.annotation.PostConstruct;
import org.neo4j.driver.Driver;
import org.neo4j.driver.Record;
import org.neo4j.driver.Result;
import org.neo4j.driver.Session;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * CLAUDE.md §4.4 -- the two ring queries. RING_FOR_CARD carries one fix
 * over the originally-documented text (§8 D-27): `WHERE m <> seed`, without
 * which a variable-length undirected match routinely cycles back through
 * the seed itself on any graph with more than one shared entity per card --
 * confirmed live (114 distinct cycle paths back to one seed card) -- and
 * `collect(DISTINCT m)` only dedupes by node identity, not by "is this the
 * seed", so the seed silently doubled in the result. Read-only
 * (executeRead): neither query mutates the graph.
 */
@Service
public class RingQueryService {

    private static final String RING_FOR_CARD_CYPHER = """
        MATCH (seed:Card {cardId: $cardId})
        CALL {
          WITH seed
          MATCH (seed)-[:USED_DEVICE|FROM_IP*1..6]-(m:Card)
          WHERE m <> seed
          RETURN collect(DISTINCT m) AS others
        }
        WITH [seed] + others AS cards
        UNWIND cards AS c
        MATCH (c)-[r:USED_DEVICE|FROM_IP]->(e)
        WITH cards, c, r, e
        WHERE size([ (x:Card)-[:USED_DEVICE|FROM_IP]->(e) WHERE x IN cards | x ]) >= 2
        RETURN
          [x IN cards | { id: x.cardId, blocked: coalesce(x.blocked, false) }]      AS cardNodes,
          collect(DISTINCT { id: coalesce(e.deviceId, e.ip),
                             type: head(labels(e)) })                               AS entityNodes,
          collect(DISTINCT { from: c.cardId,
                             to:   coalesce(e.deviceId, e.ip),
                             rel:  type(r), weight: r.count })                      AS edges
        """;

    private static final String ALL_RINGS_CYPHER = """
        MATCH (e)<-[:USED_DEVICE|FROM_IP]-(c:Card)
        WHERE e:Device OR e:Ip
        WITH e, collect(DISTINCT c) AS cards
        WHERE size(cards) >= $minFanout
        RETURN coalesce(e.deviceId, e.ip) AS entityId,
               head(labels(e))            AS entityType,
               size(cards)                AS cardCount,
               [x IN cards | x.cardId]    AS cardIds
        ORDER BY cardCount DESC
        LIMIT $limit
        """;

    private static final Logger log = LoggerFactory.getLogger(RingQueryService.class);

    private final Driver driver;

    public RingQueryService(Driver driver) {
        this.driver = driver;
    }

    /**
     * §8 D-28 -- forces Cypher query-plan compilation for this query shape
     * before any real traffic needs it, off the startup thread so it never
     * delays boot/health readiness. A nonexistent cardId keeps this a cheap
     * no-op traversal (MATCH finds nothing, returns immediately) while still
     * exercising the same plan the real query will reuse.
     */
    @PostConstruct
    void warmUp() {
        Thread t = new Thread(() -> {
            try {
                long start = System.nanoTime();
                ringForCard("__warmup__");
                log.info("Ring query plan warmed up in {}ms", (System.nanoTime() - start) / 1_000_000);
            } catch (Exception e) {
                log.warn("Ring query warm-up failed (non-fatal)", e);
            }
        }, "ring-query-warmup");
        t.setDaemon(true);
        t.start();
    }

    public record RingResult(List<Map<String, Object>> cardNodes, List<Map<String, Object>> entityNodes,
                              List<Map<String, Object>> edges, long queryMs) {
        public boolean isEmpty() { return cardNodes.isEmpty(); }
    }

    /** RING_FOR_CARD -- the centrepiece. Empty result (not an error) if the card has no shared entities. */
    public RingResult ringForCard(String cardId) {
        long start = System.nanoTime();
        try (Session session = driver.session()) {
            Result result = session.run(RING_FOR_CARD_CYPHER, Map.of("cardId", cardId));
            // Timed after the record is pulled, not after run(): the driver streams
            // lazily, so stopping the clock at run() reported ~1ms for any ring.
            boolean found = result.hasNext();
            Record record = found ? result.single() : null;
            long ms = (System.nanoTime() - start) / 1_000_000;
            if (!found) {
                return new RingResult(List.of(), List.of(), List.of(), ms);
            }
            return new RingResult(
                record.get("cardNodes").asList(v -> v.asMap()),
                record.get("entityNodes").asList(v -> v.asMap()),
                record.get("edges").asList(v -> v.asMap()),
                ms);
        }
    }

    public record FanoutEntity(String entityId, String entityType, long cardCount, List<String> cardIds) {}

    /** ALL_RINGS -- global sweep, powers the cuttable "all rings" panel. */
    public List<FanoutEntity> allRings(int minFanout, int limit) {
        try (Session session = driver.session()) {
            Result result = session.run(ALL_RINGS_CYPHER, Map.of("minFanout", minFanout, "limit", limit));
            return result.list(record -> new FanoutEntity(
                record.get("entityId").asString(),
                record.get("entityType").asString(),
                record.get("cardCount").asLong(),
                record.get("cardIds").asList(v -> v.asString())));
        }
    }

    /** Derives {id, type, cardCount} per shared entity from a RingResult's edges -- what ring_snapshots stores. */
    public List<Map<String, Object>> sharedEntitiesFrom(RingResult ring) {
        Map<String, Long> countByEntity = new LinkedHashMap<>();
        Map<String, String> typeByEntity = new LinkedHashMap<>();
        for (Map<String, Object> edge : ring.edges()) {
            String to = String.valueOf(edge.get("to"));
            countByEntity.merge(to, 1L, Long::sum);
        }
        for (Map<String, Object> entity : ring.entityNodes()) {
            typeByEntity.put(String.valueOf(entity.get("id")), String.valueOf(entity.get("type")));
        }
        return countByEntity.entrySet().stream()
            .map(e -> {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("id", e.getKey());
                row.put("type", typeByEntity.getOrDefault(e.getKey(), "Unknown"));
                row.put("cardCount", e.getValue());
                return row;
            })
            .toList();
    }
}
