package com.sentinelstream.persist;

import org.bson.Document;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.List;

/**
 * CLAUDE.md §6 `/api/txns` -- transaction history. With a cardId this is the
 * card-history read index #2 ({cardId: 1, ts: -1}) exists for; without one
 * it is the newest-first scan over index #3 ({ts: -1}).
 */
@RestController
public class TxnController {

    private final MongoTemplate mongoTemplate;

    public TxnController(MongoTemplate mongoTemplate) {
        this.mongoTemplate = mongoTemplate;
    }

    @GetMapping("/api/txns")
    public List<Document> list(@RequestParam(required = false) String cardId,
                               @RequestParam(defaultValue = "25") int limit) {
        Document filter = cardId == null ? new Document() : new Document("cardId", cardId);
        List<Document> out = new ArrayList<>();
        mongoTemplate.getCollection("transactions")
            .find(filter)
            .projection(new Document("_id", 0).append("loc", 0).append("ingestedAt", 0))
            .sort(new Document("ts", -1))
            .limit(Math.min(limit, 100))
            .into(out);
        return out;
    }
}
