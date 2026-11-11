// Vercel Serverless Function: keeps your Gemini API key secret on the server.
// Set GEMINI_API_KEY in Vercel > Project Settings > Environment Variables.

const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const FALLBACK_MODELS = ["gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-2.5-flash-lite"];
const TOTAL_BUDGET_MS = 52000;
const ATTEMPT_TIMEOUT_MS = 16000;

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

function thinkingFallbacks(model) {
  if (model.includes("2.5")) return [{ thinkingBudget: 0 }, { thinkingBudget: 128 }, undefined];
  return [{ thinkingLevel: "minimal" }, { thinkingLevel: "low" }, undefined];
}

function parseGeminiJson(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.filter((p) => !p.thought).map((p) => p.text || "").join("");
  if (!text) {
    const why = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason || "unknown";
    return { emptyReason: why };
  }
  const cleaned = text.replace(/```json|```/gi, "").trim();
  return { parsed: JSON.parse(cleaned) };
}

async function callGemini({ model, apiKey, image, mimeType, timeoutMs }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const thinkingOptions = thinkingFallbacks(model);

  for (let i = 0; i < thinkingOptions.length; i++) {
    const generationConfig = {
      responseMimeType: "application/json",
      responseSchema: SCHEMA,
      temperature: 0.3,
      maxOutputTokens: 2048,
    };
    if (thinkingOptions[i] !== undefined) {
      generationConfig.thinkingConfig = thinkingOptions[i];
    }

    const payload = {
      contents: [{ role: "user", parts: [{ text: PROMPT }, { inlineData: { mimeType, data: image } }] }],
      generationConfig,
    };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });

      if (res.status === 400 && i < thinkingOptions.length - 1) {
        const peek = await res.clone().text();
        if (/think/i.test(peek)) continue;
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = async (req, res_) => {
  const json = (status, body) => res_.status(status).json(body);

  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const apiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
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
  if (typeof image !== "string" || typeof mimeType !== "string" || !image || !mimeType) {
    return json(400, { error: "No image received." });
  }
  image = image.replace(/^data:[^;]+;base64,/, "").trim();

  const primaryModel = (process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  const distinctFallbacks = FALLBACK_MODELS.filter((m) => m !== primaryModel);
  const attempts = [primaryModel, primaryModel, ...distinctFallbacks];
  const deadline = Date.now() + TOTAL_BUDGET_MS;

  let lastStatus = 502;
  let lastError = "The AI took too long to answer. Please tap Try again.";

  for (let idx = 0; idx < attempts.length; idx++) {
    const remaining = deadline - Date.now();
    if (remaining <= 2000) break;

    const model = attempts[idx];
    const timeoutMs = Math.min(ATTEMPT_TIMEOUT_MS, remaining);

    try {
      const res = await callGemini({ model, apiKey, image, mimeType, timeoutMs });
      if (!res) continue;

      if (!res.ok) {
        const raw = await res.text();
        let msg = raw;
        try { msg = JSON.parse(raw)?.error?.message || raw; } catch {}
        console.error("Gemini error", model, res.status, raw);

        // Auth or malformed request errors won't be fixed by retrying or switching models.
        if (res.status === 401 || res.status === 403 || res.status === 400) {
          return json(502, {
            error: `Google rejected the API key or request. (Google ${res.status}: ${String(msg).slice(0, 200)})`,
          });
        }

        const friendly =
          res.status === 429 ? "Too many requests or quota reached. Wait a minute and try again."
          : res.status === 404 ? "The AI model name was not found."
          : "The AI service had a problem.";
        lastStatus = 502;
        lastError = `${friendly} (Google ${res.status}: ${String(msg).slice(0, 200)})`;

        // On 404, skip any duplicate attempts for the same missing model.
        if (res.status === 404) {
          while (idx + 1 < attempts.length && attempts[idx + 1] === model) idx++;
        }
        continue;
      }

      const data = await res.json();
      const { parsed, emptyReason } = parseGeminiJson(data);
      if (emptyReason) {
        lastStatus = 502;
        lastError = `The AI returned an empty answer (${emptyReason}). Try a clearer photo.`;
        continue;
      }
      return json(200, parsed);
    } catch (err) {
      console.error("Attempt failed", model, err);
      if (err.name === "AbortError") {
        lastStatus = 504;
        lastError = "The AI took too long to answer. Please tap Try again.";
      } else if (err instanceof SyntaxError) {
        lastStatus = 502;
        lastError = "The AI returned an incomplete answer. Please tap Try again.";
      } else {
        lastStatus = 500;
        lastError = `Server problem: ${String(err.message || err).slice(0, 150)}`;
      }
    }
  }

  return json(lastStatus, { error: lastError });
};
