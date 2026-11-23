"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { getApiRouteKey } = require("../api-route");
const { loadApiKey } = require("../kami");

function main() {
  const configFile = path.join(__dirname, "..", "key.json");
  console.log("Checking provider configuration in:", path.dirname(configFile));

  if (fs.existsSync(configFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(configFile, "utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid object");
      console.log("key.json: valid JSON");
      console.log("Key fields present: " +
        ["apiRouteApiKey", "apiRouteKey", "api_route_api_key", "geminiApiKey", "gemini_api_key"]
          .filter((key) => typeof data[key] === "string" && Boolean(data[key].trim()))
          .join(", "));
    } catch {
      console.error("key.json: INVALID JSON or structure. Fix its syntax; do not share secrets.");
      process.exitCode = 1;
      return;
    }
  } else {
    console.log("key.json: not found (environment variables are still supported)");
  }

  const apiRoute = Boolean(getApiRouteKey());
  const gemini = Boolean(loadApiKey());
  console.log("API Route: " + (apiRoute ? "CONFIGURED" : "MISSING"));
  console.log("Gemini: " + (gemini ? "CONFIGURED" : "MISSING"));
  console.log("Text provider: " + (apiRoute ? "API Route" : gemini ? "Gemini" : "NONE"));
  console.log("Voice-note provider: " + (gemini ? "Gemini" : "NONE (requires Gemini key)"));

  if (!apiRoute && !gemini) {
    console.error("No text provider is configured. Add API_ROUTE_KEY or apiRouteApiKey to enable API Route.");
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { main };
