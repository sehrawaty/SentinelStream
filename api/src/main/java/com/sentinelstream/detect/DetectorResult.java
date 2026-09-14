package com.sentinelstream.detect;

import java.util.Map;

/**
 * One fired rule. `evidence` is intentionally an unconstrained Map -- it
 * becomes the alerts.rules[].evidence object (CLAUDE.md §4.2), whose shape
 * differs per rule type. That heterogeneity is the whole justification for
 * alerts being documents rather than a relational table (spec §3).
 */
public record DetectorResult(String type, int weight, Map<String, Object> evidence) {}
