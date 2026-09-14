package com.sentinelstream.generator;

import org.springframework.boot.context.properties.ConfigurationProperties;

/** Binds sentinel.stream.* — CLAUDE.md §4.1 txn:stream registry entry. */
@ConfigurationProperties(prefix = "sentinel.stream")
public class StreamProperties {

    private String key = "txn:stream";
    private long maxlen = 100_000;
    private String consumerGroup = "fraud-detectors";

    public String getKey() { return key; }
    public void setKey(String v) { this.key = v; }
    public long getMaxlen() { return maxlen; }
    public void setMaxlen(long v) { this.maxlen = v; }
    public String getConsumerGroup() { return consumerGroup; }
    public void setConsumerGroup(String v) { this.consumerGroup = v; }
}
