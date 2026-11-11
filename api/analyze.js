// Vercel Serverless Function: keeps your Gemini API key secret on the server.
// Set GEMINI_API_KEY in Vercel > Project Settings > Environment Variables.

const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

const PROMPT = `You are a nutrition expert. Analyze the food in this image.
- If the image does not contain food or drink, set isFood to false and fill other fields with zeros/empty strings.
- Otherwise identify the whole meal, list each visible item with its estimated calories, and estimate the TOTAL nutrition for the portion shown.
- Estimate portion size from visual cues (plate, utensils, packaging).
- healthScore is 1-10 (10 = very nutritious).
- dietaryTags: 2-4 short tags such as "High Protein", "Low Carb", "Vegetarian", "High Sugar".
- Be honest about uncertainty via the confidence field (low, medium, high).
- Keep explanation to one or two short sentences and give one practical tip.`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    isFood: { type: "BOOLEAN" },
    foodName: { type: "STRING" },
    servingSize: { type: "STRING", description: "e.g. '1 plate (~350 g)'" },
    calories: { type: "INTEGER" },
    protein: { type: "INTEGER", description: "grams" },
    carbs: { type: "INTEGER", description: "grams" },
    fat: { type: "INTEGER", description: "grams" },
    fiber: { type: "INTEGER", description: "grams" },
    sugar: { type: "INTEGER", description: "grams" },
    sodium: { type: "INTEGER", description: "milligrams" },
    healthScore: { type: "INTEGER" },
    confidence: { type: "STRING" },
    dietaryTags: { type: "ARRAY", items: { type: "STRING" } },
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { name: { type: "STRING" }, calories: { type: "INTEGER" } },
        required: ["name", "calories"],
      },
    },
    explanation: { type: "STRING" },
    tip: { type: "STRING" },
  },
  required: [
    "isFood", "foodName", "servingSize", "calories", "protein", "carbs", "fat",
    "fiber", "sugar", "sodium", "healthScore", "confidence", "dietaryTags",
    "items", "explanation", "tip",
  ],
};

module.exports = async (req, res_) => {
  const json = (status, body) => res_.status(status).json(body);

  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return json(500, { error: "Server is missing GEMINI_API_KEY. Add it in Vercel environment variables and redeploy." });
  }

  let image, mimeType;
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    ({ image, mimeType } = body);
  } catch {
    return json(400, { error: "Invalid request body." });
  }
  if (!image || !mimeType) return json(400, { error: "No image received." });

  const generationConfig = {
    responseMimeType: "application/json",
    responseSchema: SCHEMA,
    temperature: 0.3,
    maxOutputTokens: 1000,
  };
  // Minimise "thinking" so responses stay fast.
  const thinking = MODEL.includes("2.5") ? { thinkingBudget: 0 } : { thinkingLevel: "minimal" };
  generationConfig.thinkingConfig = thinking;

  const payload = {
    contents: [{ role: "user", parts: [{ text: PROMPT }, { inlineData: { mimeType, data: image } }] }],
    generationConfig,
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);

  try {
    const call = () => fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    let res = await call();
    if (res.status === 400) {
      const peek = await res.clone().text();
      if (/think/i.test(peek)) {          // thinking setting not accepted: retry without it
        delete generationConfig.thinkingConfig;
        res = await call();
      }
    }

    if (!res.ok) {
      const raw = await res.text();
      let msg = raw;
      try { msg = JSON.parse(raw)?.error?.message || raw; } catch {}
      console.error("Gemini error", MODEL, res.status, raw);
      const friendly =
        res.status === 429 ? "Too many requests or quota reached. Wait a minute and try again."
        : res.status === 401 || res.status === 403 || res.status === 400 ? "Google rejected the API key or request."
        : res.status === 404 ? "The AI model name was not found."
        : "The AI service had a problem.";
      return json(502, { error: `${friendly} (Google ${res.status}: ${String(msg).slice(0, 200)})` });
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("");
    if (!text) {
      const why = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason || "unknown";
      return json(502, { error: `The AI returned an empty answer (${why}). Try a clearer photo.` });
    }
    return json(200, JSON.parse(text.replace(/```json|```/g, "").trim()));
  } catch (err) {
    console.error(err);
    if (err.name === "AbortError") return json(504, { error: "The AI took too long to answer. Please tap Try again." });
    return json(500, { error: `Server problem: ${String(err.message || err).slice(0, 150)}` });
  } finally {
    clearTimeout(timer);
  }
};
