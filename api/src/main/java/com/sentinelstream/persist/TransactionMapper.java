package com.sentinelstream.persist;

import org.bson.Document;
import org.springframework.stereotype.Component;

import java.util.Date;
import java.util.List;
import java.util.Map;

/**
 * Maps a txn:stream field map (CLAUDE.md §4.1) onto the `transactions`
 * document shape (§4.2). `flagged`/`score` default to the not-yet-scored
 * state until the detectors slice sets them; `declined` comes from the
 * consumer's own step-1 blocklist check, not from the stream itself.
 */
@Component
public class TransactionMapper {

    public Document toDocument(Map<String, String> fields, boolean declined) {
        Document merchant = new Document()
            .append("id", fields.get("merchantId"))
            .append("name", fields.get("merchantName"))
            .append("category", fields.get("merchantCategory"))
            .append("mcc", fields.get("mcc"));

        double lat = Double.parseDouble(fields.get("lat"));
        double lon = Double.parseDouble(fields.get("lon"));
        Document loc = new Document("type", "Point").append("coordinates", List.of(lon, lat));

        return new Document()
            .append("txnId", fields.get("txnId"))
            .append("cardId", fields.get("cardId"))
            .append("amount", Double.parseDouble(fields.get("amount")))
            .append("currency", fields.get("currency"))
            .append("ts", new Date(Long.parseLong(fields.get("ts"))))
            .append("merchant", merchant)
            .append("city", fields.get("city"))
            .append("loc", loc)
            .append("deviceId", fields.get("deviceId"))
            .append("ip", fields.get("ip"))
            .append("flagged", false)
            .append("score", 0)
            .append("declined", declined)
            .append("ingestedAt", new Date());
    }
}
