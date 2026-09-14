package com.sentinelstream.graph;

import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.neo4j.driver.Driver;
import org.neo4j.driver.Session;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * CLAUDE.md §7 step 7 / §4.4 -- the batched graph projector, deliberately
 * mirroring MongoBulkWriter's shape (implementation plan Part 5): a bounded
 * queue, a dedicated flusher thread, flush on count or time, never a
 * synchronous Bolt call on the hot path. `MERGE`, never `CREATE` -- a
 * replayed edge (redelivery, or the same card/device/ip pair recurring
 * naturally) increments a counter instead of duplicating a relationship.
 */
@Component
@EnableConfigurationProperties(GraphProjectorProperties.class)
public class GraphProjector {

    private static final Logger log = LoggerFactory.getLogger(GraphProjector.class);

    private static final String MERGE_CYPHER = """
        UNWIND $batch AS row
        MERGE (c:Card {cardId: row.cardId})
          ON CREATE SET c.firstSeen = row.ts, c.txnCount = 0
        SET c.lastSeen = row.ts, c.txnCount = c.txnCount + 1
        MERGE (d:Device {deviceId: row.deviceId})
          ON CREATE SET d.firstSeen = row.ts
        SET d.lastSeen = row.ts
        MERGE (c)-[ud:USED_DEVICE]->(d)
          ON CREATE SET ud.count = 0, ud.firstSeen = row.ts
        SET ud.count = ud.count + 1, ud.lastSeen = row.ts
        MERGE (i:Ip {ip: row.ip})
          ON CREATE SET i.firstSeen = row.ts
        SET i.lastSeen = row.ts
        MERGE (c)-[fi:FROM_IP]->(i)
          ON CREATE SET fi.count = 0, fi.firstSeen = row.ts
        SET fi.count = fi.count + 1, fi.lastSeen = row.ts
        """;

    private final Driver driver;
    private final GraphProjectorProperties props;

    private BlockingQueue<Map<String, Object>> queue;
    private ScheduledExecutorService flusher;

    private final AtomicLong flushCount = new AtomicLong();
    private final AtomicLong flushedEdges = new AtomicLong();
    private final AtomicLong dropped = new AtomicLong();

    public GraphProjector(Driver driver, GraphProjectorProperties props) {
        this.driver = driver;
        this.props = props;
    }

    @PostConstruct
    void start() {
        this.queue = new ArrayBlockingQueue<>(props.getQueueCapacity());
        this.flusher = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "neo4j-projector-flusher");
            t.setDaemon(true);
            return t;
        });
        flusher.scheduleWithFixedDelay(this::flush, props.getFlushIntervalMs(), props.getFlushIntervalMs(),
            TimeUnit.MILLISECONDS);
        log.info("GraphProjector started: queueCapacity={} flushEdges={} flushIntervalMs={}",
            props.getQueueCapacity(), props.getFlushEdges(), props.getFlushIntervalMs());
    }

    /** Non-blocking. Called from the consumer's hot path (§7 step 7) -- never waits on Bolt I/O. */
    public void enqueue(String cardId, String deviceId, String ip, long tsMillis) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("cardId", cardId);
        row.put("deviceId", deviceId);
        row.put("ip", ip);
        row.put("ts", tsMillis);

        boolean accepted = queue.offer(row);
        if (!accepted) {
            long total = dropped.incrementAndGet();
            log.warn("GraphProjector queue full (capacity={}) -- dropping edge for card {} (total dropped={})",
                props.getQueueCapacity(), cardId, total);
            return;
        }
        if (queue.size() >= props.getFlushEdges()) {
            flusher.execute(this::flush);
        }
    }

    private synchronized void flush() {
        List<Map<String, Object>> batch = new ArrayList<>(props.getFlushEdges());
        queue.drainTo(batch, props.getFlushEdges());
        if (batch.isEmpty()) {
            return;
        }
        try (Session session = driver.session()) {
            session.executeWrite(tx -> {
                tx.run(MERGE_CYPHER, Map.of("batch", batch)).consume();
                return null;
            });
            flushCount.incrementAndGet();
            flushedEdges.addAndGet(batch.size());
        } catch (Exception e) {
            log.error("Graph projector batch of {} edges failed -- edges lost, not requeued (best-effort projection)",
                batch.size(), e);
        }
    }

    @PreDestroy
    void shutdown() {
        log.info("GraphProjector shutting down -- draining {} queued edges", queue.size());
        flush();
        flusher.shutdown();
        try {
            if (!flusher.awaitTermination(5, TimeUnit.SECONDS)) {
                flusher.shutdownNow();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    public int queueDepth() { return queue == null ? 0 : queue.size(); }
    public long flushCount() { return flushCount.get(); }
    public long flushedEdges() { return flushedEdges.get(); }
    public long dropped() { return dropped.get(); }
}
