package com.sentinelstream.generator;

import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

/**
 * A card's fixed identity for the lifetime of the generator process: home
 * device, home IP set, home city (CLAUDE.md §8 D-19 — travel safety: baseline
 * traffic never leaves the home city), a cooldown clock enforcing the
 * hard 20s per-card floor that keeps VELOCITY structurally unreachable by
 * benign traffic, and a spending profile (§8 D-35) that does the same for
 * AMOUNT_ANOMALY: a typical ticket size, the merchants that sell at that
 * price point, and a memory of the card's own recent amounts.
 */
public final class Card {

    /** Mirrors AMOUNT_ANOMALY's baseline (CLAUDE.md §5): the last 20 amounts, judged once there are 5. */
    private static final int HISTORY = 20;
    private static final int MIN_SAMPLES = 5;

    private final String cardId;
    private final String homeDeviceId;
    private final List<String> homeIpIds;
    private final ReferenceData.City homeCity;
    private final double typicalTicket;
    private final List<Merchant> homeMerchants;
    private final AtomicLong lastTxnAtMillis;

    private final double[] recentAmounts = new double[HISTORY];
    private int recentCount;
    private boolean primed;

    public Card(String cardId, String homeDeviceId, List<String> homeIpIds, ReferenceData.City homeCity,
                double typicalTicket, List<Merchant> homeMerchants) {
        this.cardId = cardId;
        this.homeDeviceId = homeDeviceId;
        this.homeIpIds = homeIpIds;
        this.homeCity = homeCity;
        this.typicalTicket = typicalTicket;
        this.homeMerchants = homeMerchants;
        // Backdated so every card is immediately eligible when the generator starts.
        this.lastTxnAtMillis = new AtomicLong(0L);
    }

    public String cardId() { return cardId; }
    public String homeDeviceId() { return homeDeviceId; }
    public List<String> homeIpIds() { return homeIpIds; }
    public ReferenceData.City homeCity() { return homeCity; }
    public double typicalTicket() { return typicalTicket; }
    public List<Merchant> homeMerchants() { return homeMerchants; }

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

    /**
     * Unconditionally resets the cooldown clock to "now", regardless of
     * eligibility. Used by fraud injectors (control package) to exclude a
     * card from the benign generator's own rotation for the standard
     * cooldown window while a deliberate pattern is being fired on it --
     * tryClaim's conditional semantics aren't enough there, because if the
     * card's existing cooldown is already most of the way through, its
     * *natural* expiry could arrive before the injection sequence finishes.
     */
    public void forceClaim(long now) {
        lastTxnAtMillis.set(now);
    }

    /** True once the card has enough of its own history for AMOUNT_ANOMALY to judge it. */
    public synchronized boolean hasAmountBaseline() {
        return recentCount >= MIN_SAMPLES;
    }

    public synchronized boolean isPrimed() {
        return primed;
    }

    /**
     * Seeds the amount memory, oldest first, with what the detector's window
     * already holds for this card. Without it an API restart leaves this
     * memory empty while Redis still remembers up to an hour of amounts, and
     * the cap in {@link #spend} would be judging against less than the
     * detector does. First call wins; later calls are ignored.
     */
    public synchronized void prime(List<Double> amountsOldestFirst) {
        if (primed) {
            return;
        }
        primed = true;
        amountsOldestFirst.forEach(this::remember);
    }

    private void remember(double amount) {
        recentAmounts[recentCount % HISTORY] = amount;
        recentCount++;
    }

    /**
     * Records {@code amount} as this card's next spend and returns it, first
     * pulling it down to {@code mean + capSigma * stddev} of the card's own
     * recent amounts if it would exceed that. The detector fires above 3 sigma
     * of the same amounts, so a capped amount cannot trip it. Pass
     * {@link Double#POSITIVE_INFINITY} to record a deliberate overspend uncapped.
     *
     * The cap is the tightest one over every "last k amounts" for k from 5 up,
     * not just the full 20: after a Redis flush (`seed.mjs --wipe`) or a cold
     * start the detector's window holds only the newest few of the amounts
     * remembered here, and the guarantee has to hold for whichever suffix it has.
     */
    public synchronized double spend(double amount, double capSigma) {
        if (capSigma != Double.POSITIVE_INFINITY) {
            int n = Math.min(recentCount, HISTORY);
            double sum = 0;
            double sumSquares = 0;
            for (int k = 1; k <= n; k++) {
                double v = recentAmounts[Math.floorMod(recentCount - k, HISTORY)];
                sum += v;
                sumSquares += v * v;
                if (k >= MIN_SAMPLES) {
                    double mean = sum / k;
                    double stddev = Math.sqrt(Math.max(0, sumSquares / k - mean * mean));
                    amount = Math.min(amount, mean + capSigma * stddev);
                }
            }
        }
        amount = Math.round(amount * 100.0) / 100.0;
        remember(amount);
        return amount;
    }
}
