package com.sentinelstream.consumer;

import com.sentinelstream.generator.StreamProperties;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.data.redis.RedisSystemException;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.connection.stream.Consumer;
import org.springframework.data.redis.connection.stream.MapRecord;
import org.springframework.data.redis.connection.stream.PendingMessage;
import org.springframework.data.redis.connection.stream.PendingMessages;
import org.springframework.data.redis.connection.stream.ReadOffset;
import org.springframework.data.redis.connection.stream.RecordId;
import org.springframework.data.redis.connection.stream.StreamOffset;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.stream.StreamMessageListenerContainer;
import org.springframework.data.redis.stream.StreamMessageListenerContainer.StreamMessageListenerContainerOptions;
import org.springframework.data.redis.stream.Subscription;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.List;

/**
 * CLAUDE.md §7 — consumer group `fraud-detectors` against `txn:stream`.
 *
 * Manual acknowledgement only (never auto-ack): {@link TransactionConsumer}
 * calls XACK explicitly as step 10, after everything else has succeeded.
 * A message that fails mid-processing, or a consumer that dies before
 * acking, leaves its entry in the PEL — {@link #reclaimStale()} claims and
 * reprocesses anything idle more than 60s, every 30s, per §7's "why XACK
 * last" note and the §10 viva answer on XPENDING/XAUTOCLAIM.
 */
@Component
@EnableConfigurationProperties(StreamProperties.class)
public class StreamConsumerConfig {

    private static final Logger log = LoggerFactory.getLogger(StreamConsumerConfig.class);
    private static final Duration RECLAIM_MIN_IDLE = Duration.ofSeconds(60);

    private final RedisConnectionFactory connectionFactory;
    private final StringRedisTemplate redis;
    private final StreamProperties streamProps;
    private final TransactionConsumer processor;
    private final String consumerName;

    private StreamMessageListenerContainer<String, MapRecord<String, String, String>> container;
    private Subscription subscription;

    public StreamConsumerConfig(RedisConnectionFactory connectionFactory, StringRedisTemplate redis,
                                 StreamProperties streamProps, TransactionConsumer processor,
                                 @Value("${CONSUMER_NAME:consumer-1}") String consumerName) {
        this.connectionFactory = connectionFactory;
        this.redis = redis;
        this.streamProps = streamProps;
        this.processor = processor;
        this.consumerName = consumerName;
    }

    @PostConstruct
    void start() {
        ensureGroupExists();

        StreamMessageListenerContainerOptions<String, MapRecord<String, String, String>> options =
            StreamMessageListenerContainerOptions.builder()
                .pollTimeout(Duration.ofMillis(500))
                .build();

        container = StreamMessageListenerContainer.create(connectionFactory, options);

        // Built explicitly (not container.receive(...)) so cancelOnError can be
        // overridden -- §8 D-32. The container's default StreamReadRequest cancels
        // the whole subscription permanently on its FIRST read error, of any kind.
        // A `seed.mjs --wipe` FLUSHDB while this subscription is live throws NOGROUP
        // on the very next poll, which killed the subscription outright: no more
        // polls, ever, group-recreation in reclaimStale() notwithstanding, since
        // there was nothing left running to benefit from a recreated group. Caught
        // live: after the group self-heal below started firing, "Processed" logs
        // never resumed and XINFO GROUPS showed consumers=0 -- the read task itself
        // was gone, not just erroring. cancelOnError(t -> false) keeps the poll loop
        // alive through NOGROUP (and any other transient read error); the next poll
        //500ms later succeeds as soon as the group exists again.
        StreamMessageListenerContainer.StreamReadRequest<String> request =
            StreamMessageListenerContainer.StreamReadRequest.builder(
                    StreamOffset.<String>create(streamProps.getKey(), ReadOffset.lastConsumed()))
                .consumer(Consumer.from(streamProps.getConsumerGroup(), consumerName))
                .autoAcknowledge(false)
                .cancelOnError(t -> false)
                .errorHandler(t -> log.warn("Stream poll error (subscription stays alive): {}", t.getMessage()))
                .build();

        subscription = container.register(request, processor::process);

        container.start();
        log.info("Consumer '{}' subscribed to '{}' as group '{}'",
            consumerName, streamProps.getKey(), streamProps.getConsumerGroup());
    }

