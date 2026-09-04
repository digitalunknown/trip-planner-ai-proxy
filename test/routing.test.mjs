// Routing tests for the AI proxy's ask classifier.
// Run: node --test test/
import test from "node:test";
import assert from "node:assert/strict";

import { __testables } from "../api/ai.js";

const {
  DELIVERABLES,
  resolveAskPlan,
  resolveOrigin,
  parseTravelRadius,
  mentionsOrigin,
  haversineMiles,
  enforceTravelRadius,
  stripClientBoilerplate,
} = __testables;

// Chicago — deliberately nowhere near the regions the model used to default to.
const CHICAGO = { latitude: 41.8781, longitude: -87.6298, label: "Chicago, IL" };

function plan(text, { mode = "create_trip", origin = null, tripContext = {} } = {}) {
  return resolveAskPlan({ mode, text, tripContext, origin });
}

test("parses a drive-time budget into miles", () => {
  const radius = parseTravelRadius("cool locations within a 5 hour drive of me");
  assert.equal(radius.driveHours, 5);
  assert.ok(radius.miles > 200 && radius.miles < 350);
});

test("parses explicit distance units", () => {
  assert.equal(parseTravelRadius("beaches within 150 miles").miles, 150);
  assert.equal(parseTravelRadius("towns within 200 km").miles, 124);
  assert.equal(parseTravelRadius("plan a trip to Los Angeles"), null);
});

test("detects that distance is measured from the user", () => {
  assert.ok(mentionsOrigin("cool locations within a 5 hour drive of me"));
  assert.ok(mentionsOrigin("good restaurants near me"));
  assert.ok(mentionsOrigin("what's nearby this weekend"));
  assert.ok(!mentionsOrigin("plan a 5 day trip to Los Angeles"));
});

test("the reported failure: radius discovery is not an itinerary", () => {
  const p = plan("cool locations within a 5 hour drive of me for this upcoming labor day long weekend", {
    origin: CHICAGO,
  });
  assert.equal(p.geoScope, "origin_radius");
  assert.equal(p.deliverable, DELIVERABLES.DESTINATIONS);
  assert.equal(p.isRecommendation, true);
  assert.equal(p.radius.driveHours, 5);
  assert.equal(p.origin.label, "Chicago, IL");
});

test("a holiday or duration alone never forces an itinerary", () => {
  const p = plan("where should we go for labor day weekend", { origin: CHICAGO });
  assert.equal(p.isRecommendation, true);
  assert.notEqual(p.deliverable, DELIVERABLES.FULL_ITINERARY);
});

test("\"near me\" with no coordinates asks instead of guessing", () => {
  const p = plan("cool spots within 3 hours of me");
  assert.equal(p.needsOrigin, true);
  assert.equal(p.origin, null);
});

test("scenario: plan a 5 day trip to Los Angeles", () => {
  const p = plan("Plan a 5 day trip to Los Angeles");
  assert.equal(p.deliverable, DELIVERABLES.FULL_ITINERARY);
  assert.equal(p.isRecommendation, false);
  assert.equal(p.needsOrigin, false);
});

test("scenario: find accommodations around a named place", () => {
  const p = plan("Find accommodations around Los Angeles");
  assert.equal(p.deliverable, DELIVERABLES.STAYS);
  assert.equal(p.isRecommendation, true);
  assert.equal(p.geoScope, "named_destination");
});

test("a single-kind ask inside a trip stays a recommendation", () => {
  const p = plan("find hotels for my 5 day trip to Los Angeles");
  assert.equal(p.deliverable, DELIVERABLES.STAYS);
  assert.equal(p.isRecommendation, true);
});

test("explicit itinerary language still wins", () => {
  const p = plan("plan my trip to Lisbon day by day with great restaurants");
  assert.equal(p.deliverable, DELIVERABLES.FULL_ITINERARY);
});

test("restaurant and activity asks route to their own kind", () => {
  assert.equal(
    plan("best restaurants in Mexico City", { mode: "place_finder" }).deliverable,
    DELIVERABLES.RESTAURANTS
  );
  assert.equal(
    plan("things to do in Toronto", { mode: "place_finder" }).deliverable,
    DELIVERABLES.ACTIVITIES
  );
});

test("origin comes from userLocation, then trip context", () => {
  const fromBody = resolveOrigin({ userLocation: CHICAGO }, {});
  assert.equal(fromBody.source, "user_location");

  const fromTrip = resolveOrigin({}, { latitude: 45.42, longitude: -75.69, destination: "Ottawa" });
  assert.equal(fromTrip.source, "trip_context");

  assert.equal(resolveOrigin({ userLocation: { latitude: 0, longitude: 0 } }, {}), null);
});

test("radius filter drops the far-away famous destination", () => {
  const p = plan("cool locations within a 5 hour drive of me", { origin: CHICAGO });
  const items = [
    { title: "Lake Tahoe, CA", latitude: 39.0968, longitude: -120.0324 },
    { title: "Galena, IL", latitude: 42.4167, longitude: -90.4287 },
    { title: "Saugatuck, MI", latitude: 42.6549, longitude: -86.2006 },
    { title: "Unknown coords", latitude: null, longitude: null },
  ];
  const { items: kept, dropped } = enforceTravelRadius(items, p);
  const keptTitles = kept.map((i) => i.title);

  assert.ok(!keptTitles.includes("Lake Tahoe, CA"), "Tahoe is ~1,700 mi from Chicago");
  assert.deepEqual(keptTitles, ["Galena, IL", "Saugatuck, MI", "Unknown coords"]);
  assert.equal(dropped.length, 1);
  assert.ok(dropped[0].miles > 1000);
});

