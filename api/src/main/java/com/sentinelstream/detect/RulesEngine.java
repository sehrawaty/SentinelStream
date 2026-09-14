package com.sentinelstream.detect;

import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;

/**
 * CLAUDE.md §5 -- runs all four detectors and reduces their results to a
 * score and severity band. score = min(100, sum(weights)); bands are
 * LOW 1-39 / MEDIUM 40-69 / HIGH 70-100 (severityBands in application.yml).
 */
@Component
public class RulesEngine {

    private final VelocityDetector velocity;
    private final AmountAnomalyDetector amount;
    private final ImpossibleTravelDetector travel;
    private final EntityFanoutDetector fanout;
    private final RulesProperties props;

    public RulesEngine(VelocityDetector velocity, AmountAnomalyDetector amount,
                        ImpossibleTravelDetector travel, EntityFanoutDetector fanout,
                        RulesProperties props) {
        this.velocity = velocity;
        this.amount = amount;
        this.travel = travel;
        this.fanout = fanout;
        this.props = props;
    }

    public record Evaluation(int score, String severity, List<DetectorResult> firedRules) {}

    public Evaluation evaluate(String cardId, String deviceId, String ip,
                                String txnId, double txnAmount, String city) {
        List<DetectorResult> fired = new ArrayList<>(4);

        velocity.evaluate(cardId).ifPresent(fired::add);
        amount.evaluate(cardId, txnId, txnAmount).ifPresent(fired::add);
        travel.evaluate(cardId, txnId, city).ifPresent(fired::add);
        fanout.evaluate(deviceId, ip).ifPresent(fired::add);

        int rawScore = fired.stream().mapToInt(DetectorResult::weight).sum();
        int score = Math.min(100, rawScore);
        String severity = band(score);

        return new Evaluation(score, severity, fired);
    }

    private String band(int score) {
        if (score == 0) return null;
        if (score >= props.getSeverityBands().getHigh()) return "HIGH";
        if (score >= props.getSeverityBands().getMedium()) return "MEDIUM";
        return "LOW";
    }
}
