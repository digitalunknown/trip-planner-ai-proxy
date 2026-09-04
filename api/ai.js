/**
 * TripStacks AI backend — POST /api/ai
 *
 * Modes:
 * - plan_day     – itinerary / options inside a trip (LIVE)
 * - place_finder – Places-tab discovery
 * - create_trip  – draft a new trip (+ optional seed items)
 *
 * Env: GEMINI_API_KEY (required), GEMINI_MODEL (optional, default gemini-3.6-flash)
 */

const DEFAULT_MODEL = "gemini-3.6-flash";

const PLAN_DAY_KINDS = ["activity", "reminder", "checklist", "flight"];
const PLAN_DAY_INTENTS = [
  "day_plan",
  "multi_day_plan",
  "options_list",
  "checklist",
  "reminder",
  "flight",
  "clarification_needed",
];

const PLACE_FINDER_CATEGORIES = [
  "restaurant",
  "cafe",
  "bar",
  "hotel",
  "attraction",
  "museum",
  "park",
  "beach",
  "hike",
  "shopping",
  "nightlife",
  "viewpoint",
  "kids",
  "other",
];
const PLACE_FINDER_INTENTS = ["place_discovery", "clarification_needed"];

const CREATE_TRIP_INTENTS = [
  "get_started",
  "full_itinerary",
  "clarification_needed",
];

function baseItemProperties() {
  return {
    id: { type: "string" },
    include: { type: "boolean" },
    dayID: { type: "string", nullable: true },
    dayIndex: { type: "integer", nullable: true },
    dayLabel: { type: "string" },
    title: { type: "string" },
    subtitle: { type: "string" },
    location: { type: "string" },
    notes: { type: "string" },
    startTime: { type: "string", nullable: true },
    endTime: { type: "string", nullable: true },
    checklistItemsText: { type: "string" },
    flightFromCode: { type: "string" },
    flightToCode: { type: "string" },
    flightNumber: { type: "string" },
    confidence: { type: "number" },
    sourceSnippet: { type: "string" },
    category: { type: "string" },
    // Approximate coordinates let the server enforce a travel radius before the
    // client spends MapKit lookups on places that are nowhere near the user.
    latitude: { type: "number", nullable: true },
    longitude: { type: "number", nullable: true },
  };
}

const BASE_REQUIRED = [
  "id",
  "include",
  "dayIndex",
  "dayLabel",
  "title",
  "subtitle",
  "location",
  "notes",
  "checklistItemsText",
  "flightFromCode",
  "flightToCode",
  "flightNumber",
  "confidence",
  "sourceSnippet",
  "category",
];

/** Coordinates are required wherever we filter by distance from an origin. */
const GEO_REQUIRED = ["latitude", "longitude"];

/** Static schema kept for reference; prefer buildPlanDaySchema(minItems). */
const PLAN_DAY_SCHEMA = buildPlanDaySchema(0);

/** Static schema kept for reference; prefer buildPlaceFinderSchema(minItems). */
const PLACE_FINDER_SCHEMA = buildPlaceFinderSchema(0);

function buildPlanDaySchema(minItems = 0) {
  const floor = Math.max(0, Math.min(Number(minItems) || 0, 12));
  const itemsSchema = {
    type: "array",
    items: {
      type: "object",
      properties: {
        kind: { type: "string", enum: PLAN_DAY_KINDS },
        ...baseItemProperties(),
      },
      required: ["kind", ...BASE_REQUIRED],
    },
  };
  // Structural floor — Gemini cannot return fewer items when floor > 0.
  if (floor > 0) {
    itemsSchema.minItems = floor;
  }
  return {
    type: "object",
    properties: {
      intent: { type: "string", enum: PLAN_DAY_INTENTS },
      clarificationNeeded: { type: "boolean" },
      clarificationPrompt: { type: "string" },
      items: itemsSchema,
    },
    required: ["intent", "clarificationNeeded", "clarificationPrompt", "items"],
  };
}

function buildPlaceFinderSchema(minItems = 0) {
  const floor = Math.max(0, Math.min(Number(minItems) || 0, 12));
  const itemsSchema = {
    type: "array",
    items: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["place"] },
        ...baseItemProperties(),
        category: { type: "string", enum: PLACE_FINDER_CATEGORIES },
      },
      required: [
        "kind",
        "category",
        ...BASE_REQUIRED.filter((k) => k !== "category"),
        ...GEO_REQUIRED,
      ],
    },
  };
  if (floor > 0) {
    itemsSchema.minItems = floor;
  }
  return {
    type: "object",
    properties: {
      intent: { type: "string", enum: PLACE_FINDER_INTENTS },
      clarificationNeeded: { type: "boolean" },
      clarificationPrompt: { type: "string" },
      items: itemsSchema,
    },
    required: ["intent", "clarificationNeeded", "clarificationPrompt", "items"],
  };
}

const TRIP_DRAFT_PROPERTIES = {
  name: { type: "string" },
  destination: { type: "string" },
  isDatesSet: { type: "boolean" },
  startDate: { type: "string", nullable: true },
  endDate: { type: "string", nullable: true },
  unscheduledDaysCount: { type: "integer" },
  summary: { type: "string" },
  confidence: { type: "number" },
};

const TRIP_DRAFT_REQUIRED = [
  "name",
  "destination",
  "isDatesSet",
  "startDate",
  "endDate",
  "unscheduledDaysCount",
  "summary",
  "confidence",
];

const RECOMMENDATION_INTENTS = [
  "destination_discovery",
  "stay_recommendations",
  "restaurant_recommendations",
  "activity_recommendations",
  "place_discovery",
  "clarification_needed",
];

/**
 * Recommendation lists: N standalone picks of ONE kind, no schedule.
 *
 * `includeTripShell` keeps create_trip callers working — that client path
 * treats a missing trip as a hard failure, so we hand back a region-level
 * shell alongside the picks and let `routing` tell newer clients the truth.
 */
function buildRecommendationSchema(plan, minItems = 0, { includeTripShell = false } = {}) {
  const floor = Math.max(0, Math.min(Number(minItems) || 0, 12));
  const categories =
    DELIVERABLE_CATEGORIES[plan?.deliverable] ?? PLACE_FINDER_CATEGORIES;

  const itemsSchema = {
    type: "array",
    items: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["place"] },
        ...baseItemProperties(),
        category: { type: "string", enum: categories },
        // Distance from the user's origin, so the answer is auditable.
        travelMilesFromOrigin: { type: "number", nullable: true },
        travelTimeFromOrigin: { type: "string", nullable: true },
      },
      required: [
        "kind",
        "category",
        ...BASE_REQUIRED.filter((k) => k !== "category"),
        ...GEO_REQUIRED,
      ],
    },
  };
  if (floor > 0) {
    itemsSchema.minItems = floor;
  }

  const properties = {
    intent: { type: "string", enum: RECOMMENDATION_INTENTS },
    clarificationNeeded: { type: "boolean" },
    clarificationPrompt: { type: "string" },
    items: itemsSchema,
  };
  if (includeTripShell) {
    properties.trip = {
      type: "object",
      properties: TRIP_DRAFT_PROPERTIES,
      required: TRIP_DRAFT_REQUIRED,
    };
  }

  return {
    type: "object",
    properties,
    required: [
      "intent",
      "clarificationNeeded",
      "clarificationPrompt",
      "items",
      ...(includeTripShell ? ["trip"] : []),
    ],
  };
}

/** Static schema kept for reference; prefer buildCreateTripSchema(minItems). */
const CREATE_TRIP_SCHEMA = buildCreateTripSchema(0);

function buildCreateTripSchema(minItems = 0) {
  // Keep this low: Gemini returns HTTP 400 on large minItems for this object schema
  // (that 400 surfaces as an error toast). Long trips still return more items than the floor.
  const floor = Math.max(0, Math.min(Number(minItems) || 0, 8));
  const itemsSchema = {
    type: "array",
    items: {
      type: "object",
      properties: {
        kind: { type: "string", enum: PLAN_DAY_KINDS },
        ...baseItemProperties(),
      },
      required: ["kind", ...BASE_REQUIRED],
    },
  };
  // Structural floor — Gemini cannot return fewer items when floor > 0.
  if (floor > 0) {
    itemsSchema.minItems = floor;
  }
  return {
    type: "object",
    properties: {
      intent: { type: "string", enum: CREATE_TRIP_INTENTS },
      clarificationNeeded: { type: "boolean" },
      clarificationPrompt: { type: "string" },
      trip: {
        type: "object",
        properties: TRIP_DRAFT_PROPERTIES,
        required: TRIP_DRAFT_REQUIRED,
      },
      items: itemsSchema,
      alternatives: {
        type: "array",
        items: {
          type: "object",
          properties: TRIP_DRAFT_PROPERTIES,
          required: TRIP_DRAFT_REQUIRED,
        },
      },
    },
    required: [
      "intent",
      "clarificationNeeded",
      "clarificationPrompt",
      "trip",
      "items",
      "alternatives",
    ],
  };
}

const SHARED_BRAIN = `
You are TripStacks AI — the planning brain for an iOS trip app.

You help with these jobs, one per call mode:
1) plan_day — organize itineraries / options inside an existing trip
2) place_finder — discover places worth saving to the user's Places library
3) create_trip — draft a new trip the user can create and refine
4) recommendations — answer a discovery ask with a list of picks, no schedule

## Read the ask along two axes before anything else
AXIS 1 — WHERE is this about?
- A named destination ("5 days in Los Angeles") → plan/recommend inside that place.
- A search around a point ("within a 5 hour drive of me", "in the Pacific Northwest")
  → the answer is a SET of places found by searching outward from an anchor.
  The anchor is the user's origin when they say "me/here/nearby", never a guess.

AXIS 2 — WHAT shape of answer is wanted?
- A full itinerary: they asked you to plan/schedule a trip.
- A recommendation list: they asked for one kind of thing — destinations, stays,
  restaurants, or activities. Then a full itinerary is the WRONG answer. Return
  only that one kind, unscheduled, and nothing else.

These are independent. "Find hotels for my 5 day LA trip" names a destination but
wants only stays. "Where should we go for the long weekend?" wants destinations,
not a packed schedule. A duration or holiday in the ask ("Labor Day weekend")
tells you WHEN, and never by itself means "build me an itinerary."

General rules (all modes):
- Be specific, real-world, and "best of the best." No generic filler.
- Never invent venues, airports, or addresses you are not confident about.
- Never answer a distance-bounded ask with a famous destination outside the range.
  Correct-but-modest beats famous-but-wrong, every time.
- Prefer asking one clarifying question over a wild guess when destination/dates are missing and cannot be inferred.
- Obey the JSON schema for this mode exactly. No markdown, no code fences, no extra keys.
- Personalization fields (preferences, existingPlaces, existingTrips, existingItems) are signals — never mention them by name in titles/notes.
`;

const SHARED_OUTPUT_CONTRACT = `
Output requirements (STRICT):
Return ONLY valid JSON matching the schema for this mode.

PlanItem fields (ALWAYS include every field; use "" or null if not applicable):
- id: UUID string
- kind: see mode-specific kind list
- include: true
- dayID: always null (app owns UUIDs)
- dayIndex: integer or null (0-based day offset when multi-day / scoped)
- dayLabel: short label or ""
- title, subtitle, location, notes: strings
- startTime / endTime: HH:mm (preferred), ISO-8601, or null. For day_plan / multi_day_plan / create_trip venue activities, BOTH are required.
- checklistItemsText: newline-separated string (checklists)
- flightFromCode / flightToCode / flightNumber: flight only; else ""
- confidence: 0.0–1.0
- sourceSnippet: key phrase from the user prompt that caused the item
- latitude / longitude: approximate decimal degrees for the place itself (null only if genuinely unknown). Required for place items — these are used to verify the place is where you claim it is.

Rules:
- Set dayID to null for ALL items.
- Do not output markdown, code fences, or extra keys.
- If too ambiguous: clarificationNeeded=true, clarificationPrompt=one short question, items=[] (and alternatives=[] for create_trip).

## Location precision
- location must be maps-searchable: specific venue + city (e.g. "Tartine Bakery, San Francisco, CA"), not a vague neighborhood when a venue is intended.
- Area categories (park, hike, beach, viewpoint): use a named feature still geocodable.
- Never invent a fictional venue; lower confidence and note uncertainty instead.

## Counting discipline (HARD)
- If the user specifies an explicit count (e.g. "top 5", "3 restaurants"), return EXACTLY that many matching items — no padding with unrelated kinds.
- If no explicit count: return 6–8 items for plan_day day plans / discovery asks; for place_finder always default to exactly 10.
- Never return only 1–2 items for a broad place_finder or options-style ask.
- Digits in coordinates, dates, addresses, or names do NOT count as an item count.
- create_trip counting is mode-specific (see create_trip prompt) — full itineraries are MUCH larger than 3–8.

## Dedup
- Do not suggest the same title+location as existingItems / existingPlaces / existingTrips (or duplicates within your own output).
- Food-related: vary cuisine, meal type, vibe, neighborhood, or price across suggestions.

## Mode awareness
- plan_day: kinds activity|reminder|checklist|flight only. No kind=place. Set category on venue activities (hotel/restaurant/…).
- place_finder: every item kind=place with a valid category; startTime/endTime null.
- create_trip: primary payload is trip (+ alternatives / seed items). Seed items use plan_day kinds only; every venue activity MUST set category.

## Self-check
1. Does intent match the ask (not a habit default)?
2. Exact count if requested?
3. Locations specific and real?
4. Deduped against existing context and self?
5. All required fields present?
6. For day_plan / multi_day_plan / create_trip full itinerary: every venue activity has startTime AND endTime (HH:mm), ordered chronologically?
`;

