package com.sentinelstream.detect;

import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

/**
 * CLAUDE.md §5 ENTITY_FANOUT: a device OR an IP with >= minCards distinct
 * cards within windowSeconds. ZADD with the same member (cardId) just moves
 * its score, so ZCARD is already a distinct-card count -- no dedup needed.
 *
 * This is the handoff point (spec §4 "the handoff worth narrating"): firing
 * here is what triggers the async ring query once Slice 12 wires it in.
 */
@Component
public class EntityFanoutDetector {

    private final StringRedisTemplate redis;
    private final WindowService windows;
    private final RulesProperties props;

    public EntityFanoutDetector(StringRedisTemplate redis, WindowService windows, RulesProperties props) {
        this.redis = redis;
        this.windows = windows;
        this.props = props;
    }

    public Optional<DetectorResult> evaluate(String deviceId, String ip) {
        Long deviceCount = redis.opsForZSet().zCard(windows.deviceKey(deviceId));
        Long ipCount = redis.opsForZSet().zCard(windows.ipKey(ip));
        long dc = deviceCount == null ? 0 : deviceCount;
        long ic = ipCount == null ? 0 : ipCount;
        int threshold = props.getFanout().getMinCards();

        boolean deviceFired = dc >= threshold;
        boolean ipFired = ic >= threshold;
        if (!deviceFired && !ipFired) {
            return Optional.empty();
        }

        Map<String, Object> evidence = new LinkedHashMap<>();
        evidence.put("windowSec", props.getFanout().getWindowSeconds());
        evidence.put("threshold", threshold);
        if (deviceFired) {
            evidence.put("deviceId", deviceId);
            evidence.put("deviceCardCount", dc);
        }
        if (ipFired) {
            evidence.put("ip", ip);
            evidence.put("ipCardCount", ic);
        }
        return Optional.of(new DetectorResult("ENTITY_FANOUT", props.getFanout().getWeight(), evidence));
    }
}
