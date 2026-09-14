package com.sentinelstream.detect;

import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * CLAUDE.md §5 AMOUNT_ANOMALY: current amount > mean + sigma*stddev over the
 * card's prior sampleSize transactions (min minSamples). The current sample
 * is excluded from its own baseline -- comparing a value against a mean that
 * already includes it dilutes exactly the outliers this rule exists to catch.
 */
@Component
public class AmountAnomalyDetector {

    private final StringRedisTemplate redis;
    private final WindowService windows;
    private final RulesProperties props;

    public AmountAnomalyDetector(StringRedisTemplate redis, WindowService windows, RulesProperties props) {
        this.redis = redis;
        this.windows = windows;
        this.props = props;
    }

    public Optional<DetectorResult> evaluate(String cardId, String currentTxnId, double currentAmount) {
        int sampleSize = props.getAmount().getSampleSize();
        // Fetch one extra in case the current entry is among the most recent.
        Set<String> raw = redis.opsForZSet().reverseRange(windows.cardAmtsKey(cardId), 0, sampleSize);
        if (raw == null) {
            return Optional.empty();
        }

        List<Double> priorAmounts = new ArrayList<>(sampleSize);
        for (String entry : raw) {
            int sep = entry.indexOf('|');
            if (sep < 0) continue;
            String txnId = entry.substring(0, sep);
            if (txnId.equals(currentTxnId)) {
                continue; // exclude current sample from its own baseline
            }
            priorAmounts.add(Double.parseDouble(entry.substring(sep + 1)));
            if (priorAmounts.size() >= sampleSize) break;
        }

        if (priorAmounts.size() < props.getAmount().getMinSamples()) {
            return Optional.empty(); // not enough history to judge an anomaly
        }

        double mean = priorAmounts.stream().mapToDouble(Double::doubleValue).average().orElse(0);
        double variance = priorAmounts.stream()
            .mapToDouble(a -> (a - mean) * (a - mean))
            .average().orElse(0);
        double stddev = Math.sqrt(variance);
        double threshold = mean + props.getAmount().getSigma() * stddev;

        if (currentAmount <= threshold) {
            return Optional.empty();
        }

        Map<String, Object> evidence = new LinkedHashMap<>();
        evidence.put("amount", currentAmount);
        evidence.put("mean", round2(mean));
        evidence.put("stddev", round2(stddev));
        evidence.put("sigma", props.getAmount().getSigma());
        evidence.put("threshold", round2(threshold));
        evidence.put("sampleSize", priorAmounts.size());
        return Optional.of(new DetectorResult("AMOUNT_ANOMALY", props.getAmount().getWeight(), evidence));
    }

    private double round2(double v) {
        return Math.round(v * 100.0) / 100.0;
    }
}
