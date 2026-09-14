package com.sentinelstream.persist;

import com.sentinelstream.detect.DetectorResult;
import com.sentinelstream.detect.RulesEngine;
import org.bson.Document;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.Date;
import java.util.List;

/** Builds an `alerts` document (CLAUDE.md §4.2) from a fired RulesEngine evaluation. */
@Component
public class AlertMapper {

    public Document toDocument(String alertId, String txnId, String cardId, long ts,
                                RulesEngine.Evaluation eval) {
        List<Document> rules = new ArrayList<>(eval.firedRules().size());
        for (DetectorResult r : eval.firedRules()) {
            rules.add(new Document()
                .append("type", r.type())
                .append("weight", r.weight())
                .append("evidence", new Document(r.evidence())));
        }

        Date now = new Date();
        Document statusHistoryEntry = new Document()
            .append("from", null)
            .append("to", "NEW")
            .append("by", "system")
            .append("at", now);

        return new Document()
            .append("alertId", alertId)
            .append("txnId", txnId)
            .append("cardId", cardId)
            .append("ts", new Date(ts))
            .append("severity", eval.severity())
            .append("score", eval.score())
            .append("origin", "DETECTOR")
            .append("rules", rules)
            .append("status", "NEW")
            .append("assignee", null)
            .append("notes", List.of())
            .append("statusHistory", List.of(statusHistoryEntry))
            .append("cardBlocked", false)
            .append("resolution", null)
            .append("updatedAt", now);
    }

    /**
     * PLAN.md Part 2 "Create" -- an analyst-raised case with no detector
     * firing behind it. `txnId` is left null: a manual alert isn't anchored
     * to one specific transaction, so pipeline E's $lookup simply finds
     * nothing to join, which the drawer already handles gracefully
     * (preserveNullAndEmptyArrays).
     */
    public Document toManualDocument(String alertId, String cardId, String severity, String reason, String author) {
        Date now = new Date();
        Document rule = new Document()
            .append("type", "MANUAL_REVIEW")
            .append("weight", 0)
            .append("evidence", new Document("reason", reason));
        Document statusHistoryEntry = new Document()
            .append("from", null)
            .append("to", "NEW")
            .append("by", author)
            .append("at", now);

        return new Document()
            .append("alertId", alertId)
            .append("txnId", null)
            .append("cardId", cardId)
            .append("ts", now)
            .append("severity", severity)
            .append("score", 0)
            .append("origin", "ANALYST")
            .append("rules", List.of(rule))
            .append("status", "NEW")
            .append("assignee", author)
            .append("notes", List.of())
            .append("statusHistory", List.of(statusHistoryEntry))
            .append("cardBlocked", false)
            .append("resolution", null)
            .append("updatedAt", now);
    }
}
