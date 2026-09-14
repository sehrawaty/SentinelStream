package com.sentinelstream.config;

import com.mongodb.client.MongoDatabase;
import com.mongodb.client.model.CreateCollectionOptions;
import com.mongodb.client.model.ValidationAction;
import com.mongodb.client.model.ValidationLevel;
import com.mongodb.client.model.ValidationOptions;
import jakarta.annotation.PostConstruct;
import org.bson.Document;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.stereotype.Component;

/**
 * CLAUDE.md §4.2 -- creates the five `sentinel` collections with their
 * $jsonSchema validators (validationLevel: moderate, validationAction: error)
 * if they don't already exist. Runs once at boot, idempotently: MongoDB
 * errors on createCollection for a name that already exists, so this checks
 * first rather than relying on exception handling.
 *
 * MongoIndexConfig depends on this (via @DependsOn) so indexes are never
 * built against an implicitly-created, unvalidated collection.
 */
@Component
public class MongoValidatorConfig {

    private static final Logger log = LoggerFactory.getLogger(MongoValidatorConfig.class);

    private final MongoTemplate mongoTemplate;

    public MongoValidatorConfig(MongoTemplate mongoTemplate) {
        this.mongoTemplate = mongoTemplate;
    }

    @PostConstruct
    void createCollections() {
        create("transactions", TRANSACTIONS_SCHEMA);
        create("alerts", ALERTS_SCHEMA);
        create("alerts_archive", ALERTS_ARCHIVE_SCHEMA);
        create("blocked_cards", BLOCKED_CARDS_SCHEMA);
        create("ring_snapshots", RING_SNAPSHOTS_SCHEMA);
    }

    private void create(String name, String schemaJson) {
        if (mongoTemplate.collectionExists(name)) {
            log.info("Collection '{}' already exists -- skipping create", name);
            return;
        }
        Document validatorDoc = Document.parse(schemaJson);
        ValidationOptions validationOptions = new ValidationOptions()
            .validator(validatorDoc)
            .validationLevel(ValidationLevel.MODERATE)
            .validationAction(ValidationAction.ERROR);
        CreateCollectionOptions createOptions = new CreateCollectionOptions()
            .validationOptions(validationOptions);

        MongoDatabase db = mongoTemplate.getDb();
        db.createCollection(name, createOptions);
        log.info("Created collection '{}' with $jsonSchema validator (moderate/error)", name);
    }

    // --- schemas mirror CLAUDE.md §4.2 exactly; do not drift independently ---

    private static final String TRANSACTIONS_SCHEMA = """
        { "$jsonSchema": {
            "bsonType": "object",
            "required": ["txnId","cardId","amount","currency","ts","merchant","city","loc","deviceId","ip","flagged","score","declined","ingestedAt"],
            "properties": {
              "txnId": { "bsonType": "string" },
              "cardId": { "bsonType": "string" },
              "amount": { "bsonType": "double" },
              "currency": { "bsonType": "string" },
              "ts": { "bsonType": "date" },
              "merchant": {
                "bsonType": "object",
                "required": ["id","name","category","mcc"],
                "properties": {
                  "id": { "bsonType": "string" },
                  "name": { "bsonType": "string" },
                  "category": { "bsonType": "string" },
                  "mcc": { "bsonType": "string" }
                }
              },
              "city": { "bsonType": "string" },
              "loc": {
                "bsonType": "object",
                "required": ["type","coordinates"],
                "properties": {
                  "type": { "enum": ["Point"] },
                  "coordinates": { "bsonType": "array", "minItems": 2, "maxItems": 2 }
                }
              },
              "deviceId": { "bsonType": "string" },
              "ip": { "bsonType": "string" },
              "flagged": { "bsonType": "bool" },
              "score": { "bsonType": ["int","double"] },
              "declined": { "bsonType": "bool" },
              "ingestedAt": { "bsonType": "date" }
            }
          } }
        """;

    private static final String ALERTS_SCHEMA = """
        { "$jsonSchema": {
            "bsonType": "object",
            "required": ["alertId","txnId","cardId","ts","severity","score","origin","rules","status","notes","statusHistory","cardBlocked","updatedAt"],
            "properties": {
              "alertId": { "bsonType": "string" },
              "txnId": { "bsonType": "string" },
              "cardId": { "bsonType": "string" },
              "ts": { "bsonType": "date" },
              "severity": { "enum": ["LOW","MEDIUM","HIGH"] },
              "score": { "bsonType": ["int","double"] },
              "origin": { "enum": ["DETECTOR","ANALYST"] },
              "rules": {
                "bsonType": "array",
                "items": {
                  "bsonType": "object",
                  "required": ["type","weight","evidence"],
                  "properties": {
                    "type": { "bsonType": "string" },
                    "weight": { "bsonType": ["int","double"] },
                    "evidence": { "bsonType": "object" }
                  }
                }
              },
              "status": { "enum": ["NEW","INVESTIGATING","CONFIRMED_FRAUD","FALSE_POSITIVE"] },
              "assignee": { "bsonType": ["string","null"] },
              "notes": { "bsonType": "array" },
              "statusHistory": { "bsonType": "array" },
              "cardBlocked": { "bsonType": "bool" },
              "resolution": { "bsonType": ["string","null"] },
              "updatedAt": { "bsonType": "date" }
            }
          } }
        """;

    private static final String ALERTS_ARCHIVE_SCHEMA = """
        { "$jsonSchema": {
            "bsonType": "object",
            "required": ["alertId","cardId","status","dismissedBy","dismissedAt","dismissReason","originalId"],
            "properties": {
              "alertId": { "bsonType": "string" },
              "cardId": { "bsonType": "string" },
              "status": { "bsonType": "string" },
              "dismissedBy": { "bsonType": "string" },
              "dismissedAt": { "bsonType": "date" },
              "dismissReason": { "bsonType": "string" },
              "originalId": { "bsonType": "string" }
            }
          } }
        """;

    private static final String BLOCKED_CARDS_SCHEMA = """
        { "$jsonSchema": {
            "bsonType": "object",
            "required": ["cardId","blockedBy","blockedAt","reason","active"],
            "properties": {
              "cardId": { "bsonType": "string" },
              "blockedBy": { "bsonType": "string" },
              "blockedAt": { "bsonType": "date" },
              "reason": { "bsonType": "string" },
              "sourceAlertId": { "bsonType": ["string","null"] },
              "active": { "bsonType": "bool" },
              "unblockedAt": { "bsonType": ["date","null"] }
            }
          } }
        """;

    private static final String RING_SNAPSHOTS_SCHEMA = """
        { "$jsonSchema": {
            "bsonType": "object",
            "required": ["ringId","discoveredAt","seedCardId","cardIds","sharedEntities","edges","hopDepth"],
            "properties": {
              "ringId": { "bsonType": "string" },
              "discoveredAt": { "bsonType": "date" },
              "seedCardId": { "bsonType": "string" },
              "cardIds": { "bsonType": "array" },
              "sharedEntities": { "bsonType": "array" },
              "edges": { "bsonType": "array" },
              "hopDepth": { "bsonType": ["int","double"] },
              "queryMs": { "bsonType": ["int","double"] }
            }
          } }
        """;
}
