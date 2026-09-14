package com.sentinelstream.control;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/** CLAUDE.md §5 injectable patterns -- the three REST controls the demo script (spec §9) drives. */
@RestController
public class InjectionController {

    private final InjectionService injection;

    public InjectionController(InjectionService injection) {
        this.injection = injection;
    }

    @PostMapping("/api/control/inject/velocity")
    public Map<String, Object> velocity() {
        String cardId = injection.injectVelocity();
        return Map.of("pattern", "VELOCITY", "cardId", cardId);
    }

    @PostMapping("/api/control/inject/travel")
    public Map<String, Object> travel() {
        String cardId = injection.injectTravel();
        return Map.of("pattern", "IMPOSSIBLE_TRAVEL", "cardId", cardId);
    }

    @PostMapping("/api/control/inject/ring")
    public Map<String, Object> ring() {
        List<String> cardIds = injection.injectRing();
        return Map.of("pattern", "RING", "cardIds", cardIds);
    }
}
