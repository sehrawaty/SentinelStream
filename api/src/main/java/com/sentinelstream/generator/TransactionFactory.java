package com.sentinelstream.generator;

import org.springframework.stereotype.Component;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Map.Entry;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Collectors;

/**
 * Builds the flat field map written to each `txn:stream` entry. Benign
 * transactions always use the card's home device/IP/city (CLAUDE.md §8 D-19
 * travel safety); only the injectors (added in a later slice) deliberately
 * break that pattern to trigger a detector.
 */
@Component
public class TransactionFactory {

    private final EntityPool pool;
    private final AtomicLong seq = new AtomicLong(0);
    private final String runId = Long.toString(System.currentTimeMillis(), 36).toUpperCase();

    private final Map<String, ReferenceData.CategorySpec> categoryByName;

    public TransactionFactory(EntityPool pool) {
        this.pool = pool;
        this.categoryByName = ReferenceData.CATEGORIES.stream()
            .collect(Collectors.toMap(ReferenceData.CategorySpec::category, c -> c,
                (a, b) -> a, LinkedHashMap::new));
    }

    /** A benign transaction for {@code card}, using its home entities. */
    public Map<String, String> benign(Card card) {
        Merchant merchant = pool.randomMerchant();
        ReferenceData.CategorySpec spec = categoryByName.get(merchant.category());
        double amount = drawAmount(spec);
        String ip = card.homeIpIds().get(ThreadLocalRandom.current().nextInt(card.homeIpIds().size()));

        return fields(card.cardId(), amount, merchant, card.homeCity(), card.homeDeviceId(), ip,
            System.currentTimeMillis(), false);
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

    private double drawAmount(ReferenceData.CategorySpec spec) {
        double mu = Math.log(spec.meanAmount());
        double gaussian = ThreadLocalRandom.current().nextGaussian();
        double amount = Math.exp(mu + spec.sigma() * gaussian);
        amount = Math.max(spec.minAmount(), Math.min(spec.maxAmount(), amount));
        return Math.round(amount * 100.0) / 100.0;
    }
}
