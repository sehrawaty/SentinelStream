package com.sentinelstream.consumer;

import org.springframework.boot.context.properties.ConfigurationProperties;

/** Binds sentinel.redis.* — CLAUDE.md §4.1 TTLs. */
@ConfigurationProperties(prefix = "sentinel.redis")
public class RedisKeysProperties {

    private long idempotencyTtl = 900;
    private long cardWindowTtl = 3600;
    private long entityWindowTtl = 1800;
    private long ringCooldownTtl = 300;

    public long getIdempotencyTtl() { return idempotencyTtl; }
    public void setIdempotencyTtl(long v) { this.idempotencyTtl = v; }
    public long getCardWindowTtl() { return cardWindowTtl; }
    public void setCardWindowTtl(long v) { this.cardWindowTtl = v; }
    public long getEntityWindowTtl() { return entityWindowTtl; }
    public void setEntityWindowTtl(long v) { this.entityWindowTtl = v; }
    public long getRingCooldownTtl() { return ringCooldownTtl; }
    public void setRingCooldownTtl(long v) { this.ringCooldownTtl = v; }
}
