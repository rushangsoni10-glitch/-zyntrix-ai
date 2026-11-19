exports.handler = async function (event) {
  const jsonHeaders = { "Content-Type": "application/json" };

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: jsonHeaders,
      body: JSON.stringify({ error: "Method Not Allowed" })
    };
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  const supabaseUrl = (process.env.SUPABASE_URL || "https://ddqodzfdazjedojbtnjl.supabase.co").replace(/\/+$/, "");
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

  if (!geminiKey) {
    return {
      statusCode: 500,
      headers: jsonHeaders,
      body: JSON.stringify({ error: "GEMINI_API_KEY is missing in Netlify Environment Variables." })
    };
  }

  if (!supabaseServiceKey) {
    return {
      statusCode: 500,
      headers: jsonHeaders,
      body: JSON.stringify({ error: "SUPABASE_SERVICE_ROLE_KEY is missing in Netlify Environment Variables." })
    };
  }

  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

  if (!token) {
    return {
      statusCode: 401,
      headers: jsonHeaders,
      body: JSON.stringify({ error: "Please sign in first to run workflows." })
    };
  }

  const sbHeaders = {
    "apikey": supabaseServiceKey,
    "Authorization": `Bearer ${supabaseServiceKey}`,
    "Content-Type": "application/json"
  };

  try {
    // 1. Verify the logged-in user via Supabase Auth REST API
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        "apikey": supabaseServiceKey,
        "Authorization": `Bearer ${token}`
      }
    });

    if (!userRes.ok) {
      return {
        statusCode: 401,
        headers: jsonHeaders,
        body: JSON.stringify({ error: "Session expired or invalid. Please log out and log in again." })
      };
    }

    const user = await userRes.json();
    const userId = user.id;

    const { prompt, workflowType = "Custom Workflow" } = JSON.parse(event.body || "{}");
    if (!prompt || !prompt.trim()) {
      return {
        statusCode: 400,
        headers: jsonHeaders,
        body: JSON.stringify({ error: "Prompt is required." })
      };
    }

    // 2. Fetch user profile & credits from Supabase REST API
    const profileRes = await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${userId}&select=credits_remaining,brand_name,target_audience,brand_tone`,
      { headers: sbHeaders }
    );
    const profiles = await profileRes.json();
    const profile = Array.isArray(profiles) ? profiles[0] : null;

    if (!profile) {
      return {
        statusCode: 404,
        headers: jsonHeaders,
        body: JSON.stringify({ error: "User profile not found in database." })
      };
    }

    if ((profile.credits_remaining ?? 0) < 1) {
      return {
        statusCode: 402,
        headers: jsonHeaders,
        body: JSON.stringify({ error: "OUT_OF_CREDITS" })
      };
    }

    // 3. Build prompt with saved Brand Voice
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

    // 4. Call Google Gemini API
    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: finalPrompt }] }]
        })
      }
    );

    const geminiData = await geminiRes.json();

    if (!geminiRes.ok) {
      return {
        statusCode: geminiRes.status,
        headers: jsonHeaders,
        body: JSON.stringify({ error: geminiData.error?.message || "Gemini API error" })
      };
    }

    const reply =
      geminiData.candidates?.[0]?.content?.parts
        ?.map((p) => p.text || "")
        .join("")
        .trim() || "No response generated.";

    // 5. Deduct 1 point in Supabase
    const updatedCredits = Math.max(0, (profile.credits_remaining ?? 0) - 1);
    await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${userId}`, {
      method: "PATCH",
      headers: sbHeaders,
      body: JSON.stringify({ credits_remaining: updatedCredits })
    });

    // 6. Save output to Saved History
    await fetch(`${supabaseUrl}/rest/v1/generations`, {
      method: "POST",
      headers: sbHeaders,
      body: JSON.stringify({
        user_id: userId,
        workflow_type: workflowType,
        prompt: prompt.trim(),
        output: reply
      })
    });

    return {
      statusCode: 200,
      headers: jsonHeaders,
      body: JSON.stringify({
        reply,
        creditsRemaining: updatedCredits
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: jsonHeaders,
      body: JSON.stringify({ error: err.message || "Unexpected server error" })
    };
  }
};
