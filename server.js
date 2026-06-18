const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL || "https://dgxrkymrestwrcwgntdu.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

function clean(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return clean(value).toLowerCase();
}

async function fetchSalesPushTokens({ role = "", emails = [] } = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase service role key is not configured on the server.");
  }
  const cleanEmails = emails.map(normalizeEmail).filter(Boolean);
  const params = new URLSearchParams();
  params.set("select", "expo_push_token,user_email,role,active");
  params.set("active", "eq.true");
  if (role) params.set("role", `eq.${role}`);

  const response = await fetch(`${SUPABASE_URL}/rest/v1/sales_push_tokens?${params.toString()}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
    }
  });
  if (!response.ok) {
    throw new Error(`Push token load failed: ${await response.text()}`);
  }
  const rows = await response.json();
  return Array.from(new Set((rows || [])
    .filter((row) => !cleanEmails.length || cleanEmails.includes(normalizeEmail(row.user_email)))
    .map((row) => row.expo_push_token)
    .filter(Boolean)));
}

async function sendExpoPush(messages) {
  const response = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(messages)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Expo push failed: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    message: "API working"
  });
});
app.post("/api/verify-delete-pin", (req, res) => {
  const configuredPin = process.env.ADMIN_DELETE_PIN || "2580";
  const enteredPin = String(req.body?.pin || "").trim();

  if (!enteredPin) {
    return res.status(400).json({ ok: false, error: "Admin Delete PIN is required." });
  }

  if (enteredPin !== configuredPin) {
    return res.status(403).json({ ok: false, error: "Wrong Admin Delete PIN." });
  }

  res.json({ ok: true });
});

app.post("/api/send-sales-push", async (req, res) => {
  try {
    const role = clean(req.body?.role);
    const emails = Array.isArray(req.body?.emails) ? req.body.emails : [];
    const title = clean(req.body?.title);
    const body = clean(req.body?.body);
    const data = req.body?.data && typeof req.body.data === "object" ? req.body.data : {};

    if (!title || !body) {
      return res.status(400).json({ ok: false, error: "Notification title and body are required." });
    }

    const tokens = await fetchSalesPushTokens({ role, emails });
    if (!tokens.length) {
      return res.json({ ok: true, sent: 0, message: "No matching push tokens found." });
    }

    let sent = 0;
    for (let i = 0; i < tokens.length; i += 100) {
      const chunk = tokens.slice(i, i + 100).map((to) => ({
        to,
        sound: "default",
        title,
        body,
        data
      }));
      await sendExpoPush(chunk);
      sent += chunk.length;
    }

    res.json({ ok: true, sent });
  } catch (error) {
    console.error("Sales push send failed:", error);
    res.status(500).json({ ok: false, error: error.message || "Sales push send failed." });
  }
});

app.use(express.static(__dirname));
function sendIndex(req, res) {
  const html1 = path.join(__dirname, "index.html");
  const html2 = path.join(__dirname, "index.HTML");

  if (fs.existsSync(html1)) {
    res.sendFile(html1);
  } else if (fs.existsSync(html2)) {
    res.sendFile(html2);
  } else {
    res.send("index file not found");
  }
}

app.get(["/", "/admin", "/team", "/agent"], sendIndex);

app.use("/api", (req, res) => {
  res.status(404).json({
    error: "API route not found. Please deploy the latest server commit on Render."
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, ()=>{

  console.log(
    "Server running on port " + PORT
  );
});