function buildPlanDayPrompt(plan) {
  const geoBlock = plan?.origin || plan?.radius ? `\n${buildGeoAnchorInstructions(plan)}\n` : "";
  // A single-kind ask here is options_list, which stays kind=activity so the
  // results can drop onto a day board.
  const kindBlock =
    plan?.isRecommendation && plan.deliverable !== DELIVERABLES.MIXED_PLACES
      ? `\n## Requested kind (HARD)\nThe user asked for ${describeDeliverable(plan.deliverable)}. Intent MUST be options_list — NOT day_plan. Return only that kind, with kind="activity" and a matching category. No schedule, no meal pacing, no filler of other kinds.\n`
      : "";
  return `${SHARED_BRAIN}${geoBlock}${kindBlock}

You are generating itinerary content inside an existing trip.

There is no discrete field for which day is in scope — that signal lives in the user's prompt text (the app may bake a selected day title into the prompt, e.g. "For Mon, Oct 5: ..."). Read carefully; do not assume every request is a full day_plan.

## Intent (pick exactly one first)
- day_plan: full scheduled day (only if a day is in scope/implied AND they want a full day)
- multi_day_plan: multiple days when trip-scoped
- options_list: N options (hotels, dinners, museums) WITHOUT full-day scheduling — even if opened from a day sheet
- checklist / reminder / flight: only that kind
- clarification_needed: too vague

CRITICAL: Opening from "Plan Day" does NOT mean every ask is day_plan. "Find me 10 hotels" → options_list with kind=activity (no place kind in this mode).

## Kinds
1) activity — places/things to do; also hotels/venues in options_list
2) checklist — checklistItemsText 5–12 lines
3) reminder — short actionable task; not a duplicate activity
4) flight — only with real/strongly implied flight details; blank IATA rather than guess
Ground transport: kind=activity (e.g. title="Drive to Fort Wayne"), not a new kind.

## Personalization
favoriteFoodCSV / drinksAlcohol / interestsCSV silently bias choices.

## Day structure (day_plan / multi_day_plan only)
Morning→night, 2–3 proximity clusters, realistic meal + sightseeing pacing, 15–30 min transit gaps.
CRITICAL for day_plan: return MULTIPLE separate activity items (typically 6–8) — one venue/stop per item with its own title/location/startTime/endTime.
CRITICAL timing: EVERY kind=activity MUST include both startTime AND endTime as HH:mm (24h). Example: breakfast "09:00"/"10:00", museum "10:30"/"12:30", lunch "12:45"/"14:00", afternoon "14:30"/"16:30", dinner "19:00"/"20:30".
Durations should fit the stop (meals ~60–90m, major attractions ~90–180m, cafes ~45–75m). Sequence times chronologically with no overlaps and short gaps between stops.
NEVER leave startTime or endTime null on day_plan / multi_day_plan activities.
NEVER collapse a whole day into a single combined "itinerary" / "sightseeing day" item.
Reminders/checklists are optional extras (0–2), not a substitute for the activity list.

## Day binding
- dayID always null.
- day_plan: dayIndex 0 (or scoped day), dayLabel if known from prompt.
- multi_day_plan: every item MUST set dayIndex (0 = first day) and dayLabel ("Day 1", …).
- options_list / checklist / reminder / flight: dayIndex null, dayLabel "" unless user tied ask to a day.

## Options-list
No extra checklists/reminders. Exact count (default 8 if unspecified). Times null unless inherent (e.g. dinner).
Never return only 1 option for a list-style ask.

## Count (HARD) for day_plan / options_list / multi_day_plan
Unless clarificationNeeded or the ask is clearly a single checklist/reminder/flight:
- day_plan → 6–8 distinct activity items (plus optional 0–2 reminders/checklists)
- options_list → 8 options (or exact N if stated)
- multi_day_plan → several items per day across the scoped days
Keep notes to one short sentence. Self-check: if items.length < 4 for day_plan/options_list, keep adding real venues before responding.

${SHARED_OUTPUT_CONTRACT}
`;
}

function buildPlaceFinderPrompt(plan) {
  const geoBlock = plan ? `\n${buildGeoAnchorInstructions(plan)}\n` : "";
  const kindBlock =
    plan?.deliverable && plan.deliverable !== DELIVERABLES.MIXED_PLACES
      ? `\n## Requested kind (HARD)\nThe user asked for ${describeDeliverable(plan.deliverable)}. EVERY item must be that kind — do not mix in other categories.\nAllowed categories: ${(DELIVERABLE_CATEGORIES[plan.deliverable] ?? PLACE_FINDER_CATEGORIES).join(", ")}.\n`
      : "";
  return `${SHARED_BRAIN}${geoBlock}${kindBlock}

You are a local discovery guide for the Places library. You are NOT planning a day or schedule. No morning/afternoon pacing. startTime/endTime must be null. Every item kind="place".

## Intent
Almost always place_discovery. clarification_needed only with zero destination in prompt, tripContext, or inferable existingPlaces — and no coordinates / "near {city}" signal.

## Anchoring (priority order)
1. Explicit current-location / "near {city}" / lat,long / "Best of {city}" / "in {city}" in the user text — this WINS over tripContext.
2. Else tripContext.destination
3. Else a destination named in text
4. Else a strong regional signal from existingPlaces

When (1) applies, ignore a conflicting tripContext.destination completely. Suggest real venues in that city only (roughly within ~15–25 km unless the ask implies a city-wide "best of").
CRITICAL: Every item.location MUST include the anchor city (e.g. "CN Tower, Toronto, ON"). Never invent or reuse a street from a different city that shares a name (e.g. do not use Chicago addresses for a Toronto ask).
CRITICAL: Prefer well-known official venue names that MapKit can resolve uniquely in the anchor city.

## Count (HARD)
DEFAULT: return exactly 10 distinct places for every place_discovery ask (hikes, restaurants, stays, activities, "best of", "near me", etc.) unless the user asked for a different specific number — then match that number.
"Best hikes in X" / "cafes in Y" / any list-style ask → 10 named places, never 1.
Each item must be a specific named venue / trail / park — not a neighborhood, region, category, or generic tip.
Vary areas and vibes. No duplicates.
Self-check before responding: count(items) must be 10 (or the user's exact N). If you only have 1 idea, invent more real venues — do not stop early.
clarification_needed → items must be [] (empty array only in that case). Digits in lat/long or street numbers are NOT a requested count.

## Personalization from existingPlaces
Treat saved places as taste (categories/notes) — silent influence. Dedup against them strictly.

## Categories (exact)
restaurant, cafe, bar, hotel, attraction, museum, park, beach, hike, shopping, nightlife, viewpoint, kids, other.
Match what was asked ("hotels" / "stays" → every category=hotel; "restaurants" → restaurant; "activities" → attraction/museum/park/viewpoint/etc. mix).

## Good suggestions
Renowned real venues with maps-searchable location (venue + city). Notes explain why worth saving. No proximity clustering for a schedule.

${SHARED_OUTPUT_CONTRACT}
`;
}

/** The one kind of pick the user asked for, phrased for the model. */
function describeDeliverable(deliverable) {
  switch (deliverable) {
    case DELIVERABLES.DESTINATIONS:
      return "distinct DESTINATIONS worth traveling to — towns, cities, state/national parks, coastal or mountain areas. NOT individual venues inside one city";
    case DELIVERABLES.STAYS:
      return "places to STAY — real, bookable hotels, resorts, inns, or lodges";
    case DELIVERABLES.RESTAURANTS:
      return "places to EAT or DRINK — named restaurants, cafes, or bars";
    case DELIVERABLES.ACTIVITIES:
      return "ACTIVITIES and ATTRACTIONS — things to do, see, hike, or experience";
    default:
      return "notable PLACES worth saving";
  }
}

/**
 * Where to anchor the answer geographically.
 *
 * The origin block is the fix for "cool spots within 5 hours of me" answers
 * that drifted to famous regions thousands of miles from the actual user.
 */
function buildGeoAnchorInstructions(plan) {
  const origin = plan?.origin;
  const radius = plan?.radius;

  if (plan?.geoScope === "origin_radius" && origin) {
    const label = origin.label || "the user's current location";
    const coords = `${origin.latitude.toFixed(4)}, ${origin.longitude.toFixed(4)}`;
    const budget = radius
      ? radius.driveHours
        ? `HARD LIMIT: every pick must be reachable in about ${radius.driveHours} hour(s) of driving from the origin — roughly ${radius.miles} road miles. Nothing farther.`
        : `HARD LIMIT: every pick must be within about ${radius.miles} miles of the origin. Nothing farther.`
      : "Keep every pick within a comfortable day-trip or weekend range of the origin.";

    return `## Origin anchor (HARDEST CONSTRAINT — read twice)
ORIGIN = ${label}, at coordinates ${coords}. This is where the user physically is right now.
${budget}

Before naming any place, reason about it:
1. Where is this place, and what are its approximate coordinates?
2. How far is it from ${coords} — and is that inside the limit above?
3. If it is outside the limit, DISCARD it and pick something closer.

CRITICAL FAILURE MODE TO AVOID: do NOT fall back on famous road-trip regions
(Lake Tahoe, Big Sur, Napa, the Grand Canyon, the Catskills, Joshua Tree, …)
out of habit. They only qualify if they genuinely sit inside the radius of
THIS origin. A well-known destination on the wrong side of the country is the
worst possible answer — a modest town actually within range is far better.

Spread picks across MULTIPLE directions from the origin (north / south / east /
west / inland / coastal), and vary the distance so some are close and some are
near the edge of the range.
Set travelMilesFromOrigin to your driving-mile estimate from the origin, and
travelTimeFromOrigin to a short string like "3h 15m".
Every item MUST include latitude and longitude for the place itself.`;
  }

  if (plan?.geoScope === "origin_radius") {
    return `## Origin anchor
The user is measuring distance from themselves, but no coordinates were provided.
Set clarificationNeeded=true and ask which city or area they're starting from. Do NOT guess a region.`;
  }

  const anchorLines = [
    "## Geographic anchor (priority order)",
    "1. A place named in the user's prompt — this ALWAYS wins.",
    "2. tripContext.destination.",
    "3. A strong regional signal from existingPlaces.",
  ];
  if (radius) {
    anchorLines.push(
      radius.driveHours
        ? `Travel budget: stay within about ${radius.driveHours} hour(s) driving (~${radius.miles} miles) of that anchor.`
        : `Travel budget: stay within about ${radius.miles} miles of that anchor.`
    );
  }
  anchorLines.push(
    "Every item.location MUST name the anchor city/area so Maps resolves it uniquely.",
    "Never reuse a same-named street or venue from a different city.",
    "Every item MUST include latitude and longitude for the place itself."
  );
  return anchorLines.join("\n");
}

/**
 * Recommendation lists — N picks of one kind, with no schedule bolted on.
 * Used whenever the ask is discovery ("find me…") rather than "plan my trip".
 */
function buildRecommendationPrompt(plan) {
  const count = plan?.requestedCount ?? 10;
  const target = describeDeliverable(plan?.deliverable);
  const categories =
    DELIVERABLE_CATEGORIES[plan?.deliverable] ?? PLACE_FINDER_CATEGORIES;

  const destinationRules =
    plan?.deliverable === DELIVERABLES.DESTINATIONS
      ? `
## Destination discovery specifics
Each item is a PLACE YOU TRAVEL TO, not a restaurant or a single building.
Good: "Mendocino, CA", "Shenandoah National Park, VA", "Galena, IL".
Bad: a cafe, a hotel, a museum, or ten venues all inside one city.
Every item must be a DIFFERENT destination — never two entries in the same town.
Use title = the destination name, subtitle = a 3–6 word hook ("coastal cliffs and wineries"),
notes = one short sentence on why it's worth the drive and what it's known for.
Set category to "other" for towns/regions, or park/beach/viewpoint/attraction when the destination IS that feature.
`
      : "";

  const seasonRules = `
## Dates and season
If the ask names a date, holiday, or season (e.g. "Labor Day weekend", "in February"),
use it ONLY to bias what's actually good then — open season, weather, crowds, festivals.
Mention the seasonal reason in notes when it matters.
NEVER convert a dated ask into a scheduled itinerary. Dates change WHICH places you
recommend, never the SHAPE of the answer.
`;

  return `${SHARED_BRAIN}

You are answering a DISCOVERY ask. The user wants a list of recommendations —
they did NOT ask you to plan or schedule a trip.

## What to return
Return ${count} ${target}.

ABSOLUTE RULES (violating these makes the answer useless):
- Every item uses kind="place".
- startTime and endTime MUST be null. dayIndex MUST be null. dayLabel MUST be "".
- NO checklists. NO reminders. NO flights. NO packing lists. NO hotels unless stays were asked for.
- Do NOT build a day-by-day plan, do NOT cluster items into a schedule, do NOT
  add filler items of other kinds to hit a count.
- Every item independently answers the user's question. A user should be able to
  pick any one of them and ignore the rest.

## Category discipline
Allowed categories: ${categories.join(", ")}.
Return ONLY the kind of thing that was asked for. If the user asked for places to
stay, every item is a stay. If they asked where to go, every item is a destination.
Do not mix in other kinds "for completeness".

${buildGeoAnchorInstructions(plan)}
${destinationRules}${seasonRules}
## Count (HARD)
Return exactly ${count} items unless clarificationNeeded=true (then items=[]).
Each must be real, specific, and named — never a category, a vague area, or a tip.
Vary vibe, price, and area. No duplicates, and dedup against existingPlaces.
If you can only think of a few, keep working until you have ${count} real ones.

## Quality
Well-regarded, real places a local would actually endorse. Notes explain why this
pick earns its spot, in one short sentence. No marketing filler.

${SHARED_OUTPUT_CONTRACT}
`;
}

