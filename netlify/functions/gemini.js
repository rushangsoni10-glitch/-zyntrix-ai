const { createClient } = require("@supabase/supabase-js");

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Method Not Allowed" })
    };
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL || "https://ddqodzfdazjedojbtnjl.supabase.co";
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

  if (!geminiKey) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "GEMINI_API_KEY is missing in Netlify Environment Variables." })
    };
  }

  if (!supabaseServiceKey) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Supabase service/secret key is missing in Netlify Environment Variables." })
    };
  }

  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

  if (!token) {
    return {
      statusCode: 401,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Please sign in first to run workflows." })
    };
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const { data: userData, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !userData?.user) {
      return {
        statusCode: 401,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Session expired. Please log in again." })
      };
    }

    const userId = userData.user.id;
    const { prompt, workflowType = "Custom Workflow" } = JSON.parse(event.body || "{}");

    if (!prompt || !prompt.trim()) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Prompt is required." })
      };
    }

    // Fetch user profile & credits
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("credits_remaining, brand_name, target_audience, brand_tone")
      .eq("id", userId)
      .single();

    if (profileError || !profile) {
      return {
        statusCode: 404,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "User profile not found in database." })
      };
    }

    if ((profile.credits_remaining ?? 0) < 1) {
      return {
        statusCode: 402,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "OUT_OF_CREDITS" })
      };
    }

    // Build prompt with saved Brand Voice if available
    const brandContext = [
      profile.brand_name ? `Brand Name: ${profile.brand_name}` : "",
      profile.target_audience ? `Target Audience: ${profile.target_audience}` : "",
      profile.brand_tone ? `Tone/Style: ${profile.brand_tone}` : ""
    ]
      .filter(Boolean)
      .join("\n");

    const finalPrompt = brandContext
      ? `Follow this brand context:\n${brandContext}\n\nTask:\n${prompt.trim()}`
      : prompt.trim();

    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: finalPrompt }] }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        statusCode: response.status,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: data.error?.message || "Gemini API error" })
      };
    }

    const reply =
      data.candidates?.[0]?.content?.parts
        ?.map((p) => p.text || "")
        .join("")
        .trim() || "No response generated.";

    // Deduct 1 credit
    const updatedCredits = Math.max(0, (profile.credits_remaining ?? 0) - 1);
    await supabaseAdmin
      .from("profiles")
      .update({ credits_remaining: updatedCredits })
      .eq("id", userId);

    // Save to history
    await supabaseAdmin.from("generations").insert({
      user_id: userId,
      workflow_type: workflowType,
      prompt: prompt.trim(),
      output: reply
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reply,
        creditsRemaining: updatedCredits
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message || "Unexpected server error" })
    };
  }
};
