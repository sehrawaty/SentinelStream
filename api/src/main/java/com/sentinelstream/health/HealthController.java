package com.sentinelstream.health;

import com.mongodb.client.MongoDatabase;
import org.bson.Document;
import org.neo4j.driver.Driver;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.redis.connection.RedisConnection;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * S1 milestone: a single endpoint that proves all three stores are reachable
 * from the API container. Each store is probed independently so a partial
 * outage is reported per-store rather than as one opaque failure.
 *
 * CLAUDE.md §1 rule 6 note: this is a liveness probe, not a query path, so it
 * is deliberately not backed by an index entry.
 */
@RestController
public class HealthController {

    private final MongoTemplate mongoTemplate;
    private final RedisConnectionFactory redisConnectionFactory;
    private final Driver neo4jDriver;

    public HealthController(MongoTemplate mongoTemplate,
                             RedisConnectionFactory redisConnectionFactory,
                             Driver neo4jDriver) {
        this.mongoTemplate = mongoTemplate;
        this.redisConnectionFactory = redisConnectionFactory;
        this.neo4jDriver = neo4jDriver;
    }

    @GetMapping("/api/health")
    public ResponseEntity<Map<String, Object>> health() {
        Map<String, Object> stores = new LinkedHashMap<>();

        boolean redisUp = probe(stores, "redis", this::pingRedis);
        boolean mongoUp = probe(stores, "mongo", this::pingMongo);
        boolean neo4jUp = probe(stores, "neo4j", this::pingNeo4j);
        boolean allUp = redisUp && mongoUp && neo4jUp;

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("status", allUp ? "UP" : "DOWN");
        body.put("stores", stores);

        return allUp ? ResponseEntity.ok(body) : ResponseEntity.status(503).body(body);
    }

    private boolean probe(Map<String, Object> stores, String name, Runnable check) {
        try {
            check.run();
            stores.put(name, "UP");
            return true;
        } catch (Exception e) {
            stores.put(name, "DOWN: " + e.getClass().getSimpleName() + ": " + e.getMessage());
            return false;
        }
    }

    private void pingRedis() {
        try (RedisConnection conn = redisConnectionFactory.getConnection()) {
            conn.ping();
        }
    }

    private void pingMongo() {
        MongoDatabase db = mongoTemplate.getDb();
        db.runCommand(new Document("ping", 1));
    }

    private void pingNeo4j() {
        try (var session = neo4jDriver.session()) {
            session.run("RETURN 1").consume();
        }
    }
}
