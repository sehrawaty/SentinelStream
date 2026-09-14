package com.sentinelstream.control;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.util.List;

/** Binds sentinel.injectors.* -- CLAUDE.md §5 "Injectable patterns". */
@ConfigurationProperties(prefix = "sentinel.injectors")
public class InjectorProperties {

    private final Velocity velocity = new Velocity();
    private final Travel travel = new Travel();
    private final Ring ring = new Ring();

    public Velocity getVelocity() { return velocity; }
    public Travel getTravel() { return travel; }
    public Ring getRing() { return ring; }

    public static class Velocity {
        private int count = 12;
        private int windowSeconds = 20;
        public int getCount() { return count; }
        public void setCount(int v) { this.count = v; }
        public int getWindowSeconds() { return windowSeconds; }
        public void setWindowSeconds(int v) { this.windowSeconds = v; }
    }

    public static class Travel {
        private String fromCity = "Chennai";
        private String toCity = "Delhi";
        private int secondLegDelaySeconds = 2;
        public String getFromCity() { return fromCity; }
        public void setFromCity(String v) { this.fromCity = v; }
        public String getToCity() { return toCity; }
        public void setToCity(String v) { this.toCity = v; }
        public int getSecondLegDelaySeconds() { return secondLegDelaySeconds; }
        public void setSecondLegDelaySeconds(int v) { this.secondLegDelaySeconds = v; }
    }

    public static class Ring {
        private int cardCount = 6;
        private int staggerSeconds = 2;
        private String deviceId = "D-SEED-01";
        private List<String> ips = List.of("10.10.10.10", "10.10.10.20");
        public int getCardCount() { return cardCount; }
        public void setCardCount(int v) { this.cardCount = v; }
        public int getStaggerSeconds() { return staggerSeconds; }
        public void setStaggerSeconds(int v) { this.staggerSeconds = v; }
        public String getDeviceId() { return deviceId; }
        public void setDeviceId(String v) { this.deviceId = v; }
        public List<String> getIps() { return ips; }
        public void setIps(List<String> v) { this.ips = v; }
    }
}
