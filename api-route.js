"use strict";

const fs = require("node:fs");
const path = require("node:path");
const axios = require("axios");

// Fixed HTTPS origin prevents leaking private keys to arbitrary custom servers.
const BASE_URL = "https://global.api-route.com/v1";
const KEY_FILE = path.join(__dirname, "key.json");
const SELECTIONS_FILE = path.join(__dirname, "api_route_models.json");
const CACHE_MS = 5 * 60 * 1000;
const PAGE_SIZE = 20;
let modelCache = { key: null, until: 0, models: [], pending: null };

function getApiRouteKey() {
  const fromEnv = process.env.API_ROUTE_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const config = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
    const key = config.apiRouteApiKey || config.apiRouteKey || config.api_route_api_key;
    return typeof key === "string" && key.trim() && !key.includes("YOUR_") ? key.trim() : "";
  } catch (error) {
    if (error.code !== "ENOENT") console.warn("Unable to read API Route key configuration:", error.code || "invalid file");
    return "";
  }
}

function isChatModel(model) {
  const id = String(model?.id || "").toLowerCase();
  const endpointNames = Array.isArray(model?.supported_endpoints) ? model.supported_endpoints.map(String) : [];
  // The account's model list may include image, video, audio and embedding models.
  // Chat Completions does not support every such model.
  if (endpointNames.length && endpointNames.every((name) =>
      /image-generation|video-generation|embedding|text-to-speech|audio-generation/i.test(name))) return false;
  return !/(^|[-_/])(image|imagen|tts|embedding|embed|video|veo|sora)([-_/]|$)/i.test(id);
}

function validateModels(body) {
  if (!Array.isArray(body?.data)) throw new Error("API_ROUTE_BAD_MODEL_LIST");
  const found = new Set();
  const models = [];
  for (const raw of body.data) {
    const id = raw?.id;
    if (typeof id !== "string" || id.length > 180 || !/^[\w.:\-\/]+$/.test(id) || found.has(id)) continue;
    found.add(id);
    models.push({ id, chat: isChatModel(raw) });
    if (models.length >= 1000) break;
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

async function listAvailableModels({ force = false } = {}) {
  const key = getApiRouteKey();
  if (!key) throw new Error("API_ROUTE_KEY_MISSING");
  const now = Date.now();
  if (!force && modelCache.key === key && now < modelCache.until) return modelCache.models;
  if (!force && modelCache.key === key && modelCache.pending) return modelCache.pending;
  const pending = (async () => {
    try {
      const res = await axios.get(BASE_URL + "/models", {
        headers: { Authorization: "Bearer " + key },
        timeout: 15000,
        maxContentLength: 1024 * 1024,
      });
      const models = validateModels(res.data);
      if (!models.length) throw new Error("API_ROUTE_NO_MODELS");
      if (modelCache.key === key) {
        modelCache.models = models;
        modelCache.until = Date.now() + CACHE_MS;
      }
      return models;
    } catch (error) {
      error.apiRoute = true;
      throw error;
    } finally {
      if (modelCache.key === key) modelCache.pending = null;
    }
  })();
  modelCache = { key, until: 0, models: [], pending };
  return pending;
}

// Model preferences are per-chat, not global, and survive normal PM2 restarts.
// Never store API keys in this file.
function readSelections() {
  try {
    const data = JSON.parse(fs.readFileSync(SELECTIONS_FILE, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}
const selections = readSelections();

function saveSelections() {
  const temp = SELECTIONS_FILE + ".tmp-" + process.pid;
  try {
    fs.writeFileSync(temp, JSON.stringify(selections, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temp, SELECTIONS_FILE);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

async function resolveChatModel(chatId) {
  const models = await listAvailableModels();
  const configured = selections[chatId] || process.env.API_ROUTE_MODEL?.trim();
  if (configured) {
    const match = models.find((m) => m.id === configured && m.chat);
    if (!match) throw new Error("API_ROUTE_MODEL_UNAVAILABLE");
    return match.id;
  }
  const chatModels = models.filter((m) => m.chat);
  if (!chatModels.length) throw new Error("API_ROUTE_NO_CHAT_MODELS");
  // Prefer a lower-latency Gemini Flash model when one is permitted by the key.
  return (chatModels.find((m) => /gemini.*flash/i.test(m.id)) ||
    chatModels.find((m) => /flash|mini|lite/i.test(m.id)) || chatModels[0]).id;
}

async function runModelCommand(chatId, text) {
  if (!/^\/models?(?:\s|$)/i.test(text)) return null;
  if (!getApiRouteKey()) return "API Route is not configured. Add apiRouteApiKey to key.json or set API_ROUTE_KEY on the server.";
  try {
    const models = await listAvailableModels();
    const match = text.match(/^\/(models|model)(?:\s+(.+))?$/i);
    if (!match) return "Use /models, /models 2, /model, /model MODEL_ID or /model reset.";
    const command = match[1].toLowerCase();
    const argument = match[2]?.trim();

    if (command === "models") {
      const page = argument ? Number(argument) : 1;
      if (!Number.isInteger(page) || page < 1 || page > Math.ceil(models.length / PAGE_SIZE))
        return "Invalid page. Use /models 1 through /models " + Math.ceil(models.length / PAGE_SIZE) + ".";
      const start = (page - 1) * PAGE_SIZE;
      const lines = models.slice(start, start + PAGE_SIZE)
        .map((m, i) => (start + i + 1) + ". " + m.id + (m.chat ? "" : " [non-chat]"));
      return "API Route models (" + models.length + "; page " + page + "/" +
        Math.ceil(models.length / PAGE_SIZE) + ")\n" + lines.join("\n") +
        "\nUse /model MODEL_ID to select a chat model. [non-chat] models need a different API endpoint.";
    }
    if (!argument) {
      const model = await resolveChatModel(chatId);
      return "Current API Route chat model: " + model +
        "\nUse /models to list available models, /model MODEL_ID to switch, or /model reset.";
    }
    if (argument.toLowerCase() === "reset") {
      delete selections[chatId];
      saveSelections();
      return "Model preference cleared. Default chat model: " + await resolveChatModel(chatId);
    }
    const model = models.find((m) => m.id === argument);
    if (!model) return "That model is not listed for this API key. Send /models to see available models.";
    if (!model.chat) return "This model does not support regular chat completions. Choose a chat model from /models.";
    selections[chatId] = model.id;
    saveSelections();
    return "API Route model for this chat: " + model.id;
  } catch (error) {
    return safeApiRouteError(error);
  }
}

function safeApiRouteError(error) {
  const code = error?.response?.status;
  if (error?.message === "API_ROUTE_KEY_MISSING") return "API Route key is missing on the server.";
  if (error?.message === "API_ROUTE_MODEL_UNAVAILABLE") return "The configured API Route model is not available to this key. Use /models or change API_ROUTE_MODEL.";
  if (error?.message === "API_ROUTE_NO_CHAT_MODELS") return "This key has no models confirmed for chat completions. Check its allowed groups.";
  if (code === 401 || code === 403) return "API Route denied access. Check the API key and its enabled model groups.";
  if (code === 404) return "The selected API Route model or endpoint is unavailable.";
  if (code === 429) return "API Route is rate-limited or out of quota. Please try again later.";
  if (code >= 500) return "API Route is temporarily unavailable. Please try again shortly.";
  return "Unable to reach API Route right now. Check server logs and network settings.";
}

module.exports = {
  BASE_URL, getApiRouteKey, listAvailableModels, resolveChatModel,
  runModelCommand, safeApiRouteError, validateModels, isChatModel,
};