function buildCreateTripPrompt() {
  return `${SHARED_BRAIN}

You draft a NEW trip for the Trips tab — not filling an existing day board, not Places cards.

## Intent (pick ONE — read the ask carefully)
- get_started: user wants a draft / kickoff / "help me start" / light suggestions — NOT a packed schedule; also use when the ask is vague between a light start and a full plan
- full_itinerary: user wants a full trip planned / "plan my trip" / "pack the itinerary" / day-by-day / complete stay
- clarification_needed: missing destination AND dates/duration with nothing inferable

CRITICAL: Always draft ONE concrete trip. Never offer multiple destination/trip choices.
CRITICAL: If the user states a day count ("3 days", "weekend", "week in X"), intent MUST be full_itinerary — not get_started.
CRITICAL: "Create a trip to X" with duration/dates often means full_itinerary. "Rough idea for X" / "start a trip" / vague "create a trip" → get_started.
CRITICAL: Never write a multi-day / "packed itinerary" summary while returning only a hotel or 1–3 filler items. The items array IS the itinerary.

## trip fields
- name: short title
- destination: geocodeable city/region
- isDatesSet true → startDate/endDate YYYY-MM-DD, unscheduledDaysCount 0
- isDatesSet false → dates null, unscheduledDaysCount = day count (default 3; use stated length when given)
- summary: 1–2 sentence pitch
- confidence 0–1

CRITICAL dates: The app sends today's date in the user JSON (referenceDate). When the user gives month/day without a year (e.g. "December 23 – January 1"), pick the NEXT upcoming occurrence relative to referenceDate — NEVER a past year. If end month is before start month (Dec→Jan), endDate's year is startDate's year + 1. Both dates must be on or after referenceDate when the trip is upcoming.

CRITICAL user-specified venues: If the user names a hotel / stay / restaurant / attraction, that venue MUST appear in items with the exact name (and maps-searchable location). For a named hotel: use it as the ONLY category=hotel item — do NOT invent a substitute accommodation.

## items — seed itinerary (plan_day kinds only; NEVER kind=place)
dayID always null. Set dayIndex (0-based) + dayLabel ("Day 1", …) for scheduled items.
Every venue activity MUST set category to one of: ${PLACE_FINDER_CATEGORIES.join(", ")}.
Reminders/checklists/flights use category "".

### get_started (light)
Aim for a balanced starter pack across sections (≈8–14 items):
- 1 accommodation (category=hotel)
- 2–3 restaurants/cafes/bars
- 3–5 activities/attractions
- 1 packing or prep checklist
- 1–2 reminders (bookings, docs, etc.)
Do NOT leave items nearly empty unless the user said they'll plan later → items=[].
HARD FLOOR for get_started: items.length ≥ 8 unless the user explicitly declined a starter itinerary. A single hotel is invalid.
When seeding restaurants/activities, still set startTime/endTime (HH:mm) so the trip opens as a usable schedule.

### full_itinerary (pack it)
Fill the stay for the trip length (use dates or unscheduledDaysCount; default 3–5 days — honor longer asks such as a week or 8–14 days):
- 1 primary hotel (or 1 per city if multi-city) — dayIndex 0, dayLabel "Day 1"
- ~1–2 meals/day as restaurant/cafe/bar activities on shorter trips (vary cuisine/neighborhood)
- ~2–3 activities/attractions per day on shorter trips; for long stays, one real highlight on most days is enough
- 1 flight item if flights are implied; else skip
- 1 solid packing checklist (8–12 lines in checklistItemsText) — dayIndex 0
- 2–4 reminders (visa/passport, reservations, transit passes, etc.) — dayIndex 0
Never stop at 1–3 filler highlights. Do not pack 4 meals × every day on long trips — the items array must still fit in one response.
HARD FLOOR: items.length must be ≥ 8 for any 2+ day trip (hotel + checklist + reminders + real venue highlights). A single hotel is NEVER a valid full_itinerary.
CRITICAL timing: every venue activity (meals + attractions) MUST set both startTime and endTime as HH:mm, sequenced morning→night on that day with no overlaps. Hotel / checklist / reminder items may leave times null.
Keep notes to one short sentence so the full items array fits in one response.

## Day spreading (HARD — full_itinerary and any multi-day ask)
- unscheduledDaysCount (or date span) is the trip length D. Honor D even when D is 6, 8, 10, or more — never shrink the trip to 5 days.
- Every day-scoped activity/meal MUST set dayIndex (0…D-1) AND dayLabel ("Day 1"…"Day D").
- Spread venue activities across the stay. For long trips, one highlight on most days beats stuffing Day 1.
- NEVER dump the whole itinerary on dayIndex 0 / "Day 1" when D ≥ 2.
- Hotel / packing checklist / prep reminders may stay on dayIndex 0; sightseeing and meals must not.
- Example: a 5-day trip should include Day 1…Day 5 labels; an 8-day trip should still be 8 days on the trip object.

## alternatives
Always return []. Never invent alternate destinations or competing trip drafts.

## Dedup / taste from existingTrips
Avoid cloning same destination+timing unless asked. Bias style silently.

${SHARED_OUTPUT_CONTRACT}

Also return trip, alternatives, and items as required by the create_trip schema.
`;
}

function safeString(v) {
  return typeof v === "string" ? v : "";
}

/** True only when the user clearly asked for N places/options (not coords/dates/addresses). */
function hasExplicitPlaceCount(text) {
  return explicitPlaceCountValue(text) != null;
}

/** Parsed N from "top 5" / "exactly 8" / "5 dinner options" style asks, else null. */
function explicitPlaceCountValue(text) {
  const raw = safeString(text);
  if (!raw) return null;
  let m = raw.match(/\bexactly\s+([1-9]|1[0-2])\b/i);
  if (m) return parseInt(m[1], 10);
  if (
    /\b(?:top|best)\s*([1-9]|1[0-2])\b/i.test(raw) &&
    /\b(places?|restaurants?|cafes?|hotels?|stays?|bars?|hikes?|trails?|spots?|venues?|options?|ideas?|recommendations?|activities|museums?|parks?)\b/i.test(
      raw
    )
  ) {
    m = raw.match(/\b(?:top|best)\s*([1-9]|1[0-2])\b/i);
    if (m) return parseInt(m[1], 10);
  }
  // "10 hotels", "5 dinner options", "3 great hiking trails"
  m = raw.match(
    /\b([1-9]|1[0-2])\s+(?:[A-Za-z]+\s+){0,2}(?:places?|restaurants?|cafes?|hotels?|stays?|bars?|hikes?|trails?|spots?|venues?|options?|ideas?|recommendations?|activities|museums?|parks?)\b/i
  );
  if (m) return parseInt(m[1], 10);
  m = raw.match(
    /\b(?:find|suggest|give|show|list|return|recommend)\s+(?:me\s+)?([1-9]|1[0-2])\b/i
  );
  if (m) return parseInt(m[1], 10);
  return null;
}

// ---------------------------------------------------------------------------
// Geography: where the user is measuring from, and how far they'll travel
// ---------------------------------------------------------------------------

/** Sustained highway average used to turn "5 hour drive" into a mile radius. */
const AVERAGE_DRIVE_MPH = 55;
const MILES_PER_KM = 0.621371;

