const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.json());

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
    error: "API route not found. Please deploy the latest server commit on Render."
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, ()=>{

  console.log(
    "Server running on port " + PORT
  );
});
