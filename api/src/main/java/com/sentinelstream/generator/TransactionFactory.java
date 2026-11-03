package com.sentinelstream.generator;

import com.sentinelstream.detect.WindowService;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Builds the flat field map written to each `txn:stream` entry. Benign
 * transactions always use the card's home device/IP/city (CLAUDE.md §8 D-19
 * travel safety); only the injectors (added in a later slice) deliberately
 * break that pattern to trigger a detector.
 */
@Component
public class TransactionFactory {

    private final EntityPool pool;
    private final GeneratorProperties props;
    private final StringRedisTemplate redis;
    private final WindowService windows;
    private final AtomicLong seq = new AtomicLong(0);
    private final String runId = Long.toString(System.currentTimeMillis(), 36).toUpperCase();

    public TransactionFactory(EntityPool pool, GeneratorProperties props, StringRedisTemplate redis,
                              WindowService windows) {
        this.pool = pool;
        this.props = props;
        this.redis = redis;
        this.windows = windows;
    }

    /**
     * A benign transaction for {@code card}, using its home entities. About one
     * in {@code 1/overspendRate} is a genuine overspend instead -- the organic
     * trickle that keeps AMOUNT_ANOMALY visibly alive (§8 D-35).
     */
    public Map<String, String> benign(Card card) {
        if (ThreadLocalRandom.current().nextDouble() < props.getOverspendRate()) {
            return overspend(card);
        }
        return everyday(card);
    }

    /** An ordinary purchase: a typical amount at one of the card's usual merchants. */
    public Map<String, String> everyday(Card card) {
        return homeTransaction(card, typicalAmount(card), pick(card.homeMerchants()));
    }

    /**
     * One transaction at 3x-4.5x the card's typical ticket, from a merchant that
     * sells at that price where one exists. The card's ordinary amounts top out
     * at (1 + spread) x ticket, so this always clears mean + 3 sigma of them.
     */
    public Map<String, String> overspend(Card card) {
        primeFromRedis(card);
        double amount = card.spend(card.typicalTicket() * ThreadLocalRandom.current().nextDouble(3.0, 4.5),
            Double.POSITIVE_INFINITY);
        List<Merchant> fitting = pool.merchantsNear(amount);
        return homeTransaction(card, amount, pick(fitting.isEmpty() ? card.homeMerchants() : fitting));
    }

    /**
     * An everyday amount for {@code card}: uniform within +/- spread of its
     * typical ticket, and never above the card's own cap (see {@link Card#spend}).
     * Injectors use this too, so an injected pattern fires its own rule and
     * does not pick up AMOUNT_ANOMALY by accident.
     */
    public double typicalAmount(Card card) {
        primeFromRedis(card);
        double spread = props.getAmountSpread();
        double drawn = card.typicalTicket() * ThreadLocalRandom.current().nextDouble(1 - spread, 1 + spread);
        return card.spend(drawn, props.getAmountCapSigma());
    }

    /** True once {@code card} has the five prior amounts AMOUNT_ANOMALY needs before it can fire. */
    public boolean hasAmountBaseline(Card card) {
        primeFromRedis(card);
        return card.hasAmountBaseline();
    }

    /** One ZRANGE per card, the first time it is used after boot -- see {@link Card#prime}. */
    private void primeFromRedis(Card card) {
        if (card.isPrimed()) {
            return;
        }
        List<Double> amounts = new ArrayList<>();
        try {
            Set<String> newest = redis.opsForZSet().range(windows.cardAmtsKey(card.cardId()), -20, -1);
            if (newest != null) {
                for (String entry : newest) { // member is "{txnId}|{amount}", §4.1
                    amounts.add(Double.parseDouble(entry.substring(entry.indexOf('|') + 1)));
                }
            }
        } catch (RuntimeException e) {
            amounts.clear(); // Redis unreachable or an unparseable member: start this card from empty
        }
        card.prime(amounts);
    }

    private Map<String, String> homeTransaction(Card card, double amount, Merchant merchant) {
        String ip = pick(card.homeIpIds());
        return fields(card.cardId(), amount, merchant, card.homeCity(), card.homeDeviceId(), ip,
            System.currentTimeMillis(), false);
    }

    private static <T> T pick(List<T> items) {
        return items.get(ThreadLocalRandom.current().nextInt(items.size()));
    }

    /** Used by injectors (added in the detector slice) that need to control every field. */
    public Map<String, String> custom(String cardId, double amount, Merchant merchant,
                                       ReferenceData.City city, String deviceId, String ip, long tsMillis) {
        return fields(cardId, amount, merchant, city, deviceId, ip, tsMillis, true);
    }

    private Map<String, String> fields(String cardId, double amount, Merchant merchant,
                                        ReferenceData.City city, String deviceId, String ip,
                                        long tsMillis, boolean injected) {
        Map<String, String> f = new LinkedHashMap<>();
        f.put("txnId", nextTxnId());
        f.put("cardId", cardId);
        f.put("amount", String.format(java.util.Locale.ROOT, "%.2f", amount));
        f.put("currency", "INR");
        f.put("ts", Long.toString(tsMillis));
        f.put("merchantId", merchant.id());
        f.put("merchantName", merchant.name());
        f.put("merchantCategory", merchant.category());
        f.put("mcc", merchant.mcc());
        f.put("city", city.name());
        f.put("lat", Double.toString(city.lat()));
        f.put("lon", Double.toString(city.lon()));
        f.put("deviceId", deviceId);
        f.put("ip", ip);
        f.put("injected", Boolean.toString(injected));
        return f;
    }

    private String nextTxnId() {
        return "T-" + runId + "-" + String.format("%08d", seq.incrementAndGet());
    }

}
