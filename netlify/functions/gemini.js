import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callGeminiSafe(apiKey, payload) {
  const models = ["gemini-3.5-flash", "gemini-2.5-flash-lite"];

  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }
      );

      if (response.ok) {
        return await response.json();
      }

      if (response.status === 429 || response.status === 503) {
        await sleep(2000 * (attempt + 1));
        continue;
      }

      const errData = await response.json();
      throw new Error(errData.error?.message || "Gemini API error");
    }
  }
  throw new Error("HIGH_TRAFFIC");
}

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const authHeader = event.headers.authorization || "";
    const token = authHeader.replace("Bearer ", "").trim();

    if (!token) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: "Please log in to run Zyntrix workflows." })
      };
    }

    const { prompt, workflowType } = JSON.parse(event.body);
    if (!prompt || prompt.length > 4000) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Prompt must be between 1 and 4000 characters." })
      };
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: "Session expired. Please log in again." })
      };
    }

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .single();

    if (profileError || !profile) {
      return { statusCode: 404, body: JSON.stringify({ error: "User profile not found." }) };
    }

    if (profile.credits_remaining <= 0) {
      return {
        statusCode: 402,
        body: JSON.stringify({ error: "OUT_OF_CREDITS" })
      };
    }

    const brandContext = profile.brand_name
      ? `\nBrand Name: ${profile.brand_name}\nTarget Audience: ${profile.target_audience || "General"}\nTone/Language Style: ${profile.brand_tone || "Professional & Persuasive"}`
      : "";

    const systemPrompt = `You are Zyntrix, an expert AI business automation and growth engine.
Deliver complete, actionable, ready-to-use outputs (cold emails, Instagram Reel scripts, WhatsApp messages, marketing plans, or custom workflows).
Use clean Markdown headings, bold key points, and bullet lists. Never cut responses short.${brandContext}`;

    const geminiData = await callGeminiSafe(process.env.GEMINI_API_KEY, {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [
        {
          role: "user",
          parts: [{ text: workflowType ? `[${workflowType}] ${prompt}` : prompt }]
        }
      ],
      generationConfig: { maxOutputTokens: 4096 }
    });

    const reply =
      geminiData.candidates?.[0]?.content?.parts?.[0]?.text ||
      "Could not generate a response. Please try again.";

    const newCredits = profile.credits_remaining - 1;
    await supabase
      .from("profiles")
      .update({ credits_remaining: newCredits })
      .eq("id", user.id);

    await supabase.from("generations").insert({
      user_id: user.id,
      workflow_type: workflowType || "Custom Workflow",
      prompt,
      output: reply
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply, creditsRemaining: newCredits })
    };
  } catch (err) {
    if (err.message === "HIGH_TRAFFIC") {
      return {
        statusCode: 503,
        body: JSON.stringify({
          error: "Zyntrix AI is busy right now. Your point was NOT deducted—please try again in 5 seconds."
        })
      };
    }
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}
