package com.sentinelstream.persist;

import org.springframework.boot.context.properties.ConfigurationProperties;

/** Binds sentinel.bulkWriter.* -- implementation plan Part 5. */
@ConfigurationProperties(prefix = "sentinel.bulk-writer")
public class BulkWriterProperties {

    private int queueCapacity = 5000;
    private int flushDocs = 200;
    private long flushIntervalMs = 500;

    public int getQueueCapacity() { return queueCapacity; }
    public void setQueueCapacity(int v) { this.queueCapacity = v; }
    public int getFlushDocs() { return flushDocs; }
    public void setFlushDocs(int v) { this.flushDocs = v; }
    public long getFlushIntervalMs() { return flushIntervalMs; }
    public void setFlushIntervalMs(long v) { this.flushIntervalMs = v; }
}
