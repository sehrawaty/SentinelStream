package com.sentinelstream.control;

import com.sentinelstream.detect.WindowService;
import com.sentinelstream.generator.Card;
import com.sentinelstream.generator.EntityPool;
import com.sentinelstream.generator.GeneratorService;
import com.sentinelstream.generator.Merchant;
import com.sentinelstream.generator.ReferenceData;
import com.sentinelstream.generator.TransactionFactory;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;

/**
 * CLAUDE.md §5 "Injectable patterns" -- fires crafted transactions directly
 * onto txn:stream. The already-running consumer processes them exactly like
 * organic traffic (steps 1-10, §7); nothing here is detector-aware or
 * consumer-aware. Real-time staggering (not simulated-timestamp bursts) is
 * deliberate for velocity and ring so the demo can be watched as it happens
 * (spec §9); travel uses a simulated ts gap since waiting 4 real minutes
 * would break demo pacing (implementation plan §6 I-3/I-5 reasoning).
 */
@Component
@EnableConfigurationProperties(InjectorProperties.class)
public class InjectionService {

    private static final Logger log = LoggerFactory.getLogger(InjectionService.class);

    private final EntityPool pool;
    private final TransactionFactory factory;
    private final GeneratorService generator;
    private final InjectorProperties props;
    private final StringRedisTemplate redis;
    private final WindowService windows;
    private final ScheduledExecutorService scheduler;

    public InjectionService(EntityPool pool, TransactionFactory factory, GeneratorService generator,
                             InjectorProperties props, StringRedisTemplate redis, WindowService windows) {
        this.pool = pool;
        this.factory = factory;
        this.generator = generator;
        this.props = props;
        this.redis = redis;
        this.windows = windows;
        this.scheduler = Executors.newScheduledThreadPool(2, r -> {
            Thread t = new Thread(r, "injector");
            t.setDaemon(true);
            return t;
        });
    }

    /** One card, count txns spread evenly over windowSeconds -- fires the VELOCITY rule. */
    public String injectVelocity() {
        Card card = pool.randomCard();
        card.forceClaim(System.currentTimeMillis()); // exclude from benign rotation -- see injectTravel()
        int count = props.getVelocity().getCount();
        long spacingMs = (props.getVelocity().getWindowSeconds() * 1000L) / count;

        for (int i = 0; i < count; i++) {
            scheduler.schedule(() -> generator.addToStream(factory.benign(card)), i * spacingMs, TimeUnit.MILLISECONDS);
        }
        log.info("Injected VELOCITY: card={} count={} over {}s", card.cardId(), count, props.getVelocity().getWindowSeconds());
        return card.cardId();
    }

