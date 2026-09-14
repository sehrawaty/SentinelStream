package com.sentinelstream.stats;

import org.bson.Document;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/** PLAN.md Part 3 -- aggregation pipelines A-D. Pipeline E lives at GET /api/alerts/{id} (TriageService). */
@RestController
public class StatsController {

    private final StatsService stats;

    public StatsController(StatsService stats) {
        this.stats = stats;
    }

    /** A -- Category Risk bar chart. */
    @GetMapping("/api/stats/fraud-by-category")
    public List<Document> fraudByCategory(@RequestParam(defaultValue = "24") int hours) {
        return stats.fraudByCategory(hours);
    }

    /** B -- Rule Activity stacked area. */
    @GetMapping("/api/stats/severity-timeline")
    public List<Document> severityTimeline(@RequestParam(defaultValue = "60") int minutes,
                                            @RequestParam(defaultValue = "1") int binSize) {
        return stats.severityTimeline(minutes, binSize);
    }

    /** C -- Watchlist leaderboard. */
    @GetMapping("/api/stats/top-cards")
    public List<Document> topCards(@RequestParam(defaultValue = "10") int limit,
                                    @RequestParam(defaultValue = "24") int hours) {
        return stats.topCards(limit, hours);
    }

    /** D -- the whole KPI strip, one round trip. Polled every 3s by the UI. */
    @GetMapping("/api/stats/kpi")
    public Document kpi(@RequestParam(defaultValue = "60") int minutes) {
        return stats.kpi(minutes);
    }
}
