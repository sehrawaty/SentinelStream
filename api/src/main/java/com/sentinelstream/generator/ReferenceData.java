package com.sentinelstream.generator;

import java.util.List;

/**
 * CLAUDE.md §4.6 — pinned 12-city reference set. Travel-detector correctness
 * (Part 5 of the pipeline evidence, and the impossible-travel injector) depends
 * on these exact coordinates, so this list must not drift independently of §4.6.
 */
public final class ReferenceData {

    public record City(String name, double lat, double lon) {}

    public static final List<City> CITIES = List.of(
        new City("Delhi",      28.6139, 77.2090),
        new City("Mumbai",     19.0760, 72.8777),
        new City("Chennai",    13.0827, 80.2707),
        new City("Bengaluru",  12.9716, 77.5946),
        new City("Kolkata",    22.5726, 88.3639),
        new City("Hyderabad",  17.3850, 78.4867),
        new City("Ahmedabad",  23.0225, 72.5714),
        new City("Jaipur",     26.9124, 75.7873),
        new City("Lucknow",    26.8467, 80.9462),
        new City("Kochi",       9.9312, 76.2673),
        new City("Guwahati",   26.1445, 91.7362),
        new City("Pune",       18.5204, 73.8567)
    );

    public static City byName(String name) {
        return CITIES.stream()
            .filter(c -> c.name().equals(name))
            .findFirst()
            .orElseThrow(() -> new IllegalArgumentException("Unknown city: " + name));
    }

    /**
     * Merchant category catalogue — display name pool, plausible MCC, and the
     * typical ticket (INR) at that kind of merchant. The ticket is what ties a
     * card to the categories it shops in (§8 D-35); per-transaction amounts
     * come from the card's own profile, not from the category.
     */
    public record CategorySpec(String category, String mcc, String[] nameStems, double typicalTicket) {}

    public static final List<CategorySpec> CATEGORIES = List.of(
        new CategorySpec("GROCERY",       "5411", new String[]{"FreshMart", "DailyBazaar", "SuperStop"},      600),
        new CategorySpec("APPAREL",       "5651", new String[]{"Pothys", "StyleHub", "Threads Co"},          1800),
        new CategorySpec("ELECTRONICS",   "5732", new String[]{"CircuitPoint", "GadgetWorld", "ByteBazaar"}, 8000),
        new CategorySpec("FUEL",          "5541", new String[]{"HP Petrol", "IndianOil", "BharatPump"},      1200),
        new CategorySpec("DINING",        "5812", new String[]{"Spice Route", "Cafe Noir", "Urban Tadka"},    900),
        new CategorySpec("TRAVEL",        "4722", new String[]{"SkyBook", "RailYatri", "TripCart"},          5000),
        new CategorySpec("PHARMACY",      "5912", new String[]{"MedPlus", "Apollo Pharmacy", "WellCare"},     400),
        new CategorySpec("ENTERTAINMENT", "7832", new String[]{"CineMax", "PlayZone", "MusicHall"},           700),
        new CategorySpec("UTILITIES",     "4900", new String[]{"PowerGrid Pay", "AquaBill", "GasLine"},      1500),
        new CategorySpec("JEWELRY",       "5944", new String[]{"Tanishq", "GoldLeaf", "Kundan House"},     15000)
    );

    public static CategorySpec category(String name) {
        return CATEGORIES.stream()
            .filter(c -> c.category().equals(name))
            .findFirst()
            .orElseThrow(() -> new IllegalArgumentException("Unknown category: " + name));
    }

    private ReferenceData() {}
}
