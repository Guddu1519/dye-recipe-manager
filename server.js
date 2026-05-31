const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.json());

app.get("/api/health", (req, res) => {
  res.json({ ok: true, message: "API working" });
});

const DATA_FILE = path.join(__dirname, "data.json");
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const AI_PROVIDER = (process.env.AI_PROVIDER || "ollama").toLowerCase();
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.1:8b";
const assistantUsage = new Map();
const ASSISTANT_LIMIT_PER_HOUR = Number(process.env.AI_ASSISTANT_LIMIT_PER_HOUR || 20);
const ASSISTANT_FETCH_TIMEOUT_MS = Number(process.env.AI_ASSISTANT_FETCH_TIMEOUT_MS || 45000);

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
  const response = await fetchWithTimeout(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
    }
  }, ASSISTANT_FETCH_TIMEOUT_MS, `Supabase read timed out for ${table}.`);
  if(!response.ok){
    const text = await response.text();
    throw new Error(`Could not read ${table}: ${text}`);
  }
  return response.json();
}

async function fetchWithTimeout(url, options, ms, timeoutMessage){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try{
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  }catch(error){
    if(error.name === "AbortError"){
      throw new Error(timeoutMessage || "Request timed out.");
    }
    throw error;
  }finally{
    clearTimeout(timer);
  }
}

function isSchemaReadError(error){
  const message = String(error?.message || error || "");
  return message.includes("42703") ||
    message.includes("42P01") ||
    message.includes("does not exist") ||
    message.includes("schema cache");
}

async function supabaseReadFallback(table, selectOptions, required=false){
  const options = Array.isArray(selectOptions) ? selectOptions : [selectOptions];
  let lastError = null;

  for(const select of options){
    try{
      return await supabaseRead(table, select);
    }catch(error){
      lastError = error;
      if(!isSchemaReadError(error)) throw error;
      console.warn(`AI Assistant fallback for ${table}: ${error.message}`);
    }
  }

  if(required) throw lastError;
  console.warn(`AI Assistant skipped optional table ${table}: ${lastError?.message || "unknown error"}`);
  return [];
}

function compactRows(rows, limit){
  return Array.isArray(rows) ? rows.slice(0, limit) : [];
}

async function loadAssistantContext(){
  const [colors, recipes, programs, purchases, ledger, usage] = await Promise.all([
    supabaseReadFallback("colors", ["id,name,rate,color_type", "id,name,rate", "*"], true),
    supabaseReadFallback("recipes", ["id,recipe_no,color_name,recipe_master_name,than_count,hex_code,dyes,created_at", "id,recipe_no,color_name,than_count,hex_code,dyes,created_at", "id,recipe_no,color_name,than_count,dyes", "*"], true),
    supabaseReadFallback("programs", ["id,program_no,program_name,status,program_date,required_thans,stock_deducted,selected_recipe_numbers,recipe_snapshot,created_at", "id,program_no,program_name,program_date,selected_recipe_numbers,recipe_snapshot,created_at", "*"]),
    supabaseReadFallback("chemical_stock_purchases", ["id,chemical_name,purchased_qty_grams,unit,purchase_date,supplier,rate_per_kg,notes,created_at", "*"]),
    supabaseReadFallback("chemical_stock_ledger", ["id,chemical_name,entry_type,qty_delta_grams,program_id,program_no,note,created_at", "*"]),
    supabaseReadFallback("program_stock_usage", ["id,program_id,program_no,program_name,program_date,chemical_name,quantity_used_grams,before_stock_grams,after_stock_grams,created_at", "*"])
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

function buildAssistantInstructions(){
  return [
    "You are the read-only AI Production Assistant for MONICA TEXTILE MILLS dye recipe manager.",
    "Answer only from the provided Supabase data snapshot. Do not invent data.",
    "Never suggest editing, inserting, deleting, or updating database rows.",
    "For totals, show units clearly: grams, kg, Rs., thans.",
    "If a table helps, return a compact markdown table.",
    "If data is missing, say exactly what is missing."
  ].join("\n");
}

function buildAssistantPrompt(user, history, dataContext, question){
  return [
    buildAssistantInstructions(),
    "",
    "User: " + (user.email || "logged-in user"),
    "Recent chat: " + JSON.stringify(history),
    "Supabase data snapshot: " + JSON.stringify(dataContext),
    "Question: " + question
  ].join("\n");
}

async function askOllama(prompt){
  const response = await fetchWithTimeout(`${OLLAMA_URL.replace(/\/$/, "")}/api/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      options: {
        temperature: 0.2
      }
    })
  }, ASSISTANT_FETCH_TIMEOUT_MS, "Free local AI timed out. Make sure Ollama is running.");

  const result = await response.json();
  if(!response.ok){
    throw new Error(result.error || "Free local AI failed.");
  }
  return result.response || "";
}

async function askOpenAI(prompt){
  if(!OPENAI_API_KEY){
    throw new Error("OPENAI_API_KEY is missing on the server.");
  }

  const response = await fetchWithTimeout("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_output_tokens: 900,
      instructions: buildAssistantInstructions(),
      input: [
        {
          role: "user",
          content: prompt
        }
      ]
    })
  }, ASSISTANT_FETCH_TIMEOUT_MS, "OpenAI request timed out. Please try a shorter question or try again.");

  const result = await response.json();
  if(!response.ok){
    const message = result.error?.message || "OpenAI request failed.";
    if(/quota|billing|plan/i.test(message)){
      throw new Error("OpenAI quota/billing is not active. Free local AI can still work if Ollama is running.");
    }
    throw new Error(message);
  }
  return extractResponseText(result) || "";
}

async function askAiProvider(prompt){
  if(AI_PROVIDER === "openai"){
    return {answer: await askOpenAI(prompt), provider: "openai"};
  }

  try{
    return {answer: await askOllama(prompt), provider: "ollama"};
  }catch(ollamaError){
    console.warn("Ollama AI failed", ollamaError.message);
    if(AI_PROVIDER === "ollama" || !OPENAI_API_KEY){
      throw new Error("Free local AI is not running. Install Ollama, run `ollama pull " + OLLAMA_MODEL + "`, then start Ollama and try again.");
    }
    return {answer: await askOpenAI(prompt), provider: "openai"};
  }
}

async function handleAiAssistant(req, res){
  try{
    const limit = checkAssistantLimit(req);
    if(!limit.allowed){
      return res.status(429).json({error:"AI Assistant hourly limit reached. Please try again later."});
    }

    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const user = await verifySupabaseUser(token);
    const question = String(req.body.question || "").trim();
    const history = Array.isArray(req.body.history) ? req.body.history.slice(-8) : [];
    if(!question) return res.status(400).json({error:"Question is required."});
    if(question.length > 500) return res.status(400).json({error:"Question is too long. Keep it below 500 characters."});

    const dataContext = await loadAssistantContext();
    const aiResult = await askAiProvider(buildAssistantPrompt(user, history, dataContext, question));

    res.json({
      answer: aiResult.answer || "No answer generated.",
      provider: aiResult.provider,
      remaining: limit.remaining
    });
  }catch(error){
    console.error("AI Assistant error", error);
    res.status(500).json({error: error.message || "AI Assistant failed."});
  }
}

app.post("/api/ai-assistant", handleAiAssistant);
app.post("/api/chat-assistant", handleAiAssistant);

const PORT = process.env.PORT || 3000;

app.listen(PORT, ()=>{

  console.log(
    "Server running on port " + PORT
  );
});
