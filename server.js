const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

app.use(express.json({ limit: "25mb" }));

const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-secret";
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || "jaingarvit31@gmail.com").toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes("sslmode=disable") ? false : { rejectUnauthorized: false }
    })
  : null;

const ALLOWED_TABLES = new Set([
  "profiles",
  "colors",
  "recipes",
  "programs",
  "audit_logs",
  "recipe_versions",
  "process_houses",
  "chemical_stock_purchases",
  "chemical_stock_ledger",
  "program_stock_usage",
  "price_change_logs"
]);

function jsonError(res, status, message) {
  res.status(status).json({ error: message });
}

function requireDatabase(res) {
  if (!pool) {
    jsonError(res, 500, "Neon DATABASE_URL is missing on the server.");
    return false;
  }
  return true;
}

function makePasswordHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const iterations = 120000;
  const hash = crypto.pbkdf2Sync(String(password), salt, iterations, 32, "sha256").toString("hex");
  return `pbkdf2_sha256$${iterations}$${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
  const parts = String(storedHash || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2_sha256") return false;
  const iterations = Number(parts[1]);
  const salt = parts[2];
  const expected = parts[3];
  const actual = crypto.pbkdf2Sync(String(password), salt, iterations, 32, "sha256").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function signToken(user) {
  const payload = {
    id: user.id,
    email: user.email,
    role: user.role,
    exp: Date.now() + 5 * 60 * 1000
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifyToken(token) {
  if (!token || !token.includes(".")) return null;
  const [body, signature] = token.split(".");
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (Date.now() > Number(payload.exp || 0)) return null;
  return payload;
}

function getAuthUser(req) {
  const header = String(req.headers.authorization || "");
  return verifyToken(header.replace(/^Bearer\s+/i, ""));
}

function requireUser(req, res) {
  const user = getAuthUser(req);
  if (!user) {
    jsonError(res, 401, "Login required.");
    return null;
  }
  return user;
}

function requireAdmin(req, res) {
  const user = requireUser(req, res);
  if (!user) return null;
  if (user.role !== "admin") {
    jsonError(res, 403, "Admin access required.");
    return null;
  }
  return user;
}

function safeTable(table) {
  if (!ALLOWED_TABLES.has(table)) throw new Error("Table not allowed.");
  return table;
}

function buildWhere(filters, startIndex = 1) {
  const values = [];
  const clauses = [];
  (filters || []).forEach(filter => {
    const column = String(filter.column || "").replace(/[^a-zA-Z0-9_]/g, "");
    if (!column) return;
    values.push(filter.value);
    clauses.push(`${column} = $${startIndex + values.length - 1}`);
  });
  return {
    sql: clauses.length ? ` where ${clauses.join(" and ")}` : "",
    values
  };
}

function sanitizeOrder(order) {
  if (!order || !order.column) return "";
  const column = String(order.column).replace(/[^a-zA-Z0-9_]/g, "");
  if (!column) return "";
  return ` order by ${column} ${order.ascending === false ? "desc" : "asc"}`;
}

function normalizeRowsForClient(rows) {
  return rows || [];
}

async function ensureAuthTables() {
  await pool.query(`
    create table if not exists app_users (
      id text primary key,
      email text not null unique,
      password_hash text not null,
      role text not null default 'viewer' check (role in ('admin', 'viewer')),
      created_at timestamptz not null default now()
    )
  `);
  await pool.query(`
    create table if not exists profiles (
      id text primary key,
      email text not null default '',
      role text not null default 'viewer' check (role in ('admin', 'viewer'))
    )
  `);
}

async function healthHandler(req, res) {
  const neon = Boolean(pool);
  res.json({
    ok: true,
    message: "API working",
    database: neon ? "neon" : "not configured"
  });
}

app.get("/api/health", healthHandler);

app.get("/api/setup/check", async (req, res) => {
  if (!requireDatabase(res)) return;
  try {
    await pool.query("select 1");
    const tables = await pool.query(
      "select table_name from information_schema.tables where table_schema='public' order by table_name"
    );
    res.json({
      ok: true,
      database: "neon",
      tables: tables.rows.map(row => row.table_name)
    });
  } catch (error) {
    console.error("Neon setup check failed", error);
    jsonError(res, 500, error.message);
  }
});

async function loginHandler(req, res) {
  if (!requireDatabase(res)) return;
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!email || !password) return jsonError(res, 400, "Email and password required.");

  try {
    await ensureAuthTables();
    let result = await pool.query("select id,email,password_hash,role from app_users where lower(email)=lower($1) limit 1", [email]);
    if (!result.rows.length && ADMIN_PASSWORD && email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
      const id = crypto.randomUUID();
      const hash = makePasswordHash(password);
      result = await pool.query(
        "insert into app_users (id,email,password_hash,role) values ($1,$2,$3,'admin') returning id,email,password_hash,role",
        [id, email, hash]
      );
      await pool.query(
        "insert into profiles (id,email,role) values ($1,$2,'admin') on conflict (id) do update set email=excluded.email, role=excluded.role",
        [id, email]
      );
    }

    const user = result.rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      return jsonError(res, 401, "Wrong email or password.");
    }

    const safeUser = { id: user.id, email: user.email, role: user.role || "viewer" };
    res.json({
      user: safeUser,
      session: {
        access_token: signToken(safeUser)
      }
    });
  } catch (error) {
    console.error("Neon login failed", error);
    jsonError(res, 500, error.message);
  }
}

app.post("/api/auth/login", loginHandler);

function logoutHandler(req, res) {
  res.json({ ok: true });
}

app.post("/api/auth/logout", logoutHandler);

async function dbHandler(req, res) {
  if (!requireDatabase(res)) return;
  const action = req.params?.action || req.query?.action;
  const tableName = req.params?.table || req.query?.table;
  if (!["select", "insert", "update", "delete"].includes(action)) {
    return jsonError(res, 404, "Database action not found.");
  }

  if (action === "select") {
    const user = requireUser(req, res);
    if (!user) return;

    try {
      const table = safeTable(tableName);
      const where = buildWhere(req.body.filters || []);
      const order = sanitizeOrder(req.body.order);
      const limit = Number(req.body.limit || 0);
      const limitSql = limit > 0 ? ` limit ${Math.min(limit, 5000)}` : "";
      const result = await pool.query(`select * from ${table}${where.sql}${order}${limitSql}`, where.values);
      return res.json({ data: normalizeRowsForClient(result.rows) });
    } catch (error) {
      console.error("Neon select failed", error);
      return jsonError(res, 500, error.message);
    }
  }

  const user = requireAdmin(req, res);
  if (!user) return;

  try {
    const table = safeTable(tableName);

    if (action === "insert") {
      const rows = Array.isArray(req.body.rows) ? req.body.rows : [req.body.row || {}];
      if (!rows.length) return res.json({ data: [] });
      const inserted = [];

      for (const row of rows) {
        const clean = { ...row };
        const columns = Object.keys(clean).filter(Boolean);
        const values = columns.map(column => clean[column]);
        const placeholders = columns.map((_, index) => `$${index + 1}`).join(",");
        const sql = `insert into ${table} (${columns.join(",")}) values (${placeholders}) returning *`;
        const result = await pool.query(sql, values);
        inserted.push(result.rows[0]);
      }

      return res.json({ data: inserted });
    }

    if (action === "update") {
      const row = req.body.row || {};
      const columns = Object.keys(row).filter(Boolean);
      if (!columns.length) return res.json({ data: [] });
      const values = columns.map(column => row[column]);
      const setSql = columns.map((column, index) => `${column} = $${index + 1}`).join(",");
      const where = buildWhere(req.body.filters || [], values.length + 1);
      const result = await pool.query(`update ${table} set ${setSql}${where.sql} returning *`, [...values, ...where.values]);
      return res.json({ data: result.rows });
    }

    if (action === "delete") {
      const where = buildWhere(req.body.filters || []);
      if (!where.sql) return jsonError(res, 400, "Delete filter required.");
      const result = await pool.query(`delete from ${table}${where.sql} returning *`, where.values);
      return res.json({ data: result.rows });
    }

    return jsonError(res, 404, "Database action not found.");
  } catch (error) {
    console.error("Neon " + action + " failed", error);
    return jsonError(res, 500, error.message);
  }
}

app.post("/api/db/:table/:action", dbHandler);

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

app.use("/api", (req, res) => {
  res.status(404).json({
    error: "API route not found."
  });
});

const PORT = process.env.PORT || 3000;

async function setupCheckHandler(req, res) {
  if (!requireDatabase(res)) return;
  try {
    await pool.query("select 1");
    const tables = await pool.query(
      "select table_name from information_schema.tables where table_schema='public' order by table_name"
    );
    res.json({
      ok: true,
      database: "neon",
      tables: tables.rows.map(row => row.table_name)
    });
  } catch (error) {
    console.error("Neon setup check failed", error);
    jsonError(res, 500, error.message);
  }
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log("Server running on port " + PORT);
  });
}

module.exports = app;
module.exports.healthHandler = healthHandler;
module.exports.loginHandler = loginHandler;
module.exports.logoutHandler = logoutHandler;
module.exports.setupCheckHandler = setupCheckHandler;
module.exports.dbHandler = dbHandler;
