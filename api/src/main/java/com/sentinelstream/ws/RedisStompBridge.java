package com.sentinelstream.ws;

import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.connection.Message;
import org.springframework.data.redis.connection.MessageListener;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.listener.ChannelTopic;
import org.springframework.data.redis.listener.RedisMessageListenerContainer;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Component;

/**
 * CLAUDE.md §4.1 / §6 -- bridges the two "fires occasionally, needs a
 * live-UI nudge" Redis Pub/Sub channels onto their STOMP topics. This is
 * deliberately the only place that knows both {@code alerts:live}/
 * {@code rings:live} exist AND that /ws exists; the consumer (step 9) and
 * {@link com.sentinelstream.graph.RingQueryTrigger} (step 8) only know
 * about Redis PUBLISH, same as before this slice -- decoupling the hot
 * path from whether any browser is even connected.
 *
 * Payloads are already JSON text (built by the publisher); relayed verbatim,
 * no parse/re-serialise round trip.
 */
@Component
public class RedisStompBridge implements MessageListener {

    private static final Logger log = LoggerFactory.getLogger(RedisStompBridge.class);
    private static final String ALERTS_CHANNEL = "alerts:live";
    private static final String RINGS_CHANNEL = "rings:live";

    private final RedisConnectionFactory connectionFactory;
    private final SimpMessagingTemplate stomp;
    private RedisMessageListenerContainer container;

    public RedisStompBridge(RedisConnectionFactory connectionFactory, SimpMessagingTemplate stomp) {
        this.connectionFactory = connectionFactory;
        this.stomp = stomp;
    }

    @PostConstruct
    void start() {
        container = new RedisMessageListenerContainer();
        container.setConnectionFactory(connectionFactory);
        container.addMessageListener(this, new ChannelTopic(ALERTS_CHANNEL));
        container.addMessageListener(this, new ChannelTopic(RINGS_CHANNEL));
        container.afterPropertiesSet();
        container.start();
        log.info("RedisStompBridge subscribed to '{}' and '{}'", ALERTS_CHANNEL, RINGS_CHANNEL);
    }

    @PreDestroy
    void stop() {
        if (container != null) {
            container.stop();
        }
    }

    @Override
    public void onMessage(Message message, byte[] pattern) {
        String channel = new String(message.getChannel());
        String payload = new String(message.getBody());
        String topic = switch (channel) {
            case ALERTS_CHANNEL -> "/topic/alerts";
            case RINGS_CHANNEL -> "/topic/rings";
            default -> null;
        };
        if (topic == null) {
            return;
        }
        try {
            stomp.convertAndSend(topic, payload);
        } catch (Exception e) {
            // Best-effort, same as the original PUBLISH (consumer §7 comment) --
            // the underlying record is already durably persisted; a missed relay
            // only costs a live-UI nudge, never data.
            log.warn("Failed to relay {} onto {}", channel, topic, e);
        }
    }
}