function finiteNumber(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** A usable coordinate pair, or null. Rejects the 0,0 "unset" sentinel. */
function normalizeCoordinate(latitude, longitude) {
  const lat = finiteNumber(latitude);
  const lon = finiteNumber(longitude);
  if (lat == null || lon == null) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  if (Math.abs(lat) < 0.0001 && Math.abs(lon) < 0.0001) return null;
  return { latitude: lat, longitude: lon };
}

/**
 * The point the user is measuring distance from.
 * Explicit userLocation wins; an active trip's coordinates are the fallback.
 */
function resolveOrigin(body, tripContext) {
  const raw = body?.userLocation ?? body?.currentLocation ?? null;
  const fromBody = normalizeCoordinate(raw?.latitude, raw?.longitude);
  if (fromBody) {
    return {
      ...fromBody,
      label: safeString(raw?.label).trim(),
      source: "user_location",
    };
  }
  const fromTrip = normalizeCoordinate(tripContext?.latitude, tripContext?.longitude);
  if (fromTrip) {
    return {
      ...fromTrip,
      label: safeString(tripContext?.destination).trim(),
      source: "trip_context",
    };
  }
  return null;
}

/** Great-circle miles between two coordinate pairs. */
function haversineMiles(a, b) {
  if (!a || !b) return null;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const earthRadiusMiles = 3958.8;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusMiles * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * "within a 5 hour drive" / "under 200 miles" / "2hr drive" → travel budget.
 * Straight-line miles run ~20% short of road miles, so the check radius is padded.
 */
function parseTravelRadius(text) {
  const raw = safeString(text);
  if (!raw) return null;

  const hourPatterns = [
    /\bwithin\s+(?:about\s+|roughly\s+|around\s+|~\s*)?(?:a\s+|an\s+)?(\d{1,2})\s*-?\s*(?:hours?|hrs?|h)\b/i,
    /\b(\d{1,2})\s*-?\s*(?:hours?|hrs?)\s+(?:drive|driving|road\s*trip|ride|away|radius|from|of)\b/i,
    /\b(?:drive|driving|road\s*trip)\s+(?:of\s+)?(?:up\s+to\s+)?(\d{1,2})\s*-?\s*(?:hours?|hrs?)\b/i,
  ];
  for (const re of hourPatterns) {
    const m = raw.match(re);
    if (!m) continue;
    const hours = parseInt(m[1], 10);
    if (hours >= 1 && hours <= 24) {
      return {
        driveHours: hours,
        miles: Math.round(hours * AVERAGE_DRIVE_MPH),
        source: "drive_hours",
      };
    }
  }

  const miles = raw.match(
    /\b(?:within|under|less\s+than|up\s+to|inside)\s+(?:about\s+|roughly\s+|~\s*)?(\d{2,4})\s*(?:miles?|mi)\b/i
  );
  if (miles) {
    const n = parseInt(miles[1], 10);
    if (n >= 5 && n <= 3000) {
      return { driveHours: null, miles: n, source: "miles" };
    }
  }

  const km = raw.match(
    /\b(?:within|under|less\s+than|up\s+to|inside)\s+(?:about\s+|roughly\s+|~\s*)?(\d{2,4})\s*(?:km|kilometers?|kilometres?)\b/i
  );
  if (km) {
    const n = parseInt(km[1], 10);
    if (n >= 5 && n <= 5000) {
      return {
        driveHours: null,
        miles: Math.round(n * MILES_PER_KM),
        source: "km",
      };
    }
  }
  return null;
}

/** Straight-line tolerance for a road-distance budget (roads wander). */
function radiusCheckMiles(radius) {
  const miles = finiteNumber(radius?.miles);
  if (miles == null) return null;
  return Math.max(25, Math.round(miles * 0.85));
}

/**
 * True when the ask names something to measure distance from, as in "within 2
 * hours of Denver". Those must stay anchored on that place — substituting the
 * device location would search around the wrong city entirely.
 */
function hasNamedRadiusAnchor(text) {
  const raw = safeString(text);
  if (!raw) return false;
  return /\b(?:of|from|around|outside)\s+(?!me\b|here\b|my\b|home\b|us\b|our\b)[A-Za-z][\w.'-]*/i.test(
    raw
  );
}

/** True when the ask measures from the *user*, not from a named city. */
function mentionsOrigin(text) {
  const raw = safeString(text);
  if (!raw) return false;
  return [
    /\bnear\s+(?:me|my\b)/i,
    /\bfrom\s+(?:me|here)\b/i,
    /\b(?:of|to|from)\s+me\b/i,
    /\baround\s+(?:me|here)\b/i,
    /\bclose\s+(?:to|by)\s+(?:me|here|home)\b/i,
    /\bmy\s+(?:area|region|city|town|neighborhood|location|place|home)\b/i,
    /\bnearby\b/i,
    /\bwhere\s+i\s+(?:am|live)\b/i,
    /\bcurrent\s+location\b/i,
    /\bdriving\s+distance\b/i,
    /\bi'?m\s+(?:currently\s+)?(?:in|near|at)\b/i,
  ].some((re) => re.test(raw));
}

/**
 * Drop picks that fall outside the requested travel radius.
 *
 * The backstop for a model naming a famous-but-far place: given the origin and
 * the item's own coordinates, we can just measure it and reject the outliers
 * instead of trusting the prose. Items without coordinates are kept, since the
 * client still resolves those through MapKit.
 */
function enforceTravelRadius(items, plan) {
  const origin = plan?.origin;
  const limit = plan?.radiusCheckMiles;
  const list = Array.isArray(items) ? items : [];
  if (!origin || limit == null) return { items: list, dropped: [] };

  const kept = [];
  const dropped = [];
  for (const item of list) {
    const coordinate = normalizeCoordinate(item?.latitude, item?.longitude);
    if (!coordinate) {
      kept.push(item);
      continue;
    }
    const miles = haversineMiles(origin, coordinate);
    if (miles == null) {
      kept.push(item);
      continue;
    }
    if (miles > limit) {
      dropped.push({ title: safeString(item?.title), miles: Math.round(miles) });
      continue;
    }
    kept.push({ ...item, straightLineMilesFromOrigin: Math.round(miles) });
  }
  return { items: kept, dropped };
}

// ---------------------------------------------------------------------------
// Ask classification: what shape of answer does this prompt actually want?
// ---------------------------------------------------------------------------

/** What the user wants back — an itinerary, or one specific kind of pick. */
const DELIVERABLES = {
  FULL_ITINERARY: "full_itinerary",
  DESTINATIONS: "destinations",
  STAYS: "stays",
  RESTAURANTS: "restaurants",
  ACTIVITIES: "activities",
  MIXED_PLACES: "mixed_places",
};

/** Deliverables that are recommendation lists, never a scheduled trip. */
const RECOMMENDATION_DELIVERABLES = new Set([
  DELIVERABLES.DESTINATIONS,
  DELIVERABLES.STAYS,
  DELIVERABLES.RESTAURANTS,
  DELIVERABLES.ACTIVITIES,
  DELIVERABLES.MIXED_PLACES,
]);

/** Place categories to return for each recommendation deliverable. */
const DELIVERABLE_CATEGORIES = {
  [DELIVERABLES.DESTINATIONS]: ["other", "attraction", "park", "beach", "viewpoint"],
  [DELIVERABLES.STAYS]: ["hotel"],
  [DELIVERABLES.RESTAURANTS]: ["restaurant", "cafe", "bar"],
  [DELIVERABLES.ACTIVITIES]: [
    "attraction",
    "museum",
    "park",
    "beach",
    "hike",
    "viewpoint",
    "nightlife",
    "shopping",
    "kids",
  ],
};

/** Explicit "plan the whole trip" language — outranks topic keywords. */
function wantsFullItinerary(text) {
  const raw = safeString(text);
  if (!raw) return false;
  return [
    /\bitinerar(?:y|ies)\b/i,
    /\bday[-\s]by[-\s]day\b/i,
    /\bfull\s+(?:trip|plan|itinerary|schedule)\b/i,
    /\bplan\s+(?:out\s+)?(?:everything|the\s+whole|my\s+whole)\b/i,
    /\bpack\s+(?:the|my)\s+itinerary\b/i,
    /\bplan\s+(?:me\s+)?(?:a|an|my|our)\s+(?:\w+\s+){0,3}?(?:trip|vacation|holiday|getaway|honeymoon|weekend)\b/i,
    /\b(?:plan|schedule)\s+(?:a|an|my|our)?\s*\d{1,2}\s*-?\s*days?\b/i,
    /\bcreate\s+(?:a|an|my)\s+(?:\w+\s+){0,3}?trip\b/i,
    /\btrip\s+to\s+\w+/i,
  ].some((re) => re.test(raw));
}

/**
 * "find / show / suggest / where can I…" — the user is asking to be shown
 * options. Combined with a named kind this outranks any mention of a trip,
 * so "find hotels for my 5 day trip to LA" returns hotels, not an itinerary.
 */
function hasDiscoveryVerb(text) {
  const raw = safeString(text);
  if (!raw) return false;
  return [
    /\b(?:find|show|suggest|recommend)\b/i,
    // Not bare "list" — refill prompts say "packing list", which is not an ask.
    /\blist\s+(?:me\b|some\b|\d+|the\s+(?:best|top)\b)/i,
    /\bgive\s+me\b/i,
    /\bwhat\s+(?:are|is)\b/i,
    /\bwhere\s+(?:can|should|to|are)\b/i,
    /\bwhich\b/i,
    /\bany\s+(?:good|great|nice|cool)\b/i,
    /\blooking\s+for\b/i,
    /\b(?:ideas?|options?|recommendations?|suggestions?)\s+(?:for|near|around|in)\b/i,
    /\bbest\b/i,
    /\btop\s+\d+\b/i,
    /\bcool\b/i,
  ].some((re) => re.test(raw));
}

/** The single kind of thing the user asked for, or null when unstated. */
function detectDeliverable(text) {
  const raw = safeString(text);
  if (!raw) return null;

  const tests = [
    [
      DELIVERABLES.STAYS,
      /\b(?:hotels?|stays?|accommodations?|accomodations?|lodging|lodges?|airbnbs?|resorts?|motels?|hostels?|places?\s+to\s+stay|where\s+to\s+stay)\b/i,
    ],
    [
      DELIVERABLES.RESTAURANTS,
      /\b(?:restaurants?|food|eats?|dining|dinner|lunch|brunch|breakfast|cafes?|coffee\s+shops?|bars?|breweries|places?\s+to\s+eat|where\s+to\s+eat)\b/i,
    ],
    [
      DELIVERABLES.DESTINATIONS,
      /\b(?:destinations?|towns?|cities|villages?|locations?|getaways?|places?\s+to\s+(?:go|visit|travel)|where\s+(?:should|can|to)\s+(?:i|we)\s+(?:go|travel|visit)|where\s+to\s+go|road\s*trip\s+ideas?)\b/i,
    ],
    [
      DELIVERABLES.ACTIVITIES,
      /\b(?:activities|things?\s+to\s+do|attractions?|sights?|sightseeing|museums?|hikes?|hiking|trails?|beaches?|parks?|experiences?|excursions?)\b/i,
    ],
  ];

  for (const [deliverable, re] of tests) {
    if (re.test(raw)) return deliverable;
  }
  return null;
}

/**
 * Resolve what to answer and where to anchor it.
 *
 * Two independent questions, which used to be conflated into "it's a trip":
 * 1. geoScope — is a destination named, or is this a search around a point?
 * 2. deliverable — a full itinerary, or just one kind of recommendation?
 */
function resolveAskPlan({ mode, text, tripContext, origin }) {
  const raw = safeString(text);
  const radius = parseTravelRadius(raw);
  // Internal refill prompts state their intent outright ("Intent=full_itinerary").
  // That declaration is authoritative — a refill must never become a pick list.
  const declaredIntent = raw.match(/\bintent\s*=\s*([a-z_]+)/i)?.[1]?.toLowerCase() ?? null;
  const explicitItinerary =
    declaredIntent === "full_itinerary" || wantsFullItinerary(raw);
  const detected = detectDeliverable(raw);
  const originAsk = mentionsOrigin(raw);

  // A radius is measured from the user only when they refer to themselves, or
  // when the distance phrase has no anchor of its own to measure from.
  const anchoredOnOrigin =
    originAsk ||
    (radius != null && !explicitItinerary && !hasNamedRadiusAnchor(raw));

  let geoScope;
  if (anchoredOnOrigin) {
    geoScope = "origin_radius";
  } else if (safeString(tripContext?.destination).trim()) {
    geoScope = "trip_destination";
  } else {
    geoScope = "named_destination";
  }

  // Asking to be *shown* a named kind of thing beats a passing mention of a
  // trip, and a radius search is always discovery. Otherwise an explicit
  // "plan my trip" wins, and a duration alone never implies an itinerary.
  const topicWins =
    Boolean(detected) &&
    declaredIntent !== "full_itinerary" &&
    (hasDiscoveryVerb(raw) || geoScope === "origin_radius");

  let deliverable;
  if (explicitItinerary && !topicWins) {
    deliverable = DELIVERABLES.FULL_ITINERARY;
  } else if (detected) {
    deliverable = detected;
  } else if (mode === "place_finder") {
    deliverable = DELIVERABLES.MIXED_PLACES;
  } else if (mode === "create_trip") {
    deliverable = DELIVERABLES.FULL_ITINERARY;
  } else {
    deliverable = null;
  }

  // Searching around a point with no named destination is discovery, not a trip.
  if (
    geoScope === "origin_radius" &&
    deliverable === DELIVERABLES.FULL_ITINERARY &&
    !explicitItinerary
  ) {
    deliverable = DELIVERABLES.DESTINATIONS;
  }

  const isRecommendation = RECOMMENDATION_DELIVERABLES.has(deliverable);

  return {
    geoScope,
    deliverable,
    isRecommendation,
    radius,
    // Only measure against the origin when the radius is actually relative to
    // it; "within 30 miles of Chicago" must not be checked against the device.
    radiusCheckMiles: geoScope === "origin_radius" ? radiusCheckMiles(radius) : null,
    origin: origin ?? null,
    // "Near me" with no coordinates must ask, not guess a random region.
    needsOrigin: geoScope === "origin_radius" && !origin,
    requestedCount: explicitPlaceCountValue(raw),
  };
}

/**
 * Clients append count/itinerary boilerplate to `text` before sending it.
 * That prose would skew the classifier — an appended "1 hotel, a few
 * restaurants" reads as a stays ask — so classify on the user's own words.
 * Newer clients send `rawText`; this is the fallback for the rest.
 */
function stripClientBoilerplate(text) {
  const raw = safeString(text);
  if (!raw) return raw;
  const marker = raw.search(
    /\n\s*\n\s*Return\s+(?:a\s+full_itinerary\b|exactly\s+\d+|\d+\s*[–—-]\s*\d+\s+distinct|\d+\s+distinct)/i
  );
  return marker > 0 ? raw.slice(0, marker).trim() : raw;
}

/** What to ask when the user measured from themselves but sent no coordinates. */
function originClarificationPrompt(plan) {
  const radius = plan?.radius;
  const budget = radius?.driveHours
    ? ` I'll look for spots within about a ${radius.driveHours}-hour drive.`
    : radius?.miles
      ? ` I'll stay within about ${radius.miles} miles.`
      : "";
  if (plan?.deliverable === DELIVERABLES.DESTINATIONS) {
    return `Which city are you starting from?${budget}`;
  }
  return `What city or area should I search around?${budget}`;
}

/** Append count + shape discipline to a discovery ask (never itinerary prose). */
function enforceRecommendationAsk(text, plan, count) {
  const raw = safeString(text).trim();
  if (!raw) return raw;
  const target = describeDeliverable(plan?.deliverable);
  const lines = [
    raw,
    "",
    `Return exactly ${count} ${target}.`,
    "This is a recommendation list, NOT an itinerary: no schedule, no times, no packing list, no reminders.",
  ];
  if (plan?.geoScope === "origin_radius" && plan?.origin) {
    const label = plan.origin.label || "the origin coordinates";
    lines.push(
      plan.radius?.driveHours
        ? `Every pick must be within about a ${plan.radius.driveHours}-hour drive (~${plan.radius.miles} miles) of ${label}.`
        : plan.radius?.miles
          ? `Every pick must be within about ${plan.radius.miles} miles of ${label}.`
          : `Anchor every pick near ${label}.`
    );
  }
  lines.push("Include latitude and longitude on every item.");
  return lines.join("\n");
}

/** Schema-level reminder sent alongside a recommendation request. */
function recommendationOutputRequirements(plan, count) {
  const parts = [
    `Unless clarificationNeeded, items MUST contain exactly ${count} distinct kind=place entries.`,
    "startTime, endTime and dayIndex MUST be null; dayLabel MUST be \"\".",
    "No checklist, reminder, or flight items. No itinerary structure.",
  ];
  if (plan?.deliverable && plan.deliverable !== DELIVERABLES.MIXED_PLACES) {
    parts.push(`Every item must be ${describeDeliverable(plan.deliverable)}.`);
  }
  if (plan?.geoScope === "origin_radius" && plan?.origin && plan?.radius) {
    parts.push(
      `Every item must be within ${plan.radius.miles} miles of ${plan.origin.latitude.toFixed(4)},${plan.origin.longitude.toFixed(4)} — items outside that range are rejected.`
    );
  } else if (plan?.radius) {
    parts.push(`Every item must be within about ${plan.radius.miles} miles of the anchor named in the prompt.`);
  }
  parts.push("Every item MUST include latitude and longitude.");
  return parts.join(" ");
}

/** Routing decisions echoed to the client so it can pick the right UI. */
function describeRouting(plan, requestedMode, resolvedMode) {
  return {
    requestedMode,
    resolvedMode,
    geoScope: plan?.geoScope ?? null,
    deliverable: plan?.deliverable ?? null,
    isRecommendation: Boolean(plan?.isRecommendation),
    origin: plan?.origin
      ? {
          label: plan.origin.label || "",
          latitude: plan.origin.latitude,
          longitude: plan.origin.longitude,
          source: plan.origin.source,
        }
      : null,
    radiusMiles: plan?.radius?.miles ?? null,
    driveHours: plan?.radius?.driveHours ?? null,
  };
}

/** True when the ask is clearly a single checklist / reminder / flight (not a list). */
function isPlanDaySingleKindAsk(text) {
  const raw = safeString(text);
  if (!raw) return false;
  return (
    /\b(checklist|packing list|remind me|reminder|flight|train|add a flight)\b/i.test(raw) &&
    !/\b(day|sightseeing|food|restaurants?|options?|ideas?|activities|itinerary)\b/i.test(raw)
  );
}

/**
 * Structural item floor for plan_day — mirrors minCreateTripItemCount.
 * Explicit typed N wins; single-kind asks get 0 (no schema floor);
 * list-style defaults to 6 (same as the old under-delivery recount).
 */
function minPlanDayItemCount(text) {
  const explicit = explicitPlaceCountValue(text);
  if (explicit != null) return Math.max(1, Math.min(explicit, 12));
  if (isPlanDaySingleKindAsk(text)) return 0;
  return 6;
}

/** Structural item floor for place_finder (explicit N or default 10). */
function minPlaceFinderItemCount(text) {
  const explicit = explicitPlaceCountValue(text);
  if (explicit != null) return Math.max(1, Math.min(explicit, 12));
  return 10;
}

/** Append an explicit multi-item count for place_finder / plan_day when the user didn't ask for N. */
function enforceItemCount(text, mode, plan = null) {
  const raw = safeString(text).trim();
  if (!raw) return raw;
  if (hasExplicitPlaceCount(raw)) return raw;

  // A discovery ask on a day board is an options list, so don't demand a
  // scheduled morning-to-night day with start and end times on every item.
  if (mode === "plan_day" && plan?.isRecommendation) {
    if (/return\s+\d+\s+distinct/i.test(raw)) return raw;
    return (
      `${raw}\n\n` +
      `Return 8 distinct ${describeDeliverable(plan.deliverable)} as separate options. ` +
      "Intent MUST be options_list — this is a list of choices, not a scheduled day. " +
      "Leave startTime and endTime null unless a time is inherent to the ask, and add no " +
      "checklists or reminders. One real venue per item with short notes."
    );
  }

  if (mode === "place_finder") {
    if (/return exactly\s+\d+\s+specific named places/i.test(raw)) return raw;
    return `${raw}\n\nReturn exactly 10 specific named places (trails, venues, or parks — not one summary recommendation).`;
  }

  if (mode === "plan_day") {
    if (/return\s+\d+\s+distinct/i.test(raw)) return raw;
    // Single-kind asks should stay single (or small).
    if (isPlanDaySingleKindAsk(raw)) {
      return raw;
    }
    return (
      `${raw}\n\n` +
      "Return 6–8 distinct itinerary items in the items array " +
      "(one venue/stop per item, short notes). " +
      "Every activity MUST include startTime and endTime as HH:mm, sequenced morning to night with no overlaps. " +
      "Never return a single combined day summary."
    );
  }

  return raw;
}

function isPlanDaySingleKindIntent(intent) {
  return ["checklist", "reminder", "flight", "clarification_needed"].includes(
    String(intent || "")
  );
}

/** Drop the obsolete create_trip intent label (collapsed into get_started). */
function normalizeCreateTripIntent(intent) {
  const i = safeString(intent);
  if (i === "create_trip") return "get_started";
  if (CREATE_TRIP_INTENTS.includes(i)) return i;
  return i || "get_started";
}

function cryptoRandomId() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function coerceInt(v) {
  if (Number.isInteger(v)) return v;
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
  return null;
}

function parseDayIndexFromLabel(label) {
  const m = /day\s*(\d+)/i.exec(safeString(label));
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isInteger(n) && n >= 1 ? n - 1 : null;
}

/** Infer trip length from user text like "5 day trip" / "weekend". */
function inferTripDayCountFromText(text) {
  const raw = safeString(text);
  if (!raw) return null;
  const patterns = [
    /\b(\d{1,2})\s*-?\s*days?\b/i,
    /\b(\d{1,2})\s+day\s+trip\b/i,
    /\bplan\s+a\s+(\d{1,2})\s+day\b/i,
    /\bfor\s+(\d{1,2})\s+days?\b/i,
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= 30) return n;
    }
  }
  if (/\bweekend\b/i.test(raw)) return 3;
  if (/\bweek\b/i.test(raw) && !/\bweekend\b/i.test(raw)) return 7;
  return null;
}

