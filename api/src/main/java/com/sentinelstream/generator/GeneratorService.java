package com.sentinelstream.generator;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.data.redis.connection.stream.MapRecord;
import org.springframework.data.redis.connection.stream.RecordId;
import org.springframework.data.redis.connection.stream.StreamRecords;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * CLAUDE.md §4.1 — the generator's only job is XADD onto txn:stream.
 * Everything downstream (consumer group, detectors, persistence) is a
 * separate slice; this component does not know they exist.
 *
 * Runs a fixed-rate tick (100ms) emitting ratePerSecond/10 transactions per
 * tick — 150/10 = 15, an exact split at the default rate. Card selection
 * enforces the hard cooldown from §8 D-19 via {@link Card#tryClaim}.
 */
@Component
@EnableConfigurationProperties({GeneratorProperties.class, StreamProperties.class})
public class GeneratorService {

    private static final Logger log = LoggerFactory.getLogger(GeneratorService.class);
    private static final long TICK_MS = 100;

    private final StringRedisTemplate redis;
    private final EntityPool pool;
    private final TransactionFactory factory;
    private final GeneratorProperties genProps;
    private final StreamProperties streamProps;

    private final AtomicBoolean paused = new AtomicBoolean(false);
    private final AtomicLong emittedTotal = new AtomicLong(0);
    private final AtomicLong emittedSinceLastLog = new AtomicLong(0);

    public GeneratorService(StringRedisTemplate redis, EntityPool pool, TransactionFactory factory,
                             GeneratorProperties genProps, StreamProperties streamProps) {
        this.redis = redis;
        this.pool = pool;
        this.factory = factory;
        this.genProps = genProps;
        this.streamProps = streamProps;
    }

    @Scheduled(fixedRate = TICK_MS)
    public void tick() {
        if (paused.get()) {
            return;
        }
        int perTick = Math.max(1, Math.round(genProps.getRatePerSecond() * (TICK_MS / 1000f)));
        long now = System.currentTimeMillis();

        for (int i = 0; i < perTick; i++) {
            Card card = claimEligibleCard(now);
            if (card == null) {
                continue; // pool momentarily saturated — see §8 D-19 headroom note; expected to be rare
            }
            Map<String, String> fields = factory.benign(card);
            addToStream(fields);
        }
    }

    /** Bounded rejection sampling over the cooldown (§8 D-19). Pool has ~33% headroom. */
    private Card claimEligibleCard(long now) {
        int maxAttempts = 50;
        for (int i = 0; i < maxAttempts; i++) {
            Card candidate = pool.randomCard();
            if (candidate.tryClaim(now, genProps.getMinTxnGapMs())) {
                return candidate;
            }
        }
        return null;
    }

    public RecordId addToStream(Map<String, String> fields) {
        MapRecord<String, String, String> record = StreamRecords.newRecord()
            .in(streamProps.getKey())
            .ofMap(fields);

        RecordId id = redis.<String, String>opsForStream().add(record);

        long total = emittedTotal.incrementAndGet();
        if (emittedSinceLastLog.incrementAndGet() >= 1000) {
            emittedSinceLastLog.set(0);
            log.info("txn:stream — {} transactions emitted so far", total);
        }
        // Trim periodically rather than on every XADD — MAXLEN §4.1. Exact trim
        // (not "~" approximate) is fine at this scale; the retention guarantee
        // is the point, not shaving the O(log N) housekeeping cost.
        if (total % 500 == 0) {
            redis.<String, String>opsForStream().trim(streamProps.getKey(), streamProps.getMaxlen());
        }
        return id;
    }

    public void pause() {
        paused.set(true);
        log.info("Generator paused");
    }

    public void resume() {
        paused.set(false);
        log.info("Generator resumed");
    }

    public boolean isPaused() {
        return paused.get();
    }

    public long emittedTotal() {
        return emittedTotal.get();
    }
}
