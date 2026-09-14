package com.sentinelstream.generator;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/** CLAUDE.md §5 — pause/resume (D-15). Injection endpoints land with the detectors slice. */
@RestController
public class GeneratorControlController {

    private final GeneratorService generator;
    private final GeneratorProperties props;

    public GeneratorControlController(GeneratorService generator, GeneratorProperties props) {
        this.generator = generator;
        this.props = props;
    }

    @PostMapping("/api/control/generator/pause")
    public Map<String, Object> pause() {
        generator.pause();
        return status();
    }

    @PostMapping("/api/control/generator/resume")
    public Map<String, Object> resume() {
        generator.resume();
        return status();
    }

    @GetMapping("/api/control/generator/status")
    public Map<String, Object> status() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("paused", generator.isPaused());
        body.put("ratePerSecond", props.getRatePerSecond());
        body.put("cardCount", props.getCardCount());
        body.put("emittedTotal", generator.emittedTotal());
        return body;
    }
}
