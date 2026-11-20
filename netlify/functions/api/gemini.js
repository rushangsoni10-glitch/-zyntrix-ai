module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const supabaseUrl = (process.env.SUPABASE_URL || "https://ddqodzfdazjedojbtnjl.supabase.co").replace(/\/+$/, "");
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
    const geminiApiKey = process.env.GEMINI_API_KEY;
    const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";

    if (!geminiApiKey || !supabaseServiceKey) {
      return res.status(500).json({ error: "Missing server API keys in Vercel environment variables." });
    }

    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) {
      return res.status(401).json({ error: "Please log in first to run AI workflows." });
    }

    // 1. Verify Supabase user session
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: supabaseServiceKey,
        Authorization: `Bearer ${token}`,
      },
    });

    if (!userRes.ok) {
      return res.status(401).json({ error: "Session expired. Please log in again." });
    }

    const userData = await userRes.json();
    const userId = userData.id;

    // 2. Parse request payload
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const prompt = (body.prompt || "").trim();
    const workflow = (body.workflow || "General AI Workflow").trim();
    const tone = (body.tone || "Professional & Persuasive").trim();
    const length = (body.length || "Medium").trim();
    const brandVoice = (body.brandVoice || "").trim();

    if (!prompt) {
      return res.status(400).json({ error: "Please enter a prompt or task description first." });
    }

    // 3. Build structured system + user instruction
    const fullInstruction = [
      `You are Zentrix AI, an elite business automation & growth assistant.`,
      `Selected Workflow: ${workflow}`,
      `Target Tone: ${tone}`,
      `Desired Output Length: ${length}`,
      brandVoice ? `Brand Voice Guidelines: ${brandVoice}` : null,
      `Deliver clean, ready-to-use, high-converting output formatted clearly with headings or bullet points where helpful. Do not include filler meta-commentary.`,
      `\nUser Request:\n${prompt}`,
    ]
      .filter(Boolean)
      .join("\n");

    // 4. Call Google Gemini API (gemini-3.8-flash)
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(geminiApiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: fullInstruction }] }],
        }),
      }
    );

    const geminiData = await geminiRes.json();
    if (!geminiRes.ok) {
      return res.status(geminiRes.status).json({
        error: geminiData?.error?.message || "Gemini API request failed.",
      });
    }

    const output =
      geminiData?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";

    if (!output) {
      return res.status(502).json({ error: "Empty response returned from Gemini." });
    }

    return res.status(200).json({
      result: output,
      text: output,
      output,
      userId,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Internal Server Error" });
  }
};
