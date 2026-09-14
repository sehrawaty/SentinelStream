package com.sentinelstream.persist;

import org.bson.Document;
import org.springframework.stereotype.Component;

import java.util.Date;
import java.util.List;
import java.util.Map;

/**
 * Maps a txn:stream field map (CLAUDE.md §4.1) onto the `transactions`
 * document shape (§4.2). `declined` comes from the consumer's own step-1
 * blocklist check, not from the stream itself. `flagged`/`score` must come
 * from step 4's detector evaluation, which the consumer runs *before*
 * calling this (§7 order) -- there is no separate update-back-onto-the-
 * transaction step; getting these right at construction time is what
 * D-11's denormalisation (pipeline A skipping a $lookup) actually depends
 * on. (Caught live: pipeline A showed flagged=0 everywhere because this
 * was hardcoded to false/0 and never actually received the score.)
 */
@Component
public class TransactionMapper {

    public Document toDocument(Map<String, String> fields, boolean declined, boolean flagged, int score) {
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
            .append("flagged", flagged)
            .append("score", score)
            .append("declined", declined)
            .append("ingestedAt", new Date());
    }
}
