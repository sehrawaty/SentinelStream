package com.sentinelstream.generator;

import org.springframework.boot.context.properties.ConfigurationProperties;

/** Binds sentinel.generator.* — CLAUDE.md §8 D-19 for the population/pacing rationale. */
@ConfigurationProperties(prefix = "sentinel.generator")
public class GeneratorProperties {

    private int ratePerSecond = 150;
    private int cardCount = 4000;
    private int merchantCount = 80;
    private int deviceCount = 2200;
    private int ipCount = 3200;
    private int maxCardsPerDevice = 2;
    private int maxCardsPerIp = 2;
    private int minHomeIpsPerCard = 1;
    private int maxHomeIpsPerCard = 2;
    private long minTxnGapMs = 20_000;
    private long seed = 1590810094L;

    public int getRatePerSecond() { return ratePerSecond; }
    public void setRatePerSecond(int v) { this.ratePerSecond = v; }
    public int getCardCount() { return cardCount; }
    public void setCardCount(int v) { this.cardCount = v; }
    public int getMerchantCount() { return merchantCount; }
    public void setMerchantCount(int v) { this.merchantCount = v; }
    public int getDeviceCount() { return deviceCount; }
    public void setDeviceCount(int v) { this.deviceCount = v; }
    public int getIpCount() { return ipCount; }
    public void setIpCount(int v) { this.ipCount = v; }
    public int getMaxCardsPerDevice() { return maxCardsPerDevice; }
    public void setMaxCardsPerDevice(int v) { this.maxCardsPerDevice = v; }
    public int getMaxCardsPerIp() { return maxCardsPerIp; }
    public void setMaxCardsPerIp(int v) { this.maxCardsPerIp = v; }
    public int getMinHomeIpsPerCard() { return minHomeIpsPerCard; }
    public void setMinHomeIpsPerCard(int v) { this.minHomeIpsPerCard = v; }
    public int getMaxHomeIpsPerCard() { return maxHomeIpsPerCard; }
    public void setMaxHomeIpsPerCard(int v) { this.maxHomeIpsPerCard = v; }
    public long getMinTxnGapMs() { return minTxnGapMs; }
    public void setMinTxnGapMs(long v) { this.minTxnGapMs = v; }
    public long getSeed() { return seed; }
    public void setSeed(long v) { this.seed = v; }
}
