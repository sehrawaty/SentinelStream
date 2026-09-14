package com.sentinelstream.graph;

import org.springframework.boot.context.properties.ConfigurationProperties;

/** Binds sentinel.graph-projector.* -- spec §5 "Bounded queue, flushed every 500ms or 100 edges." */
@ConfigurationProperties(prefix = "sentinel.graph-projector")
public class GraphProjectorProperties {

    private int queueCapacity = 5000;
    private int flushEdges = 100;
    private long flushIntervalMs = 500;

    public int getQueueCapacity() { return queueCapacity; }
    public void setQueueCapacity(int v) { this.queueCapacity = v; }
    public int getFlushEdges() { return flushEdges; }
    public void setFlushEdges(int v) { this.flushEdges = v; }
    public long getFlushIntervalMs() { return flushIntervalMs; }
    public void setFlushIntervalMs(long v) { this.flushIntervalMs = v; }
}
