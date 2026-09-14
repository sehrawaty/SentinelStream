package com.sentinelstream.triage;

import java.util.Map;
import java.util.Set;

/**
 * CLAUDE.md §4.5 alert status lifecycle:
 *
 *           reopen
 *   NEW -> INVESTIGATING -> CONFIRMED_FRAUD -.
 *    |          |                            |
 *    |          `-> FALSE_POSITIVE           |
 *    |                   |                   |
 *    `---------[DELETE]--+-------------------'
 *              (from NEW or FALSE_POSITIVE only)
 *
 * CONFIRMED_FRAUD and FALSE_POSITIVE both reopen back to INVESTIGATING.
 */
public final class AlertStatus {

    public static final String NEW = "NEW";
    public static final String INVESTIGATING = "INVESTIGATING";
    public static final String CONFIRMED_FRAUD = "CONFIRMED_FRAUD";
    public static final String FALSE_POSITIVE = "FALSE_POSITIVE";

    private static final Map<String, Set<String>> LEGAL_TRANSITIONS = Map.of(
        NEW, Set.of(INVESTIGATING),
        INVESTIGATING, Set.of(CONFIRMED_FRAUD, FALSE_POSITIVE),
        CONFIRMED_FRAUD, Set.of(INVESTIGATING),
        FALSE_POSITIVE, Set.of(INVESTIGATING)
    );

    private static final Set<String> DELETE_ELIGIBLE = Set.of(NEW, FALSE_POSITIVE);
    private static final Set<String> RESOLUTION_REQUIRED = Set.of(CONFIRMED_FRAUD, FALSE_POSITIVE);

    public static boolean isLegalTransition(String from, String to) {
        Set<String> allowed = LEGAL_TRANSITIONS.get(from);
        return allowed != null && allowed.contains(to);
    }

    public static boolean isDeleteEligible(String status) {
        return DELETE_ELIGIBLE.contains(status);
    }

    public static boolean requiresResolution(String to) {
        return RESOLUTION_REQUIRED.contains(to);
    }

    public static boolean isValid(String status) {
        return LEGAL_TRANSITIONS.containsKey(status);
    }

    private AlertStatus() {}
}