    /** One card, two legs with a simulated gapMinutes ts delta -- fires IMPOSSIBLE_TRAVEL. */
    public String injectTravel() {
        Card card = pool.randomCard();
        // Exclude this card from the benign generator's own rotation for its
        // standard 20s cooldown window -- otherwise an interleaved organic
        // transaction for the same card (any city) can land between the two
        // legs and get compared against them instead, producing a nonsensical
        // result (this was caught live: an injected Chennai leg got paired
        // against an organic transaction in the card's real home city a few
        // ms later). forceClaim reuses that existing cooldown clock as the
        // exclusion mechanism -- no new synchronization primitive needed, and
        // 20s comfortably covers this injector's few-second duration.
        card.forceClaim(System.currentTimeMillis());
        // Clear this card's travel-relevant window state too -- forceClaim only
        // stops *future* organic picks; it does nothing about history already
        // sitting in card:{c}:txns/:geo from before the injection call. Without
        // this, leg1 gets compared against the card's real (and irrelevant)
        // prior location the instant it lands, firing early on a nonsensical
        // pairing instead of waiting for leg2 (caught live: a Bengaluru->Chennai
        // "instant teleport" alert fired on leg1 alone, before Delhi ever landed).
        redis.delete(windows.cardTxnsKey(card.cardId()));
        redis.delete(windows.cardGeoKey(card.cardId()));

        ReferenceData.City from = ReferenceData.byName(props.getTravel().getFromCity());
        ReferenceData.City to = ReferenceData.byName(props.getTravel().getToCity());
        Merchant merchant = pool.randomMerchant();
        String ip = card.homeIpIds().get(0);
        int delaySeconds = props.getTravel().getSecondLegDelaySeconds();

        double amount1 = round2(ThreadLocalRandom.current().nextDouble(500, 3000));
        double amount2 = round2(ThreadLocalRandom.current().nextDouble(500, 3000));

        // ts is real wall-clock time throughout -- both legs, no simulated
        // future offset (§8 D-21). A short real gap over a long real
        // distance already implies an absurd speed; there is no need to
        // fake a longer gap, and doing so corrupts the shared window
        // infrastructure (see the comment above and D-21).
        long ts1 = System.currentTimeMillis();
        Map<String, String> leg1 = factory.custom(card.cardId(), amount1, merchant, from, card.homeDeviceId(), ip, ts1);
        generator.addToStream(leg1);

        scheduler.schedule(() -> {
            long ts2 = System.currentTimeMillis();
            Map<String, String> leg2 = factory.custom(card.cardId(), amount2, merchant, to, card.homeDeviceId(), ip, ts2);
            generator.addToStream(leg2);
        }, delaySeconds, TimeUnit.SECONDS);

        log.info("Injected TRAVEL: card={} {} -> {} ({}s real gap)",
            card.cardId(), from.name(), to.name(), delaySeconds);
        return card.cardId();
    }

    /** cardCount distinct cards onto one shared device + rotating shared IPs -- fires ENTITY_FANOUT. */
    public List<String> injectRing() {
        int n = props.getRing().getCardCount();
        // A fresh device/IP identity per call (§8 D-30) -- not the fixed
        // D-SEED-01/10.10.10.x that scripts/seed.mjs also uses. Reusing the
        // seed's identity meant every repeated injection (rehearsal, testing)
        // accumulated onto the SAME Neo4j device node, since MERGE never
        // resets state -- caught live: after three test injections sharing
        // that device, even the seeded ring's own query returned 102 cards
        // instead of 6. A fresh id per injection keeps each ring isolated.
        String deviceId = "D-INJ-" + java.util.UUID.randomUUID().toString().substring(0, 8).toUpperCase();
        List<String> ips = List.of(randomInjectedIp(), randomInjectedIp());
        long staggerMs = props.getRing().getStaggerSeconds() * 1000L;

        List<Card> shuffled = new ArrayList<>(pool.cards());
        Collections.shuffle(shuffled);
        List<Card> chosen = shuffled.subList(0, Math.min(n, shuffled.size()));

        List<String> cardIds = new ArrayList<>(chosen.size());
        for (int i = 0; i < chosen.size(); i++) {
            Card card = chosen.get(i);
            cardIds.add(card.cardId());
            String ip = ips.get(i % ips.size());
            long delay = i * staggerMs;
            scheduler.schedule(() -> {
                Merchant merchant = pool.randomMerchant();
                double amount = round2(ThreadLocalRandom.current().nextDouble(300, 5000));
                Map<String, String> fields = factory.custom(
                    card.cardId(), amount, merchant, card.homeCity(), deviceId, ip, System.currentTimeMillis());
                generator.addToStream(fields);
            }, delay, TimeUnit.MILLISECONDS);
        }

        log.info("Injected RING: {} cards -> device={} ips={}, staggered {}s apart",
            cardIds.size(), deviceId, ips, props.getRing().getStaggerSeconds());
        return cardIds;
    }

    private double round2(double v) {
        return Math.round(v * 100.0) / 100.0;
    }

    /** 10.20.x.x -- a range distinct from both the organic pool's IPs and the seed script's 10.10.10.x ring. */
    private String randomInjectedIp() {
        var rnd = ThreadLocalRandom.current();
        return "10.20." + rnd.nextInt(0, 256) + "." + rnd.nextInt(1, 255);
    }

    @PreDestroy
    void shutdown() {
        scheduler.shutdown();
    }
}
