package com.sentinelstream.detect;

import org.springframework.boot.context.properties.ConfigurationProperties;

/** Binds sentinel.rules.* -- CLAUDE.md §5 rules engine constants. */
@ConfigurationProperties(prefix = "sentinel.rules")
public class RulesProperties {

    private final Velocity velocity = new Velocity();
    private final Amount amount = new Amount();
    private final Travel travel = new Travel();
    private final Fanout fanout = new Fanout();
    private final SeverityBands severityBands = new SeverityBands();

    public Velocity getVelocity() { return velocity; }
    public Amount getAmount() { return amount; }
    public Travel getTravel() { return travel; }
    public Fanout getFanout() { return fanout; }
    public SeverityBands getSeverityBands() { return severityBands; }

    public static class Velocity {
        private int count = 5;
        private int windowSeconds = 60;
        private int weight = 40;
        public int getCount() { return count; }
        public void setCount(int v) { this.count = v; }
        public int getWindowSeconds() { return windowSeconds; }
        public void setWindowSeconds(int v) { this.windowSeconds = v; }
        public int getWeight() { return weight; }
        public void setWeight(int v) { this.weight = v; }
    }

    public static class Amount {
        private double sigma = 3;
        private int sampleSize = 20;
        private int minSamples = 5;
        private int weight = 25;
        public double getSigma() { return sigma; }
        public void setSigma(double v) { this.sigma = v; }
        public int getSampleSize() { return sampleSize; }
        public void setSampleSize(int v) { this.sampleSize = v; }
        public int getMinSamples() { return minSamples; }
        public void setMinSamples(int v) { this.minSamples = v; }
        public int getWeight() { return weight; }
        public void setWeight(int v) { this.weight = v; }
    }

    public static class Travel {
        private double thresholdKmh = 900;
        private double minKm = 200;
        private int weight = 70;
        public double getThresholdKmh() { return thresholdKmh; }
        public void setThresholdKmh(double v) { this.thresholdKmh = v; }
        public double getMinKm() { return minKm; }
        public void setMinKm(double v) { this.minKm = v; }
        public int getWeight() { return weight; }
        public void setWeight(int v) { this.weight = v; }
    }

    public static class Fanout {
        private int minCards = 3;
        private int windowSeconds = 600;
        private int weight = 55;
        public int getMinCards() { return minCards; }
        public void setMinCards(int v) { this.minCards = v; }
        public int getWindowSeconds() { return windowSeconds; }
        public void setWindowSeconds(int v) { this.windowSeconds = v; }
        public int getWeight() { return weight; }
        public void setWeight(int v) { this.weight = v; }
    }

    public static class SeverityBands {
        private int low = 1;
        private int medium = 40;
        private int high = 70;
        public int getLow() { return low; }
        public void setLow(int v) { this.low = v; }
        public int getMedium() { return medium; }
        public void setMedium(int v) { this.medium = v; }
        public int getHigh() { return high; }
        public void setHigh(int v) { this.high = v; }
    }
}
