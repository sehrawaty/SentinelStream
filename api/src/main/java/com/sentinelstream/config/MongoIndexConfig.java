package com.sentinelstream.config;

import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.DependsOn;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.index.GeospatialIndex;
import org.springframework.data.domain.Sort;
import org.springframework.data.mongodb.core.index.Index;
import org.springframework.data.mongodb.core.index.IndexInfo;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.List;

/**
 * CLAUDE.md §4.3 -- the frozen 15-index registry, created idempotently at
 * boot (ensureIndex is a no-op if an identical index already exists) so the
 * examiner can see the indexes declared in source, not typed by hand.
 * Exposed live via GET /api/admin/indexes.
 *
 * @DependsOn MongoValidatorConfig: indexes must never be built against a
 * collection MongoDB auto-created implicitly (which would have no
 * validator attached).
 */
@Component
@DependsOn("mongoValidatorConfig")
public class MongoIndexConfig {

    private static final Logger log = LoggerFactory.getLogger(MongoIndexConfig.class);

    private final MongoTemplate mongoTemplate;

    public MongoIndexConfig(MongoTemplate mongoTemplate) {
        this.mongoTemplate = mongoTemplate;
    }

    @PostConstruct
    void ensureIndexes() {
        // --- transactions (#1-#6) ---
        ensure("transactions", new Index().on("txnId", Sort.Direction.ASC).unique());                         // #1
        ensure("transactions", new Index().on("cardId", Sort.Direction.ASC).on("ts", Sort.Direction.DESC));  // #2
        ensure("transactions", new Index().on("ts", Sort.Direction.DESC));                                    // #3
        ensure("transactions", new Index().on("merchant.category", Sort.Direction.ASC).on("flagged", Sort.Direction.ASC)); // #4
        ensure("transactions", new Index().on("ingestedAt", Sort.Direction.ASC).expire(Duration.ofHours(24))); // #5 TTL
        ensure("transactions", new GeospatialIndex("loc").typed(org.springframework.data.mongodb.core.index.GeoSpatialIndexType.GEO_2DSPHERE)); // #6

        // --- alerts (#7-#12) ---
        ensure("alerts", new Index().on("alertId", Sort.Direction.ASC).unique());                              // #7
        ensure("alerts", new Index().on("severity", Sort.Direction.ASC).on("ts", Sort.Direction.DESC));       // #8
        ensure("alerts", new Index().on("cardId", Sort.Direction.ASC).on("ts", Sort.Direction.DESC));         // #9
        ensure("alerts", new Index()
            .on("status", Sort.Direction.ASC)
            .on("severity", Sort.Direction.ASC)
            .on("ts", Sort.Direction.DESC));                                                                   // #10 ESR triage index
        ensure("alerts", new Index().on("txnId", Sort.Direction.ASC));                                         // #11
        ensure("alerts", new Index().on("rules.type", Sort.Direction.ASC).on("ts", Sort.Direction.DESC));     // #12 multikey

        // --- alerts_archive (#13) ---
        ensure("alerts_archive", new Index().on("dismissedAt", Sort.Direction.ASC).expire(Duration.ofDays(7))); // #13 TTL

        // --- blocked_cards (#14) ---
        ensure("blocked_cards", new Index().on("cardId", Sort.Direction.ASC).unique());                        // #14

        // --- ring_snapshots (#15) ---
        ensure("ring_snapshots", new Index().on("discoveredAt", Sort.Direction.DESC));                         // #15

        logSummary();
    }

    private void ensure(String collection, org.springframework.data.mongodb.core.index.IndexDefinition index) {
        mongoTemplate.indexOps(collection).ensureIndex(index);
    }

    private void logSummary() {
        for (String coll : List.of("transactions", "alerts", "alerts_archive", "blocked_cards", "ring_snapshots")) {
            List<IndexInfo> infos = mongoTemplate.indexOps(coll).getIndexInfo();
            log.info("Indexes on '{}': {}", coll, infos.stream().map(IndexInfo::getName).toList());
        }
    }
}
