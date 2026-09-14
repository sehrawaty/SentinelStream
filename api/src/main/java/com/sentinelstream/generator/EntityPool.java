package com.sentinelstream.generator;

import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.stereotype.Component;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Deque;
import java.util.List;
import java.util.Random;
import java.util.concurrent.ThreadLocalRandom;

/**
 * Builds the fixed simulation population once at startup: cards, devices,
 * IPs, merchants, and every card's home assignments.
 *
 * The device/IP assignment is the structural half of CLAUDE.md §8 D-04/D-19:
 * every device and every IP is capped at {@code maxCardsPerDevice} /
 * {@code maxCardsPerIp} cards *by construction*, so ENTITY_FANOUT cannot fire
 * on benign traffic regardless of runtime randomness or how long the demo
 * runs. This is a hard guarantee, not a statistical one.
 *
 * Built with a seeded {@link Random} so the population (card roster, home
 * assignments) is stable across restarts — useful for local dev. Runtime
 * transaction selection uses its own unseeded randomness (see
 * {@link GeneratorService}); the live stream itself is not meant to be
 * deterministic — only {@code seed.mjs} produces the fixed demo state.
 */
@Component
@EnableConfigurationProperties(GeneratorProperties.class)
public class EntityPool {

    private static final Logger log = LoggerFactory.getLogger(EntityPool.class);

    private final GeneratorProperties props;

    private List<Card> cards;
    private List<Merchant> merchants;

    public EntityPool(GeneratorProperties props) {
        this.props = props;
    }

    @PostConstruct
    void build() {
        Random rnd = new Random(props.getSeed());

        List<String> deviceIds = idList("D-", props.getDeviceCount());
        List<String> ipIds = generateIps(props.getIpCount(), rnd);
        this.merchants = buildMerchants(props.getMerchantCount());

        List<String> cardIds = idList("C-", props.getCardCount());
        Collections.shuffle(cardIds, rnd);

        // --- device assignment: exactly maxCardsPerDevice cards per device slot ---
        int perDevice = props.getMaxCardsPerDevice();
        int devicesNeeded = ceilDiv(props.getCardCount(), perDevice);
        if (devicesNeeded > deviceIds.size()) {
            throw new IllegalStateException(
                "deviceCount too small: need >= " + devicesNeeded + " to hold "
                    + props.getCardCount() + " cards at maxCardsPerDevice=" + perDevice);
        }

        // --- IP assignment: flat pool where each ip appears exactly maxCardsPerIp
        //     times, shuffled once — structurally caps every ip's card count. ---
        Deque<String> ipSlots = new ArrayDeque<>();
        List<String> flatIps = new ArrayList<>(ipIds.size() * props.getMaxCardsPerIp());
        for (String ip : ipIds) {
            for (int i = 0; i < props.getMaxCardsPerIp(); i++) {
                flatIps.add(ip);
            }
        }
        Collections.shuffle(flatIps, rnd);
        ipSlots.addAll(flatIps);

        List<ReferenceData.City> cities = ReferenceData.CITIES;
        List<Card> built = new ArrayList<>(props.getCardCount());

        for (int i = 0; i < cardIds.size(); i++) {
            String cardId = cardIds.get(i);
            String homeDevice = deviceIds.get(i / perDevice);
            ReferenceData.City homeCity = cities.get(rnd.nextInt(cities.size()));

            int ipCount = (rnd.nextDouble() < 0.7)
                ? props.getMinHomeIpsPerCard()
                : Math.max(props.getMinHomeIpsPerCard(), Math.min(props.getMaxHomeIpsPerCard(), 2));
            List<String> homeIps = new ArrayList<>(ipCount);
            int attempts = 0;
            while (homeIps.size() < ipCount && !ipSlots.isEmpty() && attempts < 20) {
                String candidate = ipSlots.pollFirst();
                if (homeIps.contains(candidate)) {
                    ipSlots.addLast(candidate); // retry later, avoid dup within same card
                    attempts++;
                    continue;
                }
                homeIps.add(candidate);
            }
            if (homeIps.isEmpty()) {
                // Extremely unlikely given the capacity headroom (§8 D-19), but fail
                // loudly rather than hand out a card with no egress IP.
                throw new IllegalStateException("IP pool exhausted while assigning card " + cardId
                    + " — increase ipCount or maxCardsPerIp");
            }

            built.add(new Card(cardId, homeDevice, List.copyOf(homeIps), homeCity));
        }

        this.cards = List.copyOf(built);

        log.info("EntityPool built: {} cards, {} devices (cap {}/device), {} ips (cap {}/ip), {} merchants",
            cards.size(), deviceIds.size(), perDevice, ipIds.size(), props.getMaxCardsPerIp(), merchants.size());
    }

    public List<Card> cards() { return cards; }
    public List<Merchant> merchants() { return merchants; }

    public Card randomCard() {
        return cards.get(ThreadLocalRandom.current().nextInt(cards.size()));
    }

    public Merchant randomMerchant() {
        return merchants.get(ThreadLocalRandom.current().nextInt(merchants.size()));
    }

    private static List<String> idList(String prefix, int count) {
        List<String> ids = new ArrayList<>(count);
        int width = String.valueOf(count).length();
        for (int i = 1; i <= count; i++) {
            ids.add(prefix + String.format("%0" + width + "d", i));
        }
        return ids;
    }

    private static List<String> generateIps(int count, Random rnd) {
        List<String> ips = new ArrayList<>(count);
        java.util.Set<String> seen = new java.util.HashSet<>();
        while (ips.size() < count) {
            int a = 1 + rnd.nextInt(223);
            int b = rnd.nextInt(256);
            int c = rnd.nextInt(256);
            int d = 1 + rnd.nextInt(254);
            String ip = a + "." + b + "." + c + "." + d;
            if (seen.add(ip)) {
                ips.add(ip);
            }
        }
        return ips;
    }

    private static List<Merchant> buildMerchants(int count) {
        List<ReferenceData.CategorySpec> categories = ReferenceData.CATEGORIES;
        List<Merchant> out = new ArrayList<>(count);
        int perCategory = Math.max(1, count / categories.size());
        int id = 1;
        for (ReferenceData.CategorySpec spec : categories) {
            for (int i = 0; i < perCategory && out.size() < count; i++) {
                String stem = spec.nameStems()[i % spec.nameStems().length];
                String name = i < spec.nameStems().length ? stem : stem + " " + (i + 1);
                out.add(new Merchant(String.format("M-%03d", id++), name, spec.category(), spec.mcc()));
            }
        }
        // top up if count isn't evenly divisible by category count
        int cat = 0;
        while (out.size() < count) {
            ReferenceData.CategorySpec spec = categories.get(cat % categories.size());
            out.add(new Merchant(String.format("M-%03d", id++), spec.nameStems()[0] + " " + id, spec.category(), spec.mcc()));
            cat++;
        }
        return out;
    }

    private static int ceilDiv(int a, int b) {
        return (a + b - 1) / b;
    }
}