test("client-appended itinerary boilerplate does not skew the classifier", () => {
  // What the iOS Plan Trip sheet actually sends for the reported prompt.
  const sent =
    "cool locations within a 5 hour drive of me for this upcoming labor day long weekend\n\n" +
    "Return a full_itinerary draft with at least 8 items for this 3-day trip: 1 hotel, " +
    "a few real restaurants/cafes, activities spread across dayIndex 0…2, 1 packing checklist, " +
    "and 1–2 reminders. Include startTime/endTime (HH:mm) on venue activities.";

  const stripped = stripClientBoilerplate(sent);
  assert.ok(!stripped.includes("full_itinerary"));
  assert.ok(!stripped.includes("hotel"));

  const p = plan(stripped, { origin: CHICAGO });
  assert.equal(p.deliverable, DELIVERABLES.DESTINATIONS);
  assert.equal(p.isRecommendation, true);

  // Without stripping, the boilerplate's own "1 hotel, restaurants, activities"
  // hijacks the deliverable away from the destinations the user asked for.
  assert.notEqual(plan(sent, { origin: CHICAGO }).deliverable, DELIVERABLES.DESTINATIONS);
});

test("an ask naming several kinds stays mixed rather than picking one", () => {
  // The Find Places "Best of {city}" chip sends exactly this.
  const p = plan(
    "Suggest 10 of the best places to save in Toronto — mix restaurants, attractions, and stays.",
    { mode: "place_finder" }
  );
  assert.equal(p.deliverable, DELIVERABLES.MIXED_PLACES);
});

test("stripping leaves an ordinary prompt untouched", () => {
  assert.equal(
    stripClientBoilerplate("Plan a 5 day trip to Los Angeles"),
    "Plan a 5 day trip to Los Angeles"
  );
});

test("a radius with its own named anchor does not hijack the device location", () => {
  const p = plan("best restaurants within 30 miles of Chicago", { mode: "place_finder" });
  assert.equal(p.geoScope, "named_destination");
  assert.equal(p.needsOrigin, false, "must not ask where they are — Chicago was named");
  assert.equal(p.radius.miles, 30);
  assert.equal(p.radiusCheckMiles, null, "distance must not be measured from the device");
});

test("a named-anchor radius is never filtered against a far-away device origin", () => {
  const SF = { latitude: 37.7749, longitude: -122.4194, label: "San Francisco, CA" };
  const p = resolveAskPlan({
    mode: "place_finder",
    text: "hotels within 20 miles of Chicago",
    tripContext: {},
    origin: SF,
  });
  const items = [{ title: "The Langham, Chicago", latitude: 41.8879, longitude: -87.6343 }];
  const { items: kept, dropped } = enforceTravelRadius(items, p);
  assert.equal(kept.length, 1, "Chicago hotels must survive a San Francisco device origin");
  assert.equal(dropped.length, 0);
});

test("an internal refill prompt stays an itinerary", () => {
  // The app's own refill text: mentions a hotel and a "packing list", and must
  // not be reclassified as a stays or destinations ask mid-flow.
  const refill = [
    "Fill a COMPLETE 3-day itinerary for Galena, IL. Intent=full_itinerary.",
    'Trip name "Galena Weekend". unscheduledDaysCount=3.',
    "Previous answer only returned 1 item(s) — that is invalid (never hotel-only).",
    "Return at least 8 items covering ALL slots:",
    "1. kind=activity category=hotel dayIndex=0 — real hotel in Galena, IL",
    "2. cafe dayIndex=0 (Day 1) one real venue with startTime/endTime",
    "3. checklist packing list (6 lines)",
    "4. reminder prep task",
  ].join("\n");

  const p = plan(refill, { origin: CHICAGO });
  assert.equal(p.deliverable, DELIVERABLES.FULL_ITINERARY);
  assert.equal(p.isRecommendation, false);
});

test("no schema requires coordinates", () => {
  // Gemini 400s on this object schema once `required` grows alongside a high
  // `minItems`. Adding latitude/longitude here broke Find Places entirely, so
  // coordinates must stay optional in the schema and be asked for in the prompt.
  const {
    buildPlaceFinderSchema,
    buildRecommendationSchema,
    buildPlanDaySchema,
    buildCreateTripSchema,
  } = __testables;

  const schemas = {
    place_finder: buildPlaceFinderSchema(10),
    recommendations: buildRecommendationSchema(
      { deliverable: DELIVERABLES.DESTINATIONS },
      10,
      { includeTripShell: true }
    ),
    plan_day: buildPlanDaySchema(8),
    create_trip: buildCreateTripSchema(8),
  };

  for (const [name, schema] of Object.entries(schemas)) {
    const required = schema.properties.items.items.required;
    assert.ok(!required.includes("latitude"), `${name} must not require latitude`);
    assert.ok(!required.includes("longitude"), `${name} must not require longitude`);
    // They must still be offered, or the model has no way to return them.
    assert.ok(schema.properties.items.items.properties.latitude, `${name} should offer latitude`);
  }
});

test("haversine sanity check", () => {
  const miles = haversineMiles(CHICAGO, { latitude: 39.0968, longitude: -120.0324 });
  assert.ok(miles > 1600 && miles < 1800, `got ${miles}`);
});
