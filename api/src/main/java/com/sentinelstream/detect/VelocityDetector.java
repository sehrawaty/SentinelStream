package com.sentinelstream.detect;

import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

/**
 * CLAUDE.md §5 VELOCITY: >= count transactions for one card within
 * windowSeconds. Step 3 has already trimmed+added, so ZCARD directly reads
 * the current window size -- O(1) sorted-set cardinality, no table scan.
 */
@Component
public class VelocityDetector {

    private final StringRedisTemplate redis;
    private final WindowService windows;
    private final RulesProperties props;

    public VelocityDetector(StringRedisTemplate redis, WindowService windows, RulesProperties props) {
        this.redis = redis;
        this.windows = windows;
        this.props = props;
    }

    public Optional<DetectorResult> evaluate(String cardId) {
        Long count = redis.opsForZSet().zCard(windows.cardTxnsKey(cardId));
        long c = count == null ? 0 : count;
        if (c < props.getVelocity().getCount()) {
            return Optional.empty();
        }
        Map<String, Object> evidence = new LinkedHashMap<>();
        evidence.put("count", c);
        evidence.put("windowSec", props.getVelocity().getWindowSeconds());
        evidence.put("threshold", props.getVelocity().getCount());
        return Optional.of(new DetectorResult("VELOCITY", props.getVelocity().getWeight(), evidence));
    }
}