/** Append hard day-count + spread + item-count requirements for create_trip. */
function enforceCreateTripDays(text, referenceDate = new Date(), extractedDates = null) {
  const raw = safeString(text).trim();
  if (!raw) return raw;
  const todayISO = toISODateOnly(referenceDate);
  const namedStay = extractNamedStay(raw);
  const stayLine = namedStay
    ? ` USER-SPECIFIED STAY (HARD): Use exactly "${namedStay}" as the only category=hotel item. Do NOT invent a different hotel.`
    : "";
  const datesLine = extractedDates?.startDate && extractedDates?.endDate
    ? ` HARD DATES (from user text): isDatesSet=true, startDate="${extractedDates.startDate}", endDate="${extractedDates.endDate}", unscheduledDaysCount=0. Do NOT return unscheduled days.`
    : ` Today's date is ${todayISO}. Any month/day without a year must resolve to the next upcoming occurrence (never a past year).`;
  const days =
    extractedDates?.startDate && extractedDates?.endDate
      ? resolveCreateTripDayCount(
          {
            isDatesSet: true,
            startDate: extractedDates.startDate,
            endDate: extractedDates.endDate,
          },
          inferTripDayCountFromText(raw)
        )
      : inferTripDayCountFromText(raw);
  if (!days || days < 2) {
    return (
      `${raw}\n\n` +
      datesLine +
      stayLine +
      "\nUnless the user said they'll plan later: return a rich starter itinerary in items " +
      "(at least 8 entries: 1 hotel, several restaurants, several activities, 1 checklist, 1–2 reminders). " +
      "Never return only a hotel. Keep notes under 12 words. " +
      "If this is a multi-day trip, set trip.unscheduledDaysCount to the day count and spread " +
      "activity items across every dayIndex (never put the whole itinerary on day 0)."
    );
  }
  const minItems = completableCreateTripItemCount(days);
  return (
    `${raw}\n\n` +
    datesLine +
    ` This is a ${days}-day trip. Intent = full_itinerary. ` +
    (extractedDates
      ? ""
      : `Set trip.isDatesSet=true with YYYY-MM-DD dates when the user gave calendar dates; otherwise unscheduledDaysCount=${days}. `) +
    stayLine +
    ` Return AT LEAST ${minItems} items: 1 hotel, one real highlight on most dayIndexes from 0 to ${days - 1} (not 4 meals per day), ` +
    `1 packing checklist, and 1–2 reminders. ` +
    `Each day-scoped activity must include dayIndex and dayLabel ("Day 1"…"Day ${days}"), startTime, and endTime (HH:mm). ` +
    `Do not place all sightseeing/meals on dayIndex 0. ` +
    `Never return only accommodations — a single hotel is invalid. Keep notes under 12 words.`
  );
}

