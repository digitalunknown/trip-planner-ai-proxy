// End-to-end tests for the /api/ai handler with a stubbed Gemini upstream.
// Run: node --test test/handler.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

process.env.GEMINI_API_KEY = "test-key";

const handler = (await import("../api/ai.js")).default;

const CHICAGO = { latitude: 41.8781, longitude: -87.6298, label: "Chicago, IL" };

/** Captures whatever the handler sends back. */
function makeRes() {
  const res = {
    statusCode: null,
    payload: null,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
  return res;
}

/** Stubs global fetch, returning `modelResult` as the Gemini candidate JSON. */
function stubGemini(modelResult) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    const next = Array.isArray(modelResult)
      ? modelResult[Math.min(calls.length - 1, modelResult.length - 1)]
      : modelResult;
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          candidates: [
            {
              finishReason: "STOP",
              content: { parts: [{ text: JSON.stringify(next) }] },
            },
          ],
        }),
    };
  };
  return calls;
}

function place(title, latitude, longitude, category = "other") {
  return {
    id: "",
    kind: "place",
    include: true,
    dayID: null,
    dayIndex: null,
    dayLabel: "",
    title,
    subtitle: "",
    location: title,
    notes: "Worth the drive.",
    startTime: null,
    endTime: null,
    checklistItemsText: "",
    flightFromCode: "",
    flightToCode: "",
    flightNumber: "",
    confidence: 0.8,
    sourceSnippet: title,
    category,
    latitude,
    longitude,
  };
}

const TRIP_SHELL = {
  name: "Long Weekend Getaway",
  destination: "Near Chicago, IL",
  isDatesSet: false,
  startDate: null,
  endDate: null,
  unscheduledDaysCount: 3,
  summary: "Options within a few hours of Chicago.",
  confidence: 0.7,
};

test("radius discovery from the Plan Trip sheet returns picks, not an itinerary", async () => {
  const calls = stubGemini({
    intent: "destination_discovery",
    clarificationNeeded: false,
    clarificationPrompt: "",
    trip: TRIP_SHELL,
    items: [
      place("Galena, IL", 42.4167, -90.4287),
      place("Saugatuck, MI", 42.6549, -86.2006),
      place("Lake Geneva, WI", 42.5917, -88.4334),
      // The failure mode from the bug report: famous, but ~1,700 miles away.
      place("Lake Tahoe, CA", 39.0968, -120.0324),
    ],
  });

  const res = makeRes();
  await handler(
    {
      method: "POST",
      body: {
        mode: "create_trip",
        text: "cool locations within a 5 hour drive of me for this upcoming labor day long weekend",
        userLocation: CHICAGO,
      },
    },
    res
  );

  assert.equal(res.statusCode, 200);
  const { routing, items } = res.payload;

  assert.equal(routing.resolvedMode, "recommendations");
  assert.equal(routing.deliverable, "destinations");
  assert.equal(routing.geoScope, "origin_radius");
  assert.equal(routing.isRecommendation, true);
  assert.equal(routing.driveHours, 5);
  assert.equal(routing.origin.label, "Chicago, IL");

  const titles = items.map((i) => i.title);
  assert.ok(!titles.includes("Lake Tahoe, CA"), "out-of-radius pick must be dropped");
  assert.deepEqual(titles, ["Galena, IL", "Saugatuck, MI", "Lake Geneva, WI"]);

  // Picks are unscheduled and carry coordinates.
  for (const item of items) {
    assert.equal(item.kind, "place");
    assert.equal(item.startTime, null);
    assert.equal(item.dayIndex, null);
    assert.equal(typeof item.latitude, "number");
  }

  // The origin and budget were actually handed to the model.
  const sent = JSON.parse(calls[0].contents[0].parts[0].text);
  assert.equal(sent.origin.latitude, CHICAGO.latitude);
  assert.equal(sent.travelBudget.driveHours, 5);
  assert.equal(sent.mode, "recommendations");

  // And the system prompt told it this is discovery, not a trip.
  const system = calls[0].systemInstruction.parts[0].text;
  assert.match(system, /DISCOVERY ask/);
  assert.match(system, /Lake Tahoe/, "should warn against habitual far-away picks");
  assert.doesNotMatch(system, /packing checklist/);
});

