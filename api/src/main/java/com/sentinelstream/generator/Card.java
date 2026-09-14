package com.sentinelstream.generator;

import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

/**
 * A card's fixed identity for the lifetime of the generator process: home
 * device, home IP set, home city (CLAUDE.md §8 D-19 — travel safety: baseline
 * traffic never leaves the home city), and a cooldown clock enforcing the
 * hard 20s per-card floor that keeps VELOCITY structurally unreachable by
 * benign traffic.
 */
public final class Card {

    private final String cardId;
    private final String homeDeviceId;
    private final List<String> homeIpIds;
    private final ReferenceData.City homeCity;
    private final AtomicLong lastTxnAtMillis;

    public Card(String cardId, String homeDeviceId, List<String> homeIpIds, ReferenceData.City homeCity) {
        this.cardId = cardId;
        this.homeDeviceId = homeDeviceId;
        this.homeIpIds = homeIpIds;
        this.homeCity = homeCity;
        // Backdated so every card is immediately eligible when the generator starts.
        this.lastTxnAtMillis = new AtomicLong(0L);
    }

    public String cardId() { return cardId; }
    public String homeDeviceId() { return homeDeviceId; }
    public List<String> homeIpIds() { return homeIpIds; }
    public ReferenceData.City homeCity() { return homeCity; }

    public boolean isEligible(long now, long minGapMs) {
        return now - lastTxnAtMillis.get() >= minGapMs;
    }

    /** Atomically claims this card for "now" iff it is still eligible. */
    public boolean tryClaim(long now, long minGapMs) {
        long prev = lastTxnAtMillis.get();
        if (now - prev < minGapMs) {
            return false;
        }
        return lastTxnAtMillis.compareAndSet(prev, now);
    }
}
