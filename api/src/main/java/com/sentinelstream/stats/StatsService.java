package com.sentinelstream.stats;

import com.mongodb.client.MongoCollection;
import org.bson.Document;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;

/**
 * PLAN.md Part 3 -- pipelines A-D (E lives in TriageService.detail(), the
 * alert-detail $lookup). Each is written out here exactly as specified,
 * translated from the plan's JS into Document construction.
 */
@Service
public class StatsService {

    private final MongoTemplate mongoTemplate;

    public StatsService(MongoTemplate mongoTemplate) {
        this.mongoTemplate = mongoTemplate;
    }

    private MongoCollection<Document> transactions() {
        return mongoTemplate.getCollection("transactions");
    }

    private MongoCollection<Document> alerts() {
        return mongoTemplate.getCollection("alerts");
    }

    /** A -- fraud rate by merchant category. Served by index #4 {merchant.category:1, flagged:1}. */
    public List<Document> fraudByCategory(int hours) {
        Date since = Date.from(Instant.now().minus(hours, ChronoUnit.HOURS));

        List<Document> pipeline = List.of(
            new Document("$match", new Document("ts", new Document("$gte", since))),
            new Document("$group", new Document("_id", "$merchant.category")
                .append("total", new Document("$sum", 1))
                .append("flagged", new Document("$sum", new Document("$cond", List.of("$flagged", 1, 0))))
                .append("volume", new Document("$sum", "$amount"))
                .append("flaggedVolume", new Document("$sum",
                    new Document("$cond", List.of("$flagged", "$amount", 0))))),
            // Filters on a computed group size -- cannot be pushed above the $group.
            new Document("$match", new Document("total", new Document("$gte", 20))),
            new Document("$addFields", new Document()
                .append("fraudRate", new Document("$round", List.of(
                    new Document("$divide", List.of("$flagged", "$total")), 4)))
                .append("avgTicket", new Document("$round", List.of(
                    new Document("$divide", List.of("$volume", "$total")), 2)))),
            new Document("$sort", new Document("fraudRate", -1)),
            new Document("$limit", 12),
            new Document("$project", new Document("_id", 0)
                .append("category", "$_id").append("total", 1).append("flagged", 1)
                .append("fraudRate", 1).append("avgTicket", 1)
                .append("flaggedVolume", new Document("$round", List.of("$flaggedVolume", 2))))
        );

        List<Document> out = new ArrayList<>();
        transactions().aggregate(pipeline).into(out);
        return out;
    }

    /** B -- severity distribution bucketed by minute. Zero-filled so Recharts never sees a gap. */
    public List<Document> severityTimeline(int minutes, int binSizeMinutes) {
        Date since = Date.from(Instant.now().minus(minutes, ChronoUnit.MINUTES));

        List<Document> pipeline = List.of(
            new Document("$match", new Document("ts", new Document("$gte", since))),
            new Document("$group", new Document("_id",
                    new Document("bucket", new Document("$dateTrunc", new Document("date", "$ts")
                        .append("unit", "minute").append("binSize", binSizeMinutes)))
                        .append("severity", "$severity"))
                .append("n", new Document("$sum", 1))
                .append("avgScore", new Document("$avg", "$score"))),
            new Document("$group", new Document("_id", "$_id.bucket")
                .append("counts", new Document("$push",
                    new Document("k", "$_id.severity").append("v", "$n")))
                .append("total", new Document("$sum", "$n"))
                .append("avgScore", new Document("$avg", "$avgScore"))),
            new Document("$sort", new Document("_id", 1)),
            new Document("$project", new Document("_id", 0)
                .append("bucket", "$_id")
                .append("total", 1)
                .append("avgScore", new Document("$round", List.of("$avgScore", 1)))
                .append("bySeverity", new Document("$mergeObjects", List.of(
                    new Document("LOW", 0).append("MEDIUM", 0).append("HIGH", 0),
                    new Document("$arrayToObject", "$counts")))))
        );

        List<Document> out = new ArrayList<>();
        alerts().aggregate(pipeline).into(out);
        return out;
    }

