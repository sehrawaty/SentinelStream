package com.sentinelstream.triage;

import org.springframework.web.bind.annotation.*;

import org.bson.Document;

import java.util.List;
import java.util.Map;

/** PLAN.md Part 2 -- block-card write-back, card-scoped (not alert-scoped). */
@RestController
@RequestMapping("/api/cards")
public class CardController {

    private final CardBlockService blockService;

    public CardController(CardBlockService blockService) {
        this.blockService = blockService;
    }

    @GetMapping("/blocked")
    public List<Document> blocked() {
        return blockService.listActive();
    }

    public record BlockRequest(String reason, String by, String sourceAlertId) {}

    @PostMapping("/{cardId}/block")
    public Map<String, Object> block(@PathVariable String cardId, @RequestBody BlockRequest req) {
        blockService.block(cardId, req.reason(), req.by(), req.sourceAlertId());
        return Map.of("cardId", cardId, "blocked", true);
    }

    @DeleteMapping("/{cardId}/block")
    public Map<String, Object> unblock(@PathVariable String cardId, @RequestParam String by) {
        blockService.unblock(cardId, by);
        return Map.of("cardId", cardId, "blocked", false);
    }
}
