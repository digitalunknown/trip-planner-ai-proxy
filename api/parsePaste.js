export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method Not Allowed");
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).send("Missing GEMINI_API_KEY");

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    const text = body?.text ?? "";
    const facts = body?.facts ?? {};
    const tripContext = body?.tripContext ?? {};
    const existingItems = body?.existingItems ?? [];

    const systemInstruction = `
You are an assistant that converts pasted travel text into STRICT JSON for an iOS trip planner.

Return ONLY valid JSON of this exact shape:
{"items":[PasteImportItem...]}

Rules:
- Do NOT include markdown or extra keys.
- Prefer grouping related lines into one item (hotel block, etc.).
- Preserve/produce sourceSnippet for each item.
- Use kind: "activity" | "reminder" | "checklist" | "flight"
- Fill confidence (0..1).

PasteImportItem schema (all fields must exist; can be empty strings/null):
{
  "id": "UUID string",
  "kind": "activity|reminder|checklist|flight",
  "include": true,
  "dayID": "UUID string or null",
  "title": "string",
  "subtitle": "string",
  "location": "string",
  "notes": "string",
  "startTime": "ISO8601 string or null",
  "endTime": "ISO8601 string or null",
  "checklistItemsText": "string",
  "flightFromCode": "string",
  "flightToCode": "string",
  "flightNumber": "string",
  "confidence": 0.0,
  "sourceSnippet": "string"
}

If unsure about day assignment, set dayID to null.
`;

    const userMessage = {
      text,
      facts,
      tripContext,
      existingItems,
    };

    const geminiRes = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=" +
        encodeURIComponent(apiKey),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            { role: "user", parts: [{ text: systemInstruction }] },
            { role: "user", parts: [{ text: JSON.stringify(userMessage) }] },
          ],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: "application/json",
          },
        }),
      }
    );

    const raw = await geminiRes.text();
    if (!geminiRes.ok) {
      return res.status(500).send(raw || "Gemini request failed");
    }

    // Gemini usually returns JSON in candidates[0].content.parts[0].text
    const parsed = JSON.parse(raw);
    const textOut =
      parsed?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    // textOut should already be JSON string because responseMimeType is application/json,
    // but we still parse to be safe.
    const result = typeof textOut === "string" ? JSON.parse(textOut) : textOut;

    if (!result || !Array.isArray(result.items)) {
      return res.status(500).send("Invalid Gemini JSON shape");
    }

    return res.status(200).json({ items: result.items });
  } catch (err) {
    return res.status(500).send(String(err?.message || err));
  }
}
