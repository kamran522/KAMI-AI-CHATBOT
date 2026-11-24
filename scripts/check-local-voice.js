"use strict";
const fs = require("node:fs");
const { assets } = require("../local-voice");
const { modelName } = require("../local-ai");

async function check() {
  const a = assets();
  const required = [
    ["whisper.cpp executable", a.whisperBinary],
    ["Whisper small multilingual model", a.whisperModel],
    ["Piper executable", a.piperBinary],
    ["English voice model", a.piperEnglish],
    ["English voice config", a.piperEnglish + ".json"],
    ["Urdu voice model", a.piperUrdu],
    ["Urdu voice config", a.piperUrdu + ".json"],
  ];
  let passed = true;
  for (const [label, filename] of required) {
    const found = fs.existsSync(filename);
    console.log((found ? "READY  " : "MISSING") + " " + label);
    if (!found) passed = false;
  }
  if (process.argv.includes("--balochi")) {
    for (const [label, filename] of [
      ["Balochi Python environment", a.python],
      ["Balochi Whisper fine-tune", a.balochiStt],
      ["Balochi MMS speech model", a.balochiTts],
    ]) {
      const found = fs.existsSync(filename);
      console.log((found ? "READY  " : "MISSING") + " " + label);
      if (!found) passed = false;
    }
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    let response;
    try { response = await fetch("http://127.0.0.1:11434/api/tags", { signal: controller.signal }); }
    finally { clearTimeout(timer); }
    if (!response.ok) throw new Error("OLLAMA_HTTP_" + response.status);
    const list = await response.json();
    const model = modelName();
    const installed = Array.isArray(list.models) && list.models.some((x) =>
      x.name === model || x.model === model);
    console.log((installed ? "READY  " : "MISSING") + " Ollama model " + model);
    if (!installed) passed = false;
  } catch {
    console.log("MISSING Ollama server on 127.0.0.1:11434");
    passed = false;
  }
  console.log(passed ? "LOCAL VOICE DEPENDENCIES READY" :
    "LOCAL VOICE NOT READY: see scripts/setup-local-voice.sh and install Ollama.");
  // Static checks cannot prove accuracy of voice recognition or speech synthesis.
  console.log("This checks locally installed assets only, not voice quality.");
  if (!passed) process.exitCode = 1;
}
if (require.main === module) check().catch(() => { process.exitCode = 1; });
module.exports = { check };
