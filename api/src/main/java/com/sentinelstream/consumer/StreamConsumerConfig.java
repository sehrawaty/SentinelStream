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

        subscription = container.receive(
            Consumer.from(streamProps.getConsumerGroup(), consumerName),
            StreamOffset.create(streamProps.getKey(), ReadOffset.lastConsumed()),
            processor::process);

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
            log.warn("Could not read pending entries for reclaim: {}", e.getMessage());
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
}
