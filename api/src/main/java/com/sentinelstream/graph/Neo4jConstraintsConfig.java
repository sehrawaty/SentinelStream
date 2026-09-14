package com.sentinelstream.graph;

import jakarta.annotation.PostConstruct;
import org.neo4j.driver.Driver;
import org.neo4j.driver.Session;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * CLAUDE.md §4.4 -- the four uniqueness constraints, each also the backing
 * index that makes the ring query's seed lookup (`MATCH (seed:Card
 * {cardId: $x})`) an index seek rather than a label scan. `IF NOT EXISTS`
 * makes this idempotent at every boot, same pattern as MongoIndexConfig.
 * scripts/seed.mjs also creates these directly (it can't depend on this
 * class existing, since it runs from the host, not the JVM) -- both are
 * idempotent, so running either or both in any order converges.
 */
@Component
public class Neo4jConstraintsConfig {

    private static final Logger log = LoggerFactory.getLogger(Neo4jConstraintsConfig.class);

    private final Driver driver;

    public Neo4jConstraintsConfig(Driver driver) {
        this.driver = driver;
    }

    @PostConstruct
    void ensureConstraints() {
        String[] statements = {
            "CREATE CONSTRAINT card_id IF NOT EXISTS FOR (c:Card) REQUIRE c.cardId IS UNIQUE",
            "CREATE CONSTRAINT device_id IF NOT EXISTS FOR (d:Device) REQUIRE d.deviceId IS UNIQUE",
            "CREATE CONSTRAINT ip_addr IF NOT EXISTS FOR (i:Ip) REQUIRE i.ip IS UNIQUE",
            "CREATE CONSTRAINT merch_id IF NOT EXISTS FOR (m:Merchant) REQUIRE m.merchantId IS UNIQUE",
        };
        try (Session session = driver.session()) {
            for (String stmt : statements) {
                session.run(stmt).consume();
            }
        }
        log.info("Ensured {} Neo4j constraints (CLAUDE.md §4.4)", statements.length);
    }
}
