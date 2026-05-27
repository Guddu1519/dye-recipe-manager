const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.json());

const DATA_FILE = path.join(__dirname, "data.json");

app.use(express.static(__dirname));

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

const PORT = process.env.PORT || 3000;

app.listen(PORT, ()=>{

  console.log(
    "Server running on port " + PORT
  );
});