package com.sentinelstream.graph;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sentinelstream.consumer.RedisKeysProperties;
import com.sentinelstream.persist.RingSnapshotWriter;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * CLAUDE.md §7 step 8 -- "if ENTITY_FANOUT fired AND ring:cooldown:{c}
 * absent: SET ring:cooldown:{c} 1 NX EX 300 -> async executor: RING_FOR_CARD
 * -> ring_snapshots -> PUBLISH /topic/rings. Never inline." This is the
 * handoff spec §4 narrates: Redis says something is odd here, this class is
 * what hands it to Neo4j to say here is the whole group.
 */
@Component
public class RingQueryTrigger {

    private static final Logger log = LoggerFactory.getLogger(RingQueryTrigger.class);
    private static final String RINGS_CHANNEL = "rings:live";
    private static final String COOLDOWN_PREFIX = "ring:cooldown:";

    private final StringRedisTemplate redis;
    private final RedisKeysProperties keysProps;
    private final RingQueryService ringQueryService;
    private final RingSnapshotWriter snapshotWriter;
    private final ObjectMapper json = new ObjectMapper();
    private final ExecutorService executor = Executors.newFixedThreadPool(2, r -> {
        Thread t = new Thread(r, "ring-query");
        t.setDaemon(true);
        return t;
    });

    public RingQueryTrigger(StringRedisTemplate redis, RedisKeysProperties keysProps,
                             RingQueryService ringQueryService, RingSnapshotWriter snapshotWriter) {
        this.redis = redis;
        this.keysProps = keysProps;
        this.ringQueryService = ringQueryService;
        this.snapshotWriter = snapshotWriter;
    }

    /** Non-blocking: the cooldown check is a single Redis round trip, the query itself runs off-thread. */
    public void maybeTrigger(String cardId) {
        Boolean acquired = redis.opsForValue().setIfAbsent(
            COOLDOWN_PREFIX + cardId, "1", Duration.ofSeconds(keysProps.getRingCooldownTtl()));
        if (!Boolean.TRUE.equals(acquired)) {
            log.debug("Ring query for {} skipped -- cooldown active", cardId);
            return; // already resolved recently for this card -- skip
        }
        log.info("ENTITY_FANOUT fired for {} -- triggering async ring query", cardId);
        executor.submit(() -> runAndPersist(cardId));
    }

    private void runAndPersist(String cardId) {
        try {
            RingQueryService.RingResult ring = ringQueryService.ringForCard(cardId);
            if (ring.isEmpty()) {
                log.debug("Ring query for {} found no shared entities (fanout fired, but no ring formed)", cardId);
                return;
            }
            String ringId = snapshotWriter.write(cardId, ring);
            if (ringId != null) {
                publish(ringId, cardId, ring);
            }
        } catch (Exception e) {
            log.error("Ring query failed for card {}", cardId, e);
        }
    }

    private void publish(String ringId, String cardId, RingQueryService.RingResult ring) {
        try {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("ringId", ringId);
            payload.put("seedCardId", cardId);
            payload.put("cardCount", ring.cardNodes().size());
            payload.put("queryMs", ring.queryMs());
            redis.convertAndSend(RINGS_CHANNEL, json.writeValueAsString(payload));
        } catch (Exception e) {
            log.warn("Failed to publish ring {} to {}", ringId, RINGS_CHANNEL, e);
        }
    }

    @PreDestroy
    void shutdown() {
        executor.shutdown();
        try {
            if (!executor.awaitTermination(5, TimeUnit.SECONDS)) {
                executor.shutdownNow();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
