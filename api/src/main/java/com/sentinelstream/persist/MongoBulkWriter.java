package com.sentinelstream.persist;

import com.mongodb.MongoBulkWriteException;
import com.mongodb.WriteConcern;
import com.mongodb.client.MongoCollection;
import com.mongodb.client.model.BulkWriteOptions;
import com.mongodb.client.model.Filters;
import com.mongodb.client.model.ReplaceOneModel;
import com.mongodb.client.model.ReplaceOptions;
import com.mongodb.client.model.WriteModel;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.bson.Document;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Implementation plan Part 5 -- buffered bulk-write path for MongoDB,
 * mirroring the batching shape the spec already uses for the Neo4j
 * projector (bounded queue, flush on count or time, never inline on the
 * hot path).
 *
 * At ~150 txn/s, insertOne per transaction means 150 round trips/s on the
 * consumer's critical path, ahead of XACK -- this replaces that with a
 * non-blocking enqueue (offer()) and a dedicated flusher thread doing
 * unordered upserts in batches of up to flushDocs, every flushIntervalMs
 * at minimum.
 *
 * Upsert (ReplaceOneModel keyed on txnId, not insertOne) so a redelivered
 * message (§7 step 2's idempotency guard, or the PEL reclaimer) is safe to
 * write again -- index #1's unique constraint on txnId backs this at the
 * storage layer, not just the Redis guard.
 *
 * Write concern w:1 for transactions (CLAUDE.md §8 D-13): they are
 * replayable from txn:stream (MAXLEN ~100k, ~11 min) if lost, unlike
 * alerts which are the durable record and use the connection's default
 * w:majority.
 */
@Component
@EnableConfigurationProperties(BulkWriterProperties.class)
public class MongoBulkWriter {

    private static final Logger log = LoggerFactory.getLogger(MongoBulkWriter.class);
    private static final String COLLECTION = "transactions";

    private final MongoTemplate mongoTemplate;
    private final BulkWriterProperties props;

    private BlockingQueue<Document> queue;
    private ScheduledExecutorService flusher;

    private final AtomicLong flushCount = new AtomicLong();
    private final AtomicLong flushedDocs = new AtomicLong();
    private final AtomicLong dropped = new AtomicLong();
    private final AtomicLong lastFlushMs = new AtomicLong();

    public MongoBulkWriter(MongoTemplate mongoTemplate, BulkWriterProperties props) {
        this.mongoTemplate = mongoTemplate;
        this.props = props;
    }

    @PostConstruct
    void start() {
        this.queue = new ArrayBlockingQueue<>(props.getQueueCapacity());
        this.flusher = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "mongo-bulk-flusher");
            t.setDaemon(true);
            return t;
        });
        flusher.scheduleWithFixedDelay(this::flush, props.getFlushIntervalMs(), props.getFlushIntervalMs(),
            TimeUnit.MILLISECONDS);
        log.info("MongoBulkWriter started: queueCapacity={} flushDocs={} flushIntervalMs={}",
            props.getQueueCapacity(), props.getFlushDocs(), props.getFlushIntervalMs());
    }

    /** Non-blocking. Called from the consumer's hot path (§7 step 5) -- never waits on I/O. */
    public void enqueue(Document doc) {
        boolean accepted = queue.offer(doc);
        if (!accepted) {
            long total = dropped.incrementAndGet();
            log.warn("MongoBulkWriter queue full (capacity={}) -- dropping txn {} (recoverable from txn:stream, MAXLEN~100k); total dropped={}",
                props.getQueueCapacity(), doc.getString("txnId"), total);
            return;
        }
        if (queue.size() >= props.getFlushDocs()) {
            // Count-based trigger; the scheduled task above is the time-based one.
            flusher.execute(this::flush);
        }
    }

    private synchronized void flush() {
        List<Document> batch = new ArrayList<>(props.getFlushDocs());
        queue.drainTo(batch, props.getFlushDocs());
        if (batch.isEmpty()) {
            return;
        }

        List<WriteModel<Document>> models = new ArrayList<>(batch.size());
        for (Document d : batch) {
            models.add(new ReplaceOneModel<>(
                Filters.eq("txnId", d.getString("txnId")), d, new ReplaceOptions().upsert(true)));
        }

        long start = System.nanoTime();
        try {
            MongoCollection<Document> coll = mongoTemplate.getCollection(COLLECTION).withWriteConcern(WriteConcern.W1);
            coll.bulkWrite(models, new BulkWriteOptions().ordered(false));
            flushCount.incrementAndGet();
            flushedDocs.addAndGet(batch.size());
            lastFlushMs.set((System.nanoTime() - start) / 1_000_000);
        } catch (MongoBulkWriteException e) {
            // Unordered: the rest of the batch still applied. Log and move on --
            // a single malformed document must not stall the buffer.
            log.error("Bulk write partial failure: {} write error(s) out of {} docs",
                e.getWriteErrors().size(), batch.size(), e);
            flushCount.incrementAndGet();
            flushedDocs.addAndGet(batch.size() - e.getWriteErrors().size());
        }
    }

    @PreDestroy
    void shutdown() {
        log.info("MongoBulkWriter shutting down -- draining {} queued docs", queue.size());
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
    public long flushedDocs() { return flushedDocs.get(); }
    public long dropped() { return dropped.get(); }
    public long lastFlushMs() { return lastFlushMs.get(); }
}
