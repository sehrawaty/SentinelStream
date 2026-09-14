package com.sentinelstream.detect;

import com.sentinelstream.generator.ReferenceData;
import org.springframework.data.geo.Distance;
import org.springframework.data.geo.Metrics;
import org.springframework.data.geo.Point;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ZSetOperations.TypedTuple;
import org.springframework.stereotype.Component;

import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * CLAUDE.md §5 IMPOSSIBLE_TRAVEL, redesigned per §8 D-20: reads the two most
 * recent members of card:{c}:txns (this txn plus the one before it) and
 * calls GEODIST on card:{c}:geo between them -- a literal Redis GEODIST
 * call, not a manually-parsed "last point" string, and with no read-before-
 * write ordering hazard against the frozen step-3-then-step-4 order.
 */
@Component
public class ImpossibleTravelDetector {

    private final StringRedisTemplate redis;
    private final WindowService windows;
    private final RulesProperties props;

    public ImpossibleTravelDetector(StringRedisTemplate redis, WindowService windows, RulesProperties props) {
        this.redis = redis;
        this.windows = windows;
        this.props = props;
    }

    public Optional<DetectorResult> evaluate(String cardId, String currentTxnId, String currentCity) {
        Set<TypedTuple<String>> last2 = redis.opsForZSet()
            .reverseRangeWithScores(windows.cardTxnsKey(cardId), 0, 1);
        if (last2 == null || last2.size() < 2) {
            return Optional.empty(); // first transaction for this card -- nothing to compare against
        }

        Iterator<TypedTuple<String>> it = last2.iterator();
        TypedTuple<String> current = it.next();
        TypedTuple<String> previous = it.next();
        if (!currentTxnId.equals(current.getValue())) {
            return Optional.empty(); // defensive: current entry should always be first
        }

        String prevTxnId = previous.getValue();
        long currentTs = current.getScore().longValue();
        long prevTs = previous.getScore().longValue();
        long deltaMs = currentTs - prevTs;
        if (deltaMs <= 0) {
            return Optional.empty();
        }

        Distance distance = redis.opsForGeo().distance(
            windows.cardGeoKey(cardId), prevTxnId, currentTxnId, Metrics.KILOMETERS);
        if (distance == null) {
            return Optional.empty(); // one of the two geo members already expired/evicted
        }
        double km = distance.getValue();
        double hours = deltaMs / 3_600_000.0;
        double impliedKmh = km / hours;

        if (km < props.getTravel().getMinKm() || impliedKmh <= props.getTravel().getThresholdKmh()) {
            return Optional.empty();
        }

        String fromCity = resolveCity(cardId, prevTxnId);

        Map<String, Object> evidence = new LinkedHashMap<>();
        evidence.put("fromCity", fromCity);
        evidence.put("toCity", currentCity);
        evidence.put("km", round1(km));
        evidence.put("seconds", round1(deltaMs / 1000.0));
        evidence.put("impliedKmh", round1(impliedKmh));
        evidence.put("threshold", props.getTravel().getThresholdKmh());
        return Optional.of(new DetectorResult("IMPOSSIBLE_TRAVEL", props.getTravel().getWeight(), evidence));
    }

    private double round1(double v) {
        return Math.round(v * 10.0) / 10.0;
    }

    /**
     * GEOPOS round-trips through Redis's geohash encoding (~1.2m precision),
     * so the returned coordinates aren't bit-exact to the pinned city list --
     * nearest-match is exact in practice since the 12 cities (§4.6) are
     * hundreds of km apart.
     */
    private String resolveCity(String cardId, String txnId) {
        List<Point> points = redis.opsForGeo().position(windows.cardGeoKey(cardId), txnId);
        if (points == null || points.isEmpty() || points.get(0) == null) {
            return "UNKNOWN";
        }
        Point p = points.get(0);
        ReferenceData.City nearest = null;
        double best = Double.MAX_VALUE;
        for (ReferenceData.City city : ReferenceData.CITIES) {
            double dLat = city.lat() - p.getY();
            double dLon = city.lon() - p.getX();
            double sq = dLat * dLat + dLon * dLon;
            if (sq < best) {
                best = sq;
                nearest = city;
            }
        }
        return nearest == null ? "UNKNOWN" : nearest.name();
    }
}