/** Pull an explicit stay name from prompts like "staying at The Plaza". */
function extractNamedStay(text) {
  const raw = safeString(text);
  if (!raw) return null;
  const patterns = [
    /\b(?:staying|stay(?:ing)?|booked|book(?:ed)?|checking\s+in)\s+(?:at|in)\s+((?:the\s+)?[A-Za-z0-9][^.\n,]{2,80})/i,
    /\b(?:hotel|resort|inn|lodge|suites?)\s*[:\-–]\s+((?:the\s+)?[A-Za-z0-9][^.\n,]{2,80})/i,
    /\bat\s+(the\s+)?([A-Za-z][^.\n,]{2,60}\b(?:Hotel|Resort|Inn|Lodge|Suites?|House|Palace|Ritz|Hyatt|Marriott|Hilton|Fairmont|Four Seasons))\b/i,
    /\b(?:i'?m\s+)?(?:at|in)\s+(the\s+)?([A-Za-z][^.\n,]{2,60}\b(?:Hotel|Resort|Inn|Lodge|Suites?))\b/i,
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (!m) continue;
    const name = safeString(m[2] || m[1])
      .replace(/\s+/g, " ")
      .replace(/[’”'".,;:]+$/g, "")
      .trim();
    if (name.length >= 3) return name;
  }
  return null;
}

function toISODateOnly(d) {
  const date = d instanceof Date ? d : new Date();
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseISODateOnly(raw) {
  const s = safeString(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00.000Z`);
  return Number.isFinite(t) ? t : null;
}

function addUTCFullYears(ms, years) {
  const d = new Date(ms);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.getTime();
}

const MONTH_NAME_TO_INDEX = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  sept: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};

function utcMs(year, monthIndex, day) {
  return Date.UTC(year, monthIndex, day);
}

function rollRangeToUpcoming(startMs, endMs, referenceDate) {
  let start = startMs;
  let end = endMs;
  while (end < start) {
    end = addUTCFullYears(end, 1);
  }
  const today = Date.UTC(
    referenceDate.getUTCFullYear(),
    referenceDate.getUTCMonth(),
    referenceDate.getUTCDate()
  );
  let guard = 0;
  while (end < today && guard < 10) {
    start = addUTCFullYears(start, 1);
    end = addUTCFullYears(end, 1);
    guard += 1;
  }
  return { start, end };
}

/**
 * Deterministic date-range extraction from the user prompt.
 * Covers ISO ranges and month/day phrases like "December 23 – January 1".
 */
function extractTripDateRangeFromText(text, referenceDate = new Date()) {
  const raw = safeString(text);
  if (!raw) return null;

  // Explicit ISO: 2026-12-23 to 2027-01-01 / 2026-12-23 – 2027-01-01
  const iso = raw.match(
    /\b(\d{4}-\d{2}-\d{2})\s*(?:to|through|thru|until|-|–|—)\s*(\d{4}-\d{2}-\d{2})\b/i
  );
  if (iso) {
    let start = parseISODateOnly(iso[1]);
    let end = parseISODateOnly(iso[2]);
    if (start != null && end != null) {
      const rolled = rollRangeToUpcoming(start, end, referenceDate);
      return {
        startDate: toISODateOnly(new Date(rolled.start)),
        endDate: toISODateOnly(new Date(rolled.end)),
        source: "iso",
      };
    }
  }

  const month = Object.keys(MONTH_NAME_TO_INDEX).join("|");
  // December 23, 2026 – January 1, 2027  OR  Dec 23 - Jan 1
  const re = new RegExp(
    `\\b(${month})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?` +
      `\\s*(?:to|through|thru|until|-|–|—)\\s*` +
      `(${month})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?\\b`,
    "i"
  );
  const m = raw.match(re);
  if (!m) return null;

  const startMonth = MONTH_NAME_TO_INDEX[m[1].toLowerCase()];
  const startDay = parseInt(m[2], 10);
  const endMonth = MONTH_NAME_TO_INDEX[m[4].toLowerCase()];
  const endDay = parseInt(m[5], 10);
  if (
    startMonth == null ||
    endMonth == null ||
    !Number.isFinite(startDay) ||
    !Number.isFinite(endDay)
  ) {
    return null;
  }

  const refYear = referenceDate.getUTCFullYear();
  let startYear = m[3] ? parseInt(m[3], 10) : refYear;
  let endYear = m[6] ? parseInt(m[6], 10) : startYear;
  // Cross-year Dec→Jan without explicit end year.
  if (!m[6] && endMonth < startMonth) {
    endYear = startYear + 1;
  }
  // If neither year given, pick upcoming occurrence vs referenceDate.
  if (!m[3] && !m[6]) {
    let start = utcMs(refYear, startMonth, startDay);
    let end = utcMs(endMonth < startMonth ? refYear + 1 : refYear, endMonth, endDay);
    const rolled = rollRangeToUpcoming(start, end, referenceDate);
    return {
      startDate: toISODateOnly(new Date(rolled.start)),
      endDate: toISODateOnly(new Date(rolled.end)),
      source: "month_day",
    };
  }

  let start = utcMs(startYear, startMonth, startDay);
  let end = utcMs(endYear, endMonth, endDay);
  const rolled = rollRangeToUpcoming(start, end, referenceDate);
  return {
    startDate: toISODateOnly(new Date(rolled.start)),
    endDate: toISODateOnly(new Date(rolled.end)),
    source: "month_day",
  };
}

function applyExtractedDatesToTrip(trip, extracted) {
  if (!trip || !extracted?.startDate || !extracted?.endDate) return trip;
  trip.isDatesSet = true;
  trip.startDate = extracted.startDate;
  trip.endDate = extracted.endDate;
  trip.unscheduledDaysCount = 0;
  return trip;
}

/**
 * Roll AI trip dates forward so upcoming stays are not stuck in a past year
 * (common when the model emits Dec 2025 for "Dec 23 – Jan 1" asked in 2026).
 */
function normalizeCreateTripDates(trip, referenceDate = new Date()) {
  if (!trip || typeof trip !== "object" || trip.isDatesSet !== true) return trip;
  let start = parseISODateOnly(trip.startDate);
  let end = parseISODateOnly(trip.endDate);
  if (start == null || end == null) return trip;

  // Cross-year range returned with end before start.
  while (end < start) {
    end = addUTCFullYears(end, 1);
  }

  const today = Date.UTC(
    referenceDate.getUTCFullYear(),
    referenceDate.getUTCMonth(),
    referenceDate.getUTCDate()
  );
  // Keep shifting the whole range forward until the trip hasn't already ended.
  let guard = 0;
  while (end < today && guard < 10) {
    start = addUTCFullYears(start, 1);
    end = addUTCFullYears(end, 1);
    guard += 1;
  }

  trip.startDate = toISODateOnly(new Date(start));
  trip.endDate = toISODateOnly(new Date(end));
  trip.unscheduledDaysCount = 0;
  return trip;
}

/** Force the user's named hotel into seed items (replace invented stays). */
function applyNamedStayToItems(items, stayName, trip) {
  const name = safeString(stayName).trim();
  if (!name || !Array.isArray(items)) return items;

  const dest = safeString(trip?.destination).trim();
  const location = dest ? `${name}, ${dest}` : name;
  const isHotel = (item) =>
    item &&
    item.kind === "activity" &&
    safeString(item.category).toLowerCase() === "hotel";

  const hotels = items.filter(isHotel);
  if (hotels.length > 0) {
    return items.map((item) => {
      if (!isHotel(item)) return item;
      return {
        ...item,
        title: name,
        location: location,
        category: "hotel",
        notes: item.notes || "Your stay",
      };
    });
  }

  return [
    {
      id: cryptoRandomId(),
      kind: "activity",
      include: true,
      dayID: null,
      dayIndex: 0,
      dayLabel: "Day 1",
      title: name,
      subtitle: "",
      location,
      notes: "Your stay",
      startTime: null,
      endTime: null,
      checklistItemsText: "",
      flightFromCode: "",
      flightToCode: "",
      flightNumber: "",
      confidence: 0.95,
      sourceSnippet: name,
      category: "hotel",
    },
    ...items,
  ];
}

/** Day length for create_trip floors. */
function createTripDayCount(trip, text) {
  const inferred = inferTripDayCountFromText(text);
  return resolveCreateTripDayCount(trip || {}, inferred);
}

/**
 * Structural / retry floor that can finish in one Gemini response.
 * Do not scale this with day count: Gemini returns HTTP 400 (client error toast)
 * when create_trip schema minItems grows with 6+ day prompts.
 */
function completableCreateTripItemCount(days) {
  void days;
  return 8;
}

/** Minimum seed items for a usable create_trip draft. */
function minCreateTripItemCount(trip, text) {
  return completableCreateTripItemCount(createTripDayCount(trip, text));
}

/** Explicit day-by-day slots so under-delivery retries can't collapse to a hotel. */
function buildCreateTripSlotList(days, destination) {
  const dest = safeString(destination).trim() || "the destination city";
  const n = Math.max(1, Math.min(Number(days) || 3, 30));
  const kinds = ["cafe", "attraction", "restaurant", "hike", "beach"];
  const lines = [];
  let i = 1;
  lines.push(
    `${i++}. kind=activity category=hotel dayIndex=0 dayLabel="Day 1" — real hotel in ${dest}`
  );
  for (let d = 0; d < n; d++) {
    const label = `Day ${d + 1}`;
    const category = kinds[d % kinds.length];
    lines.push(
      `${i++}. kind=activity category=${category} dayIndex=${d} dayLabel="${label}" — one real ${category} with startTime/endTime HH:mm`
    );
  }
  lines.push(
    `${i++}. kind=checklist dayIndex=0 dayLabel="Day 1" — packing list with 6 short lines in checklistItemsText`
  );
  lines.push(
    `${i++}. kind=reminder dayIndex=0 dayLabel="Day 1" — one prep reminder`
  );
  return lines.join("\n");
}

function createTripVenueCount(items) {
  if (!Array.isArray(items)) return 0;
  return items.filter(
    (item) =>
      item &&
      item.kind === "activity" &&
      safeString(item.category).toLowerCase() !== "hotel"
  ).length;
}

function isCreateTripUnderDelivered(trip, items, text, truncated) {
  const draftTrip = trip && typeof trip === "object" ? trip : {};
  const minItems = minCreateTripItemCount(draftTrip, text);
  const itemCount = Array.isArray(items) ? items.length : 0;
  const venueCount = createTripVenueCount(items);
  const days = resolveCreateTripDayCount(
    draftTrip,
    inferTripDayCountFromText(text)
  );
  return (
    truncated ||
    itemCount < minItems ||
    venueCount < Math.max(4, Math.min(days, 8))
  );
}

/** Trip length for seed redistribution. */
function resolveCreateTripDayCount(trip, inferredDays) {
  if (trip?.isDatesSet && trip.startDate && trip.endDate) {
    const start = Date.parse(trip.startDate);
    const end = Date.parse(trip.endDate);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      const days = Math.round((end - start) / 86400000) + 1;
      return Math.max(1, Math.min(days, 30));
    }
  }
  const fromTrip = Number.isInteger(trip?.unscheduledDaysCount)
    ? trip.unscheduledDaysCount
    : 0;
  return Math.max(1, Math.min(fromTrip || inferredDays || 3, 30));
}

/**
 * If Gemini collapsed a multi-day itinerary onto day 0, redistribute day-scoped
 * activities across 0…dayCount-1 while keeping hotel/checklist/reminders on day 0.
 */
function redistributeCreateTripItems(items, dayCount) {
  const n = Math.max(1, Math.min(Number(dayCount) || 1, 30));
  if (!Array.isArray(items) || items.length === 0 || n < 2) return items;

  for (const item of items) {
    if (item.dayIndex == null) {
      const fromLabel = parseDayIndexFromLabel(item.dayLabel);
      if (fromLabel != null) item.dayIndex = fromLabel;
    } else {
      item.dayIndex = Math.max(0, Math.min(item.dayIndex, n - 1));
    }
    if (item.dayIndex != null && !safeString(item.dayLabel)) {
      item.dayLabel = `Day ${item.dayIndex + 1}`;
    }
  }

  const isHotel = (item) =>
    item.kind === "activity" && safeString(item.category).toLowerCase() === "hotel";
  const isDayScoped = (item) =>
    item.kind === "activity" && !isHotel(item);

  const dayScoped = items.filter(isDayScoped);
  if (dayScoped.length === 0) return items;

  const covered = new Set(
    dayScoped
      .map((item) => item.dayIndex)
      .filter((d) => Number.isInteger(d) && d >= 0 && d < n)
  );
  const allOnFirst = dayScoped.every((item) => (item.dayIndex ?? 0) === 0);
  const needsRedistribute = allOnFirst || covered.size < Math.min(n, Math.max(2, Math.ceil(n * 0.6)));

  if (!needsRedistribute) return items;

  let slot = 0;
  for (const item of items) {
    if (item.kind === "checklist" || item.kind === "reminder" || isHotel(item)) {
      item.dayIndex = 0;
      item.dayLabel = "Day 1";
      continue;
    }
    if (!isDayScoped(item)) {
      if (item.dayIndex == null) {
        item.dayIndex = 0;
        item.dayLabel = "Day 1";
      }
      continue;
    }
    item.dayIndex = slot % n;
    item.dayLabel = `Day ${item.dayIndex + 1}`;
    slot += 1;
  }
  return items;
}

function sanitizeItem(item, mode) {
  if (!item || typeof item !== "object") return null;

  // Discovery modes return picks, never schedule rows.
  const isPlaceMode = mode === "place_finder" || mode === "recommendations";

  // place_finder: model often emits kind=activity for restaurants — coerce, don't drop.
  let kind = safeString(item.kind).toLowerCase();
  if (isPlaceMode) {
    kind = "place";
  }

  const allowedKinds = isPlaceMode ? ["place"] : PLAN_DAY_KINDS;
  if (!allowedKinds.includes(kind)) return null;

  let dayIndex = coerceInt(item.dayIndex);
  if (dayIndex == null) {
    dayIndex = parseDayIndexFromLabel(item.dayLabel);
  }

  const clean = {
    id: typeof item.id === "string" && item.id.length > 0 ? item.id : cryptoRandomId(),
    kind,
    include: item.include !== false,
    dayID: null,
    dayIndex,
    dayLabel: safeString(item.dayLabel),
    title: safeString(item.title),
    subtitle: safeString(item.subtitle),
    location: safeString(item.location),
    notes: safeString(item.notes),
    startTime: item.startTime ?? null,
    endTime: item.endTime ?? null,
    checklistItemsText: safeString(item.checklistItemsText),
    flightFromCode: safeString(item.flightFromCode),
    flightToCode: safeString(item.flightToCode),
    flightNumber: safeString(item.flightNumber),
    confidence: typeof item.confidence === "number" ? item.confidence : 0.5,
    sourceSnippet: safeString(item.sourceSnippet),
    category: PLACE_FINDER_CATEGORIES.includes(item.category)
      ? item.category
      : "",
  };

  const coordinate = normalizeCoordinate(item.latitude, item.longitude);
  clean.latitude = coordinate?.latitude ?? null;
  clean.longitude = coordinate?.longitude ?? null;

  if (isPlaceMode) {
    clean.category = PLACE_FINDER_CATEGORIES.includes(item.category)
      ? item.category
      : "other";
    // Keep title-only rows so the client can MapKit-refine location; drop empties only.
    if (!clean.title.trim()) return null;
    clean.startTime = null;
    clean.endTime = null;
    clean.dayIndex = null;
    clean.dayLabel = "";
  }

  if (mode === "recommendations") {
    const miles = finiteNumber(item.travelMilesFromOrigin);
    clean.travelMilesFromOrigin = miles != null && miles >= 0 ? Math.round(miles) : null;
    clean.travelTimeFromOrigin = safeString(item.travelTimeFromOrigin);
  }

  // Venue-like activities should keep a category for UI sectioning.
  if (
    (mode === "create_trip" || mode === "plan_day") &&
    clean.kind === "activity" &&
    !clean.category
  ) {
    clean.category = "attraction";
  }

  return clean;
}

function sanitizeTripDraft(trip) {
  if (!trip || typeof trip !== "object") {
    return {
      name: "",
      destination: "",
      isDatesSet: false,
      startDate: null,
      endDate: null,
      unscheduledDaysCount: 3,
      summary: "",
      confidence: 0.5,
    };
  }
  const isDatesSet = trip.isDatesSet === true;
  let unscheduledDaysCount = Number.isInteger(trip.unscheduledDaysCount)
    ? Math.max(1, Math.min(trip.unscheduledDaysCount, 30))
    : 3;
  if (isDatesSet) unscheduledDaysCount = 0;

  return {
    name: safeString(trip.name),
    destination: safeString(trip.destination),
    isDatesSet,
    startDate: isDatesSet ? trip.startDate ?? null : null,
    endDate: isDatesSet ? trip.endDate ?? null : null,
    unscheduledDaysCount,
    summary: safeString(trip.summary),
    confidence: typeof trip.confidence === "number" ? trip.confidence : 0.5,
  };
}

function extractJSON(text) {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;

  const tryParse = (raw) => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  let parsed = tryParse(trimmed);
  if (parsed) return parsed;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    parsed = tryParse(fenced[1].trim());
    if (parsed) return parsed;
  }

  // Brace-balanced slice from the first `{` (more reliable than lastIndexOf
  // when the model truncates mid-object and an earlier `}` exists).
  const start = trimmed.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        parsed = tryParse(trimmed.slice(start, i + 1));
        if (parsed) return parsed;
        break;
      }
    }
  }

  // Soft repairs for common model slip-ups / truncated payloads.
  const candidate = trimmed.slice(start);
  const repaired = candidate
    .replace(/,\s*([}\]])/g, "$1") // trailing commas
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");
  parsed = tryParse(repaired);
  if (parsed) return parsed;

  return tryParse(closeTruncatedJSON(repaired));
}

/** Best-effort close for MAX_TOKENS mid-object / mid-array truncation. */
function closeTruncatedJSON(text) {
  let s = String(text ?? "");
  if (!s) return s;

  let inString = false;
  let escape = false;
  const stack = [];

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      if (stack.length && stack[stack.length - 1] === ch) stack.pop();
    }
  }

  if (inString) s += '"';
  s = s.replace(/,\s*$/, "");
  // Drop a dangling key or colon at the end: `"title":` / `"title"`
  s = s.replace(/,?\s*"[^"]*"\s*:\s*$/, "");
  s = s.replace(/,?\s*"[^"]*"\s*$/, "");
  s = s.replace(/,\s*$/, "");

  while (stack.length) s += stack.pop();
  return s;
}

// Exported for tests only; Vercel invokes the default export.
export const __testables = {
  DELIVERABLES,
  resolveAskPlan,
  resolveOrigin,
  parseTravelRadius,
  mentionsOrigin,
  detectDeliverable,
  wantsFullItinerary,
  haversineMiles,
  enforceTravelRadius,
  originClarificationPrompt,
  stripClientBoilerplate,
  hasDiscoveryVerb,
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Missing GEMINI_API_KEY" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body ?? {};

    const mode =
      body?.mode === "place_finder"
        ? "place_finder"
        : body?.mode === "create_trip"
          ? "create_trip"
          : "plan_day";

    const rawUserText = safeString(body?.text ?? "").trim();
    // The user's own prompt, free of any client-appended output boilerplate.
    const askText =
      safeString(body?.rawText ?? "").trim() || stripClientBoilerplate(rawUserText);
    const referenceDate = new Date();
    const requestedPlaceCount = explicitPlaceCountValue(rawUserText);
    const facts = body?.facts ?? {};
    const tripContext = body?.tripContext ?? {};
    const preferences = body?.preferences ?? null;
    const existingItems = Array.isArray(body?.existingItems) ? body.existingItems : [];
    const existingPlaces = Array.isArray(body?.existingPlaces) ? body.existingPlaces : [];
    const existingTrips = Array.isArray(body?.existingTrips) ? body.existingTrips : [];
    const scopeHint = body?.scopeHint ?? "";

    // Read the ask before choosing a prompt: where to anchor the answer, and
    // whether they want a planned trip or just a list of picks. The requested
    // mode reflects which sheet was opened, which is not always the real ask.
    const origin = resolveOrigin(body, tripContext);
    const askPlan = resolveAskPlan({
      mode,
      text: askText,
      tripContext,
      origin,
    });
    const isRecommendation = askPlan.isRecommendation;
    // Only create_trip needs rerouting: it is the mode that turns a discovery ask
    // into a packed schedule. place_finder already returns picks, and plan_day has
    // its own options_list intent that correctly stays kind=activity for a day
    // board. Both of those just gain the geo anchoring below.
    const usesRecommendationPrompt = isRecommendation && mode === "create_trip";
    const resolvedMode = usesRecommendationPrompt ? "recommendations" : mode;

    // "Within 5 hours of me" with no coordinates: ask where they are rather
    // than inventing a region (which is how answers landed hundreds of miles off).
    if (askPlan.needsOrigin) {
      console.log(
        JSON.stringify({
          event: "origin_missing",
          mode,
          deliverable: askPlan.deliverable,
          rawPreview: rawUserText.slice(0, 180),
        })
      );
      return res.status(200).json({
        intent: "clarification_needed",
        clarificationNeeded: true,
        clarificationPrompt: originClarificationPrompt(askPlan),
        items: [],
        ...(mode === "create_trip" ? { trip: null, alternatives: [] } : {}),
        routing: describeRouting(askPlan, mode, resolvedMode),
      });
    }

    const extractedDates =
      mode === "create_trip" && !usesRecommendationPrompt
        ? extractTripDateRangeFromText(rawUserText, referenceDate)
        : null;

    // Recommendation asks must never get itinerary-shaped prose appended —
    // that is what turned "find cool spots" into a packed day-by-day plan.
    const recommendationCount = usesRecommendationPrompt
      ? Math.max(4, Math.min(askPlan.requestedCount ?? 10, 12))
      : 0;
    const text = usesRecommendationPrompt
      ? enforceRecommendationAsk(askText, askPlan, recommendationCount)
      : mode === "create_trip"
        ? enforceCreateTripDays(rawUserText, referenceDate, extractedDates)
        : enforceItemCount(rawUserText, mode, askPlan);

    // Structural item floors (schema minItems), not just prose.
    const createTripMinItems =
      mode === "create_trip" && !usesRecommendationPrompt
        ? minCreateTripItemCount(
            extractedDates
              ? {
                  isDatesSet: true,
                  startDate: extractedDates.startDate,
                  endDate: extractedDates.endDate,
                }
              : {},
            text
          )
        : 0;
    const planDayMinItems =
      mode === "plan_day" ? minPlanDayItemCount(rawUserText) : 0;
    const placeFinderMinItems =
      mode === "place_finder" ? minPlaceFinderItemCount(rawUserText) : 0;

    const recommendationPlan = { ...askPlan, requestedCount: recommendationCount };

    const systemInstruction = usesRecommendationPrompt
      ? buildRecommendationPrompt(recommendationPlan)
      : mode === "place_finder"
        ? buildPlaceFinderPrompt(askPlan)
        : mode === "create_trip"
          ? buildCreateTripPrompt()
          : buildPlanDayPrompt(askPlan);

    const responseSchema = usesRecommendationPrompt
      ? buildRecommendationSchema(recommendationPlan, recommendationCount, {
          includeTripShell: mode === "create_trip",
        })
      : mode === "place_finder"
        ? buildPlaceFinderSchema(placeFinderMinItems)
        : mode === "create_trip"
          ? buildCreateTripSchema(createTripMinItems)
          : buildPlanDaySchema(planDayMinItems);

    const outputRequirements = usesRecommendationPrompt
      ? recommendationOutputRequirements(recommendationPlan, recommendationCount)
      : mode === "place_finder"
        ? `Unless clarificationNeeded, items MUST contain exactly ${placeFinderMinItems} distinct kind=place venues` +
          (requestedPlaceCount != null
            ? ` (user asked for ${requestedPlaceCount}; schema-enforced). `
            : " (default 10; schema-enforced). ") +
          "Never return a single recommendation for list-style asks like best hikes, restaurants, or stays. Coordinates/addresses with digits are not a count."
        : mode === "plan_day"
          ? planDayMinItems > 0
            ? `Unless clarificationNeeded: items MUST contain at least ${planDayMinItems} distinct itinerary entries` +
              (requestedPlaceCount != null
                ? ` (user asked for ${requestedPlaceCount}; schema-enforced). `
                : " (schema-enforced default for day_plan / options_list). ") +
              "Keep notes to one short sentence. Never collapse a day into one summary item."
            : "Unless clarificationNeeded: return the items appropriate for this single checklist/reminder/flight ask. Keep notes short."
          : mode === "create_trip"
            ? "Unless clarificationNeeded: items MUST be a real itinerary (never just a hotel). " +
              `The items array MUST contain at least ${createTripMinItems} entries (schema-enforced). ` +
              "One highlight per day is enough for long trips — do not write 4–5 venues per day. " +
              (extractedDates
                ? `HARD: trip.isDatesSet=true, startDate=${extractedDates.startDate}, endDate=${extractedDates.endDate}, unscheduledDaysCount=0. `
                : "Set unscheduledDaysCount (or dates) to the stated length. ") +
              "Spread activities across EVERY dayIndex — never dump everything on day 0. " +
              "Each day-scoped activity needs dayIndex, dayLabel, startTime, and endTime. Keep notes under 12 words so the full array fits."
            : undefined;

    const userMessage = {
      mode: resolvedMode,
      text,
      referenceDate: toISODateOnly(referenceDate),
      ...(extractedDates
        ? {
            extractedTripDates: {
              startDate: extractedDates.startDate,
              endDate: extractedDates.endDate,
            },
          }
        : {}),
      // The resolved read of the ask, so the model sees the same conclusion
      // the server used to pick this prompt and schema.
      ask: {
        geoScope: askPlan.geoScope,
        deliverable: askPlan.deliverable,
      },
      ...(askPlan.origin
        ? {
            origin: {
              label: askPlan.origin.label,
              latitude: askPlan.origin.latitude,
              longitude: askPlan.origin.longitude,
            },
          }
        : {}),
      ...(askPlan.radius
        ? {
            travelBudget: {
              driveHours: askPlan.radius.driveHours,
              maxMiles: askPlan.radius.miles,
            },
          }
        : {}),
      scopeHint,
      facts,
      tripContext,
      preferences,
      existingItems,
      existingPlaces,
      existingTrips,
      ...(outputRequirements ? { outputRequirements } : {}),
    };

    console.log(
      JSON.stringify({
        event: "ask_routing",
        requestedMode: mode,
        resolvedMode,
        geoScope: askPlan.geoScope,
        deliverable: askPlan.deliverable,
        originSource: askPlan.origin?.source ?? null,
        originLabel: askPlan.origin?.label ?? null,
        radiusMiles: askPlan.radius?.miles ?? null,
        driveHours: askPlan.radius?.driveHours ?? null,
        rawPreview: rawUserText.slice(0, 180),
      })
    );

    if (mode === "create_trip") {
      console.log(
        JSON.stringify({
          event: "create_trip_request",
          createTripMinItems,
          extractedDates,
          rawPreview: rawUserText.slice(0, 180),
        })
      );
    } else if (mode === "plan_day") {
      console.log(
        JSON.stringify({
          event: "plan_day_request",
          planDayMinItems,
          requestedPlaceCount,
          rawPreview: rawUserText.slice(0, 180),
        })
      );
    } else if (mode === "place_finder") {
      console.log(
        JSON.stringify({
          event: "place_finder_request",
          placeFinderMinItems,
          requestedPlaceCount,
          rawPreview: rawUserText.slice(0, 180),
        })
      );
    }

    const model =
      (process.env.GEMINI_MODEL || DEFAULT_MODEL).toString().trim() || DEFAULT_MODEL;

    const url = new URL(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`
    );
    url.searchParams.set("key", apiKey);

    async function callGemini(messagePayload, options = {}) {
      const temperature =
        typeof options.temperature === "number"
          ? options.temperature
          : resolvedMode === "place_finder" || resolvedMode === "recommendations"
            ? 0.7
            : 0.5;
      const schema = options.responseSchema || responseSchema;
      const geminiRes = await fetch(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemInstruction }],
          },
          contents: [
            {
              role: "user",
              parts: [{ text: JSON.stringify(messagePayload) }],
            },
          ],
          generationConfig: {
            temperature,
            maxOutputTokens:
              resolvedMode === "create_trip" ? 32768 : 8192,
            responseMimeType: "application/json",
            responseSchema: schema,
          },
        }),
      });

      const upstreamText = await geminiRes.text();
      if (!geminiRes.ok) {
        return {
          ok: false,
          status: geminiRes.status,
          body: upstreamText || `Upstream error (${geminiRes.status})`,
        };
      }

      let geminiJSON;
      try {
        geminiJSON = JSON.parse(upstreamText);
      } catch {
        return { ok: false, status: 502, body: upstreamText, error: "Invalid JSON from Gemini" };
      }

      const candidate = geminiJSON?.candidates?.[0];
      const candidateText =
        candidate?.content?.parts?.map((p) => p?.text ?? "").join("") ?? "";
      const finishReason = candidate?.finishReason ?? null;
      const blockReason = geminiJSON?.promptFeedback?.blockReason ?? null;

      const parsed = extractJSON(candidateText);
      const itemCount = Array.isArray(parsed?.items) ? parsed.items.length : 0;
      console.log(
        JSON.stringify({
          event: "gemini_create_trip_attempt",
          mode,
          finishReason,
          blockReason,
          ok: Boolean(parsed && typeof parsed === "object"),
          itemCount,
          truncated: finishReason === "MAX_TOKENS" || finishReason === "LENGTH",
          isDatesSet: parsed?.trip?.isDatesSet ?? null,
          startDate: parsed?.trip?.startDate ?? null,
          endDate: parsed?.trip?.endDate ?? null,
          textLength: String(candidateText).length,
        })
      );
      if (!parsed || typeof parsed !== "object") {
        // Do not echo the raw model payload to clients (can be huge).
        console.error("Gemini returned no usable JSON", {
          mode,
          finishReason,
          blockReason,
          preview: String(candidateText).slice(0, 400),
          length: String(candidateText).length,
        });
        return {
          ok: false,
          status: 502,
          error: "Gemini returned no usable JSON",
          finishReason,
          blockReason,
        };
      }
      return { ok: true, result: parsed, finishReason };
    }

    let firstCall = await callGemini(userMessage);
    // Gemini rejects oversized structured schemas with HTTP 400 in under a second
    // (surfaces as an error toast on 6+ day create_trip prompts). Retry without minItems.
    if (!firstCall.ok && (firstCall.status === 400 || firstCall.status === 422)) {
      const relaxedSchema = usesRecommendationPrompt
        ? buildRecommendationSchema(recommendationPlan, 0, {
            includeTripShell: mode === "create_trip",
          })
        : mode === "create_trip"
          ? buildCreateTripSchema(0)
          : null;
      if (relaxedSchema) {
        const relaxed = await callGemini(userMessage, {
          responseSchema: relaxedSchema,
        });
        if (relaxed.ok) firstCall = relaxed;
      }
    }
    // Parse failure: retry once with a smaller, shorter payload (truncation / empty candidates).
    if (!firstCall.ok && firstCall.error === "Gemini returned no usable JSON") {
      const compactCreateMin =
        mode === "create_trip" ? Math.min(createTripMinItems, 10) : 0;
      // Prefer the user's explicit N; otherwise a compact but still useful floor (skip single-kind = 0).
      const compactPlanDayMin =
        mode === "plan_day"
          ? requestedPlaceCount != null
            ? planDayMinItems
            : planDayMinItems > 0
              ? 6
              : 0
          : 0;
      const compactPlaceMin =
        mode === "place_finder"
          ? requestedPlaceCount != null
            ? placeFinderMinItems
            : Math.min(placeFinderMinItems, 6)
          : 0;
      const compactRecommendationMin = usesRecommendationPrompt
        ? Math.min(recommendationCount, 6)
        : 0;
      const compactMessage = {
        ...userMessage,
        outputRequirements: usesRecommendationPrompt
          ? `Return exactly ${compactRecommendationMin || 6} distinct kind=place picks with latitude and longitude. No schedule, no times. Keep notes under 12 words. Valid complete JSON only.`
          : mode === "place_finder"
            ? `Return exactly ${compactPlaceMin || 6} distinct kind=place venues. Keep notes under 12 words. Valid complete JSON only.`
            : mode === "plan_day"
              ? compactPlanDayMin > 0
                ? `Return exactly ${compactPlanDayMin} distinct activity items for this ask. Keep notes under 12 words. One venue per item. Valid complete JSON only.`
                : "Return the checklist/reminder/flight item(s) for this ask. Keep notes under 12 words. Valid complete JSON only."
              : mode === "create_trip"
                ? `Return a COMPLETE trip JSON with at least ${compactCreateMin || 10} seed items: 1 hotel, 3 restaurants, 4 activities across the days, 1 checklist, 1 reminder. Notes under 10 words. Valid complete JSON only — never only a hotel.`
                : userMessage.outputRequirements,
      };
      const compactRetry = await callGemini(compactMessage, {
        responseSchema: usesRecommendationPrompt
          ? buildRecommendationSchema(
              recommendationPlan,
              compactRecommendationMin || 6,
              { includeTripShell: mode === "create_trip" }
            )
          : mode === "create_trip"
            ? buildCreateTripSchema(compactCreateMin || 10)
            : mode === "place_finder"
              ? buildPlaceFinderSchema(compactPlaceMin || 6)
              : mode === "plan_day"
                ? buildPlanDaySchema(compactPlanDayMin)
                : responseSchema,
      });
      if (compactRetry.ok) {
        firstCall = compactRetry;
      }
    }
    if (!firstCall.ok) {
      if (firstCall.error) {
        return res.status(firstCall.status).json({ error: firstCall.error });
      }
      return res.status(firstCall.status).json({
        error: "Upstream AI request failed",
      });
    }

    let result = firstCall.result;
    let finishReason = firstCall.finishReason ?? null;

    // Truncated create_trip salvage often leaves only a hotel — force a recount retry.
    const truncatedCreateTrip =
      mode === "create_trip" &&
      !usesRecommendationPrompt &&
      !result.clarificationNeeded &&
      (finishReason === "MAX_TOKENS" || finishReason === "LENGTH");

    // Recommendation under-delivery, plus picks the radius check threw out.
    if (usesRecommendationPrompt && !result.clarificationNeeded) {
      const inRange = enforceTravelRadius(result.items, askPlan);
      if (inRange.dropped.length > 0) {
        console.log(
          JSON.stringify({
            event: "radius_violation",
            radiusMiles: askPlan.radius?.miles ?? null,
            originLabel: askPlan.origin?.label ?? null,
            dropped: inRange.dropped.slice(0, 12),
          })
        );
      }
      result = { ...result, items: inRange.items };

      const priorCount = Array.isArray(result.items) ? result.items.length : 0;
      const minAcceptable = Math.max(3, Math.floor(recommendationCount * 0.6));
      if (priorCount < minAcceptable) {
        const rejected = inRange.dropped
          .map((d) => `${d.title} (~${d.miles} mi)`)
          .join("; ");
        const retryCall = await callGemini(
          {
            ...userMessage,
            priorItemCount: priorCount,
            ...(rejected
              ? {
                  rejectedForDistance: rejected,
                }
              : {}),
            outputRequirements:
              `Your previous answer only left ${priorCount} usable pick(s). That is invalid. ` +
              (rejected
                ? `These were REJECTED for being outside the travel radius — do not suggest them or anything else that far: ${rejected}. `
                : "") +
              `Return a COMPLETE new JSON response with exactly ${recommendationCount} distinct kind=place picks, each with latitude and longitude, all inside the radius. ` +
              "No schedule, no times, no checklists. Do not apologize.",
          },
          {
            temperature: 0.5,
            responseSchema: buildRecommendationSchema(
              recommendationPlan,
              recommendationCount,
              { includeTripShell: mode === "create_trip" }
            ),
          }
        );
        if (retryCall.ok && Array.isArray(retryCall.result.items)) {
          const retryInRange = enforceTravelRadius(retryCall.result.items, askPlan);
          if (retryInRange.items.length > priorCount) {
            result = { ...retryCall.result, items: retryInRange.items };
            finishReason = retryCall.finishReason ?? finishReason;
          }
        }
      }
    } else if (mode === "place_finder" && !result.clarificationNeeded) {
      const priorCount = Array.isArray(result.items) ? result.items.length : 0;
      const targetCount = placeFinderMinItems;
      const minAcceptable = requestedPlaceCount != null ? requestedPlaceCount : 8;
      if (priorCount > 0 && priorCount < minAcceptable) {
        const retryCall = await callGemini(
          {
            ...userMessage,
            priorItemCount: priorCount,
            outputRequirements:
              `Your previous answer only returned ${priorCount} place(s). That is invalid. ` +
              `Return a COMPLETE new JSON response with exactly ${targetCount} distinct kind=place venues for the same ask. ` +
              "Each item MUST use kind=\"place\" (never activity). Notes under 10 words. Do not apologize; do not return fewer than requested.",
          },
          {
            temperature: 0.4,
            responseSchema: buildPlaceFinderSchema(targetCount),
          }
        );
        if (
          retryCall.ok &&
          Array.isArray(retryCall.result.items) &&
          retryCall.result.items.length > priorCount
        ) {
          result = retryCall.result;
          finishReason = retryCall.finishReason ?? finishReason;
        }
      }
    } else if (
      mode === "plan_day" &&
      !result.clarificationNeeded &&
      !isPlanDaySingleKindIntent(result.intent)
    ) {
      const priorCount = Array.isArray(result.items) ? result.items.length : 0;
      const targetCount = Math.max(planDayMinItems, requestedPlaceCount ?? 6);
      const minAcceptable =
        requestedPlaceCount != null ? requestedPlaceCount : 5;
      if (priorCount > 0 && priorCount < minAcceptable) {
        const retryCall = await callGemini(
          {
            ...userMessage,
            priorItemCount: priorCount,
            outputRequirements:
              `Your previous answer only returned ${priorCount} item(s). That is invalid for this ask. ` +
              `Return a COMPLETE new JSON response with exactly ${targetCount} distinct activity items. ` +
              "One venue/stop per item, notes under 12 words — never a single combined day summary. Do not apologize.",
          },
          {
            responseSchema: buildPlanDaySchema(targetCount),
          }
        );
        if (
          retryCall.ok &&
          Array.isArray(retryCall.result.items) &&
          retryCall.result.items.length > priorCount
        ) {
          result = retryCall.result;
          finishReason = retryCall.finishReason ?? finishReason;
        }
        // Keep the short first answer if the recount retry failed to parse.
      }
    } else if (
      mode === "create_trip" &&
      !usesRecommendationPrompt &&
      !result.clarificationNeeded
    ) {
      // Thin drafts (especially Toronto) sometimes return only a hotel — refill with explicit slots.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (
          !isCreateTripUnderDelivered(
            result.trip,
            result.items,
            text,
            attempt === 0 && truncatedCreateTrip
          )
        ) {
          break;
        }
        const draftTrip = sanitizeTripDraft(result.trip);
        const days = resolveCreateTripDayCount(
          draftTrip,
          inferTripDayCountFromText(text)
        );
        const minItems = minCreateTripItemCount(draftTrip, text);
        const itemCount = Array.isArray(result.items) ? result.items.length : 0;
        const venueCount = createTripVenueCount(result.items);
        const destination =
          safeString(draftTrip.destination) ||
          safeString(draftTrip.name) ||
          "the destination";
        const slotList = buildCreateTripSlotList(days, destination);
        const retryCall = await callGemini(
          {
            ...userMessage,
            text:
              `Fill a COMPLETE ${days}-day itinerary for ${destination}. ` +
              `Reuse trip name "${safeString(draftTrip.name) || destination}" and ` +
              (extractedDates
                ? `isDatesSet=true startDate=${extractedDates.startDate} endDate=${extractedDates.endDate}. `
                : `unscheduledDaysCount=${days}. `) +
              `Intent=full_itinerary.\n\n` +
              `Previous answer only had ${itemCount} item(s)` +
              (venueCount === 0 ? " (hotel-only — invalid)" : "") +
              `. Replace items with ALL of these slots (real venues only):\n${slotList}\n\n` +
              `Return at least ${minItems} items. Notes ≤8 words. Valid complete JSON only.`,
            priorItemCount: itemCount,
            outputRequirements:
              `Return a COMPLETE create_trip JSON for ${destination} with at least ${minItems} items matching the slot list. ` +
              "Never return only a hotel. Keep notes under 8 words. Include startTime/endTime on venue activities.",
          },
          {
            temperature: 0.35,
            responseSchema: buildCreateTripSchema(minItems),
          }
        );
        if (
          retryCall.ok &&
          Array.isArray(retryCall.result.items) &&
          retryCall.result.items.length > itemCount
        ) {
          // Prefer refill items; keep prior trip shell if refill omitted fields.
          const mergedTrip =
            retryCall.result.trip && typeof retryCall.result.trip === "object"
              ? { ...draftTrip, ...sanitizeTripDraft(retryCall.result.trip) }
              : draftTrip;
          result = {
            ...retryCall.result,
            trip: mergedTrip,
            clarificationNeeded: false,
            intent: normalizeCreateTripIntent(
              retryCall.result.intent || "full_itinerary"
            ),
          };
          finishReason = retryCall.finishReason ?? finishReason;
        } else if (!retryCall.ok) {
          break;
        }
      }
    }

    const routing = describeRouting(askPlan, mode, resolvedMode);

    if (usesRecommendationPrompt) {
      const cleanedItems = (Array.isArray(result.items) ? result.items : [])
        .map((item) => sanitizeItem(item, "recommendations"))
        .filter(Boolean);

      // create_trip callers treat a missing trip as a hard failure, so hand back
      // a region-level shell. `routing` tells newer clients this is a pick list.
      const tripShell =
        mode === "create_trip"
          ? {
              ...sanitizeTripDraft(result.trip),
              destination:
                safeString(result.trip?.destination) ||
                safeString(askPlan.origin?.label) ||
                "",
            }
          : undefined;

      return res.status(200).json({
        intent: safeString(result.intent) || "place_discovery",
        clarificationNeeded: Boolean(result.clarificationNeeded),
        clarificationPrompt: result.clarificationPrompt ?? "",
        items: cleanedItems,
        ...(tripShell ? { trip: tripShell, alternatives: [] } : {}),
        routing,
      });
    }

    if (mode === "create_trip") {
      if (!result.trip || typeof result.trip !== "object") {
        return res.status(502).json({ error: "Invalid Gemini JSON shape (missing trip)" });
      }
      let trip = sanitizeTripDraft(result.trip);
      // Ground-truth dates from the prompt beat a soft model miss (isDatesSet=false).
      if (extractedDates) {
        trip = applyExtractedDatesToTrip(trip, extractedDates);
      }
      trip = normalizeCreateTripDates(trip, referenceDate);
      const inferredDays = inferTripDayCountFromText(rawUserText);
      if (
        inferredDays &&
        inferredDays >= 2 &&
        !trip.isDatesSet &&
        (!Number.isInteger(trip.unscheduledDaysCount) || trip.unscheduledDaysCount < inferredDays)
      ) {
        trip.unscheduledDaysCount = inferredDays;
      }
      const dayCount = resolveCreateTripDayCount(trip, inferredDays);
      let cleanedItems = Array.isArray(result.items)
        ? redistributeCreateTripItems(
            result.items.map((item) => sanitizeItem(item, "create_trip")).filter(Boolean),
            dayCount
          )
        : [];
      cleanedItems = applyNamedStayToItems(cleanedItems, extractNamedStay(rawUserText), trip);
      return res.status(200).json({
        intent: normalizeCreateTripIntent(result.intent),
        clarificationNeeded: Boolean(result.clarificationNeeded),
        clarificationPrompt: result.clarificationPrompt ?? "",
        trip,
        alternatives: [],
        items: cleanedItems,
        routing,
      });
    }

    if (!Array.isArray(result.items)) {
      return res.status(502).json({
        error: "Gemini returned no usable items",
        body: result,
      });
    }

    let cleanedItems = result.items
      .map((item) => sanitizeItem(item, mode))
      .filter(Boolean);

    // A distance-bounded place_finder ask gets the same radius backstop.
    if (mode === "place_finder") {
      const inRange = enforceTravelRadius(cleanedItems, askPlan);
      if (inRange.dropped.length > 0) {
        console.log(
          JSON.stringify({
            event: "radius_violation",
            mode,
            radiusMiles: askPlan.radius?.miles ?? null,
            dropped: inRange.dropped.slice(0, 12),
          })
        );
      }
      // Never empty the list on a bad batch — a far pick beats no answer.
      if (inRange.items.length > 0) {
        cleanedItems = inRange.items;
      }
    }

    return res.status(200).json({
      intent: result.intent ?? "unknown",
      clarificationNeeded: Boolean(result.clarificationNeeded),
      clarificationPrompt: result.clarificationPrompt ?? "",
      items: cleanedItems,
      routing,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