test("no coordinates for a \"near me\" ask asks where they are", async () => {
  const calls = stubGemini({});
  const res = makeRes();
  await handler(
    {
      method: "POST",
      body: {
        mode: "create_trip",
        text: "cool locations within a 5 hour drive of me this weekend",
      },
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.clarificationNeeded, true);
  assert.match(res.payload.clarificationPrompt, /starting from/i);
  assert.match(res.payload.clarificationPrompt, /5-hour drive/);
  assert.equal(calls.length, 0, "must not call Gemini just to guess a region");
});

test("a named multi-day trip still gets a full itinerary", async () => {
  const calls = stubGemini({
    intent: "full_itinerary",
    clarificationNeeded: false,
    clarificationPrompt: "",
    trip: {
      ...TRIP_SHELL,
      name: "Los Angeles Trip",
      destination: "Los Angeles, CA",
      unscheduledDaysCount: 5,
    },
    items: Array.from({ length: 9 }, (_, i) => ({
      ...place(`LA Stop ${i + 1}`, 34.05, -118.24, "attraction"),
      kind: "activity",
      dayIndex: i % 5,
      dayLabel: `Day ${(i % 5) + 1}`,
      startTime: "10:00",
      endTime: "12:00",
    })),
  });

  const res = makeRes();
  await handler(
    { method: "POST", body: { mode: "create_trip", text: "Plan a 5 day trip to Los Angeles" } },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.routing.resolvedMode, "create_trip");
  assert.equal(res.payload.routing.isRecommendation, false);
  assert.equal(res.payload.trip.destination, "Los Angeles, CA");
  assert.ok(res.payload.items.length >= 8);
  assert.match(calls[0].systemInstruction.parts[0].text, /You draft a NEW trip/);
});

test("accommodations around a named place return only stays", async () => {
  const calls = stubGemini({
    intent: "stay_recommendations",
    clarificationNeeded: false,
    clarificationPrompt: "",
    trip: TRIP_SHELL,
    items: [
      place("Hotel Figueroa, Los Angeles, CA", 34.0407, -118.2662, "hotel"),
      place("The Line Hotel, Los Angeles, CA", 34.0616, -118.2938, "hotel"),
    ],
  });

  const res = makeRes();
  await handler(
    {
      method: "POST",
      body: { mode: "create_trip", text: "Find accommodations around Los Angeles" },
    },
    res
  );

  assert.equal(res.payload.routing.deliverable, "stays");
  assert.equal(res.payload.routing.isRecommendation, true);
  assert.ok(res.payload.items.every((i) => i.category === "hotel"));

  // Schema must only permit hotels for a stays ask.
  const schema = calls[0].generationConfig.responseSchema;
  assert.deepEqual(schema.properties.items.items.properties.category.enum, ["hotel"]);
});

test("place_finder keeps its own prompt and drops out-of-radius picks", async () => {
  stubGemini({
    intent: "place_discovery",
    clarificationNeeded: false,
    clarificationPrompt: "",
    items: [
      place("Alinea, Chicago, IL", 41.9134, -87.6487, "restaurant"),
      place("Swan Oyster Depot, San Francisco, CA", 37.7909, -122.4213, "restaurant"),
    ],
  });

  const res = makeRes();
  await handler(
    {
      method: "POST",
      body: {
        mode: "place_finder",
        text: "best restaurants within 30 miles of me",
        userLocation: CHICAGO,
      },
    },
    res
  );

  const titles = res.payload.items.map((i) => i.title);
  assert.deepEqual(titles, ["Alinea, Chicago, IL"]);
  assert.equal(res.payload.routing.resolvedMode, "place_finder");
});
