"use strict";

const { getApiRouteKey, listAvailableModels, resolveChatModel, safeApiRouteError } = require("../api-route");

async function main() {
  if (!getApiRouteKey()) {
    console.error("API Route key is missing. Set API_ROUTE_KEY or add apiRouteApiKey to private key.json.");
    process.exitCode = 1;
    return;
  }
  try {
    const models = await listAvailableModels({ force: true });
    const chat = models.filter((model) => model.chat);
    const other = models.filter((model) => !model.chat);
    console.log(`API Route key accepted. ${models.length} visible models: ${chat.length} chat candidates, ${other.length} non-chat.`);
    for (const model of models) console.log(model.id + (model.chat ? "" : " [non-chat]"));
    if (chat.length) console.log("Default chat model:", await resolveChatModel("diagnostics@local"));
    console.log("Model listing does not guarantee every model is enabled for every endpoint or has sufficient credits.");
  } catch (error) {
    console.error("API Route check failed:", safeApiRouteError(error));
    process.exitCode = 1;
  }
}

if (require.main === module) main().catch(() => {
  console.error("API Route check failed.");
  process.exitCode = 1;
});

module.exports = { main };