    /** C -- top-N cards by alert count. $reduce/$setUnion flattens the rules.type multikey array-of-arrays. */
    public List<Document> topCards(int limit, int hours) {
        Date since = Date.from(Instant.now().minus(hours, ChronoUnit.HOURS));

        List<Document> pipeline = List.of(
            new Document("$match", new Document("ts", new Document("$gte", since))),
            new Document("$group", new Document("_id", "$cardId")
                .append("alerts", new Document("$sum", 1))
                .append("high", new Document("$sum", new Document("$cond", List.of(
                    new Document("$eq", List.of("$severity", "HIGH")), 1, 0))))
                .append("maxScore", new Document("$max", "$score"))
                .append("lastTs", new Document("$max", "$ts"))
                .append("ruleSets", new Document("$addToSet", "$rules.type"))
                .append("blocked", new Document("$max", new Document("$cond", List.of("$cardBlocked", 1, 0))))),
            new Document("$addFields", new Document()
                .append("rules", new Document("$reduce", new Document("input", "$ruleSets")
                    .append("initialValue", List.of())
                    .append("in", new Document("$setUnion", List.of("$$value", "$$this")))))
                .append("blocked", new Document("$eq", List.of("$blocked", 1)))),
            new Document("$sort", new Document("high", -1).append("alerts", -1).append("maxScore", -1)),
            new Document("$limit", limit),
            new Document("$project", new Document("_id", 0)
                .append("cardId", "$_id").append("alerts", 1).append("high", 1)
                .append("maxScore", 1).append("lastTs", 1).append("rules", 1).append("blocked", 1)
                .append("masked", new Document("$concat", List.of("····",
                    new Document("$substrBytes", List.of("$_id",
                        new Document("$subtract", List.of(new Document("$strLenBytes", "$_id"), 4)), 4))))))
        );

        List<Document> out = new ArrayList<>();
        alerts().aggregate(pipeline).into(out);
        return out;
    }

    /** D -- the whole KPI strip in one round trip via $facet. Polled every 3s. */
    public Document kpi(int minutes) {
        Date since = Date.from(Instant.now().minus(minutes, ChronoUnit.MINUTES));

        List<Document> pipeline = List.of(
            new Document("$match", new Document("ts", new Document("$gte", since))),
            new Document("$facet", new Document()
                .append("totals", List.of(new Document("$count", "alerts")))
                .append("bySeverity", List.of(new Document("$group",
                    new Document("_id", "$severity").append("n", new Document("$sum", 1)))))
                .append("byRule", List.of(
                    new Document("$unwind", "$rules"),
                    new Document("$group", new Document("_id", "$rules.type")
                        .append("n", new Document("$sum", 1))
                        .append("avgWeight", new Document("$avg", "$rules.weight"))),
                    new Document("$sort", new Document("n", -1))))
                .append("scoreBands", List.of(new Document("$bucket", new Document("groupBy", "$score")
                    .append("boundaries", List.of(0, 40, 70, 90, 101))
                    .append("default", "unscored")
                    .append("output", new Document("n", new Document("$sum", 1))
                        .append("avgScore", new Document("$avg", "$score"))))))
                .append("queue", List.of(new Document("$group",
                    new Document("_id", "$status").append("n", new Document("$sum", 1)))))
                .append("blocked", List.of(
                    new Document("$match", new Document("cardBlocked", true)),
                    new Document("$group", new Document("_id", "$cardId")),
                    new Document("$count", "cards")))
                .append("latest", List.of(
                    new Document("$sort", new Document("ts", -1)),
                    new Document("$limit", 5),
                    new Document("$project", new Document("_id", 0)
                        .append("alertId", 1).append("cardId", 1).append("severity", 1).append("ts", 1))))),
            new Document("$project", new Document()
                .append("alerts", new Document("$ifNull", List.of(
                    new Document("$first", "$totals.alerts"), 0)))
                .append("blockedCards", new Document("$ifNull", List.of(
                    new Document("$first", "$blocked.cards"), 0)))
                .append("bySeverity", new Document("$mergeObjects", List.of(
                    new Document("LOW", 0).append("MEDIUM", 0).append("HIGH", 0),
                    new Document("$arrayToObject", new Document("$map", new Document("input", "$bySeverity")
                        .append("as", "s")
                        .append("in", new Document("k", "$$s._id").append("v", "$$s.n")))))))
                .append("queue", new Document("$arrayToObject", new Document("$map", new Document("input", "$queue")
                    .append("as", "q")
                    .append("in", new Document("k", "$$q._id").append("v", "$$q.n")))))
                .append("byRule", 1).append("scoreBands", 1).append("latest", 1))
        );

        Document result = alerts().aggregate(pipeline).first();
        return result != null ? result : new Document();
    }
}
