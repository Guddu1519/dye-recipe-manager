const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.json());

const DATA_FILE = path.join(__dirname, "data.json");
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const assistantUsage = new Map();
const ASSISTANT_LIMIT_PER_HOUR = Number(process.env.AI_ASSISTANT_LIMIT_PER_HOUR || 20);

app.use(express.static(__dirname));
app.get("/", (req, res) => {
  const html1 = path.join(__dirname, "index.html");
  const html2 = path.join(__dirname, "index.HTML");

  if (fs.existsSync(html1)) {
    res.sendFile(html1);
  } else if (fs.existsSync(html2)) {
    res.sendFile(html2);
  } else {
    res.send("index file not found");
  }
});

function readData(){

  if(!fs.existsSync(DATA_FILE)){

    return {
      colors: [],
      recipes: []
    };
  }

  try{

    const raw = fs.readFileSync(DATA_FILE, "utf8");

    return JSON.parse(raw);

  }catch{

    return {
      colors: [],
      recipes: []
    };
  }
}

function writeData(data){

  fs.writeFileSync(
    DATA_FILE,
    JSON.stringify(data, null, 2)
  );
}

app.get("/api/data", (req,res)=>{

  const data = readData();

  res.json(data);
});

app.post("/api/data", (req,res)=>{

  const data = {
    colors: req.body.colors || [],
    recipes: req.body.recipes || []
  };

  writeData(data);

  res.json({
    success: true
  });
});

function getClientIp(req){
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "local").split(",")[0].trim();
}

function checkAssistantLimit(req){
  const key = getClientIp(req);
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const current = assistantUsage.get(key) || {count:0, resetAt:now + hour};
  if(now > current.resetAt){
    current.count = 0;
    current.resetAt = now + hour;
  }
  current.count += 1;
  assistantUsage.set(key, current);
  return {
    allowed: current.count <= ASSISTANT_LIMIT_PER_HOUR,
    remaining: Math.max(0, ASSISTANT_LIMIT_PER_HOUR - current.count),
    resetAt: current.resetAt
  };
}

async function verifySupabaseUser(token){
  if(process.env.AI_ASSISTANT_ALLOW_DEV === "true") return {email:"dev-local"};
  if(!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new Error("Supabase auth environment variables are missing.");
  if(!token) throw new Error("Login required for AI Assistant.");

  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`
    }
  });
  if(!response.ok) throw new Error("Login expired. Please login again.");
  return response.json();
}

async function supabaseRead(table, select){
  if(!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Supabase server environment variables are missing.");
  const url = `${SUPABASE_URL}/rest/v1/${table}?select=${encodeURIComponent(select)}`;
  const response = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
    }
  });
  if(!response.ok){
    const text = await response.text();
    throw new Error(`Could not read ${table}: ${text}`);
  }
  return response.json();
}

function compactRows(rows, limit){
  return Array.isArray(rows) ? rows.slice(0, limit) : [];
}

async function loadAssistantContext(){
  const [colors, recipes, programs, purchases, ledger, usage] = await Promise.all([
    supabaseRead("colors", "id,name,rate,color_type"),
    supabaseRead("recipes", "id,recipe_no,color_name,than_count,hex_code,dyes,created_at"),
    supabaseRead("programs", "id,program_no,program_name,status,program_date,required_thans,stock_deducted,selected_recipe_numbers,recipe_snapshot,created_at"),
    supabaseRead("chemical_stock_purchases", "id,chemical_name,purchased_qty_grams,unit,purchase_date,supplier,rate_per_kg,notes,created_at"),
    supabaseRead("chemical_stock_ledger", "id,chemical_name,entry_type,qty_delta_grams,program_id,program_no,note,created_at"),
    supabaseRead("program_stock_usage", "id,program_id,program_no,program_name,program_date,chemical_name,quantity_used_grams,before_stock_grams,after_stock_grams,created_at")
  ]);

  return {
    generatedAt: new Date().toISOString(),
    counts: {
      colors: colors.length,
      recipes: recipes.length,
      programs: programs.length,
      purchases: purchases.length,
      ledger: ledger.length,
      programUsage: usage.length
    },
    colors: compactRows(colors, 250),
    recipes: compactRows(recipes, 250),
    programs: compactRows(programs, 250),
    stockPurchases: compactRows(purchases, 250),
    stockLedger: compactRows(ledger, 500),
    programStockUsage: compactRows(usage, 500)
  };
}

function extractResponseText(responseJson){
  if(responseJson.output_text) return responseJson.output_text;
  const parts = [];
  (responseJson.output || []).forEach(item => {
    (item.content || []).forEach(content => {
      if(content.text) parts.push(content.text);
    });
  });
  return parts.join("\n").trim();
}

app.post("/api/ai-assistant", async (req, res) => {
  try{
    const limit = checkAssistantLimit(req);
    if(!limit.allowed){
      return res.status(429).json({error:"AI Assistant hourly limit reached. Please try again later."});
    }
    if(!OPENAI_API_KEY){
      return res.status(500).json({error:"OPENAI_API_KEY is missing on the server."});
    }

    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const user = await verifySupabaseUser(token);
    const question = String(req.body.question || "").trim();
    const history = Array.isArray(req.body.history) ? req.body.history.slice(-8) : [];
    if(!question) return res.status(400).json({error:"Question is required."});
    if(question.length > 500) return res.status(400).json({error:"Question is too long. Keep it below 500 characters."});

    const dataContext = await loadAssistantContext();
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        max_output_tokens: 900,
        instructions: [
          "You are the read-only AI Production Assistant for MONICA TEXTILE MILLS dye recipe manager.",
          "Answer only from the provided Supabase data snapshot. Do not invent data.",
          "Never suggest editing, inserting, deleting, or updating database rows.",
          "For totals, show units clearly: grams, kg, Rs., thans.",
          "If a table helps, return a compact markdown table.",
          "If data is missing, say exactly what is missing."
        ].join("\n"),
        input: [
          {
            role: "user",
            content: "User: " + (user.email || "logged-in user") + "\nRecent chat: " + JSON.stringify(history) + "\nSupabase data snapshot: " + JSON.stringify(dataContext) + "\nQuestion: " + question
          }
        ]
      })
    });

    const result = await response.json();
    if(!response.ok){
      return res.status(response.status).json({error: result.error?.message || "OpenAI request failed."});
    }

    res.json({
      answer: extractResponseText(result) || "No answer generated.",
      remaining: limit.remaining
    });
  }catch(error){
    console.error("AI Assistant error", error);
    res.status(500).json({error: error.message || "AI Assistant failed."});
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, ()=>{

  console.log(
    "Server running on port " + PORT
  );
});
