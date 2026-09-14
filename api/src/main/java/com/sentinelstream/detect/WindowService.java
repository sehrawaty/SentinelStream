package com.sentinelstream.detect;

import com.sentinelstream.consumer.RedisKeysProperties;
import org.springframework.data.geo.Point;
import org.springframework.data.redis.connection.StringRedisConnection;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

/**
 * CLAUDE.md §7 step 3 -- window updates, pipelined into a single round trip.
 * Trim-then-add per key so every window stays bounded on every write; step 4
 * (detectors) reads the result without needing to trim again.
 *
 * Read-side helpers used by the detectors (§4.1: velocity 60s, amount 3600s
 * card-window TTL with a 20-sample cap, fan-out 600s) live here too, since
 * they operate on the same keys this class owns.
 */
@Component
public class WindowService {

    private final StringRedisTemplate redis;
    private final RedisKeysProperties keysProps;
    private final RulesProperties rulesProps;

    public WindowService(StringRedisTemplate redis, RedisKeysProperties keysProps, RulesProperties rulesProps) {
        this.redis = redis;
        this.keysProps = keysProps;
        this.rulesProps = rulesProps;
    }

    public String cardTxnsKey(String cardId) { return "card:" + cardId + ":txns"; }
    public String cardAmtsKey(String cardId) { return "card:" + cardId + ":amts"; }
    public String cardGeoKey(String cardId) { return "card:" + cardId + ":geo"; }
    public String deviceKey(String deviceId) { return "device:" + deviceId + ":cards"; }
    public String ipKey(String ip) { return "ip:" + ip + ":cards"; }

    /** Step 3: pipelined trim + add + expire. Single round trip, no blocking I/O interleaved. */
    public void updateWindows(String cardId, String deviceId, String ip, String txnId,
                               double amount, double lat, double lon, long ts) {
        String cardTxns = cardTxnsKey(cardId);
        String cardAmts = cardAmtsKey(cardId);
        String cardGeo = cardGeoKey(cardId);
        String device = deviceKey(deviceId);
        String ipK = ipKey(ip);

        long velocityFloor = ts - rulesProps.getVelocity().getWindowSeconds() * 1000L;
        long fanoutFloor = ts - rulesProps.getFanout().getWindowSeconds() * 1000L;
        // Amount window is the card TTL window (3600s), not a rules-threshold window --
        // the sample-count cap (20) is what actually bounds AMOUNT_ANOMALY's baseline.
        long amountFloor = ts - keysProps.getCardWindowTtl() * 1000L;

        redis.executePipelined((org.springframework.data.redis.core.RedisCallback<Object>) connection -> {
            StringRedisConnection c = (StringRedisConnection) connection;

            c.zRemRangeByScore(cardTxns, Double.NEGATIVE_INFINITY, velocityFloor);
            c.zRemRangeByScore(cardAmts, Double.NEGATIVE_INFINITY, amountFloor);
            c.zRemRangeByScore(device, Double.NEGATIVE_INFINITY, fanoutFloor);
            c.zRemRangeByScore(ipK, Double.NEGATIVE_INFINITY, fanoutFloor);

            c.zAdd(cardTxns, ts, txnId);
            c.zAdd(cardAmts, ts, txnId + "|" + amount);
            c.geoAdd(cardGeo, new Point(lon, lat), txnId);
            c.zAdd(device, ts, cardId);
            c.zAdd(ipK, ts, cardId);
            c.incr("metrics:txn:" + (ts / 60000));

            c.expire(cardTxns, keysProps.getCardWindowTtl());
            c.expire(cardAmts, keysProps.getCardWindowTtl());
            c.expire(cardGeo, keysProps.getCardWindowTtl());
            c.expire(device, keysProps.getEntityWindowTtl());
            c.expire(ipK, keysProps.getEntityWindowTtl());
            c.expire("metrics:txn:" + (ts / 60000), 300);

            return null;
        });
    }
}