    @PreDestroy
    void stop() {
        if (container != null) {
            container.stop();
        }
    }

    private void ensureGroupExists() {
        try {
            // Spring Data Redis's high-level createGroup implies MKSTREAM, so this
            // works even before the generator's first XADD creates the stream.
            redis.opsForStream().createGroup(streamProps.getKey(), streamProps.getConsumerGroup());
            log.info("Created consumer group '{}' on '{}'", streamProps.getConsumerGroup(), streamProps.getKey());
        } catch (RedisSystemException e) {
            if (e.getCause() != null && e.getCause().getMessage() != null
                && e.getCause().getMessage().contains("BUSYGROUP")) {
                log.info("Consumer group '{}' already exists — reusing", streamProps.getConsumerGroup());
            } else {
                throw e;
            }
        }
    }

    /**
     * §7 crash-recovery mechanism: entries pending (read but never XACK'd) for
     * more than {@link #RECLAIM_MIN_IDLE} are claimed by this consumer and
     * reprocessed through the same {@link TransactionConsumer#process} path —
     * idempotency (step 2) is what makes reprocessing safe.
     */
    @Scheduled(fixedRate = 30_000)
    public void reclaimStale() {
        PendingMessages pending;
        try {
            pending = redis.opsForStream().pending(
                streamProps.getKey(), streamProps.getConsumerGroup(),
                org.springframework.data.domain.Range.unbounded(), 100);
        } catch (Exception e) {
            // §8 D-32 -- a `FLUSHDB` (e.g. scripts/seed.mjs --wipe) run against an
            // already-subscribed consumer deletes txn:stream and its group out from
            // under the live StreamMessageListenerContainer. The container's own
            // poll loop does NOT recreate the group and errors silently forever;
            // this was caught live as a growing, unprocessed XLEN with zero
            // "Processed" log lines. Confirmed live that the container itself needs
            // nothing more than the group existing again to resume on its own next
            // poll -- so recreating it here, the next time this task runs, is a
            // complete self-heal with no restart required.
            // The driver wraps this several layers deep (top-level message is just
            // "Error in execution"; NOGROUP is on a nested cause) -- caught live via
            // the top-level message NOT containing "NOGROUP" at all, so the first
            // version of this check never matched. Walk the cause chain instead.
            if (containsNoGroup(e)) {
                log.warn("Consumer group '{}' missing on '{}' (stream was likely flushed externally) "
                    + "-- recreating so the live subscription can resume", streamProps.getConsumerGroup(), streamProps.getKey());
                ensureGroupExists();
            } else {
                log.warn("Could not read pending entries for reclaim: {}", e.getMessage());
            }
            return;
        }
        if (pending == null || pending.isEmpty()) {
            return;
        }

        List<RecordId> staleIds = pending.stream()
            .filter(m -> m.getElapsedTimeSinceLastDelivery().compareTo(RECLAIM_MIN_IDLE) >= 0)
            .map(PendingMessage::getId)
            .toList();

        if (staleIds.isEmpty()) {
            return;
        }

        log.warn("Reclaiming {} stale pending entries idle >= {}s", staleIds.size(), RECLAIM_MIN_IDLE.getSeconds());

        List<MapRecord<String, Object, Object>> claimed = redis.opsForStream().claim(
            streamProps.getKey(), streamProps.getConsumerGroup(), consumerName,
            RECLAIM_MIN_IDLE, staleIds.toArray(new RecordId[0]));

        for (MapRecord<String, Object, Object> raw : claimed) {
            @SuppressWarnings("unchecked")
            MapRecord<String, String, String> record = (MapRecord<String, String, String>) (MapRecord<String, ?, ?>) raw;
            processor.process(record);
        }
    }

    private static boolean containsNoGroup(Throwable t) {
        for (Throwable cur = t; cur != null; cur = cur.getCause()) {
            if (cur.getMessage() != null && cur.getMessage().contains("NOGROUP")) {
                return true;
            }
        }
        return false;
    }
}
