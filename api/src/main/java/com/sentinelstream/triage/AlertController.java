package com.sentinelstream.triage;

import org.bson.Document;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

/**
 * PLAN.md Part 2 -- the triage REST surface. All four CRUD operations on
 * MongoDB, each reachable from a UI affordance (Part 6 of the plan):
 * Create (POST /manual), Read (GET list + GET detail via pipeline E),
 * Update (status/notes/assign), Delete (DELETE single + bulk).
 */
@RestController
@RequestMapping("/api/alerts")
public class AlertController {

    private final TriageService triage;

    public AlertController(TriageService triage) {
        this.triage = triage;
    }

    // ---- Read ----

    @GetMapping
    public Map<String, Object> list(
            @RequestParam(required = false) String status,
            @RequestParam(required = false) String severity,
            @RequestParam(required = false) String cardId,
            @RequestParam(required = false) String rule,
            @RequestParam(required = false) String from,
            @RequestParam(required = false) String to,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "20") int size) {
        return triage.list(status, severity, cardId, rule, from, to, page, size);
    }

    @GetMapping("/{alertId}")
    public Document detail(@PathVariable String alertId) {
        return triage.detail(alertId);
    }

    // ---- Create ----

    public record ManualAlertRequest(String cardId, String severity, String reason, String author) {}

    @PostMapping("/manual")
    public Map<String, Object> createManual(@RequestBody ManualAlertRequest req) {
        String alertId = triage.createManual(req.cardId(), req.severity(), req.reason(), req.author());
        return Map.of("alertId", alertId);
    }

    // ---- Update ----

    public record StatusChangeRequest(String to, String by, String resolution) {}

    @PatchMapping("/{alertId}/status")
    public Document changeStatus(@PathVariable String alertId, @RequestBody StatusChangeRequest req) {
        return triage.changeStatus(alertId, req.to(), req.by(), req.resolution());
    }

    public record AssignRequest(String assignee) {}

    @PatchMapping("/{alertId}/assign")
    public Document assign(@PathVariable String alertId, @RequestBody AssignRequest req) {
        return triage.assign(alertId, req.assignee());
    }

    public record NoteRequest(String author, String body) {}

    @PostMapping("/{alertId}/notes")
    public Document addNote(@PathVariable String alertId, @RequestBody NoteRequest req) {
        return triage.addNote(alertId, req.author(), req.body());
    }

    public record NoteEditRequest(String body) {}

    @PatchMapping("/{alertId}/notes/{noteId}")
    public Document editNote(@PathVariable String alertId, @PathVariable String noteId,
                              @RequestBody NoteEditRequest req) {
        return triage.editNote(alertId, noteId, req.body());
    }

    @DeleteMapping("/{alertId}/notes/{noteId}")
    public Document deleteNote(@PathVariable String alertId, @PathVariable String noteId) {
        return triage.deleteNote(alertId, noteId);
    }

    // ---- Delete ----

    @DeleteMapping("/{alertId}")
    public Map<String, Object> dismiss(@PathVariable String alertId,
                                        @RequestParam String reason, @RequestParam String by) {
        String dismissed = triage.dismiss(alertId, reason, by);
        return Map.of("alertId", dismissed, "dismissed", true);
    }

    @DeleteMapping
    public Map<String, Object> bulkDismiss(@RequestParam String status,
                                            @RequestParam(required = false) String before,
                                            @RequestParam String by) {
        return triage.bulkDismiss(status, before, by);
    }
}
