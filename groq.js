"use strict";

const fs = require("node:fs");
const path = require("node:path");
const axios = require("axios");

// Fixed HTTPS origin: never send an API key to a user-supplied host.
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const KEY_FILE = path.join(__dirname, "key.json");
const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile";
const DEFAULT_TRANSCRIPTION_MODEL = "whisper-large-v3-turbo";
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

function getGroqApiKey() {
  const env = process.env.GROQ_API_KEY?.trim();
  if (env && !env.startsWith("YOUR_")) return env;
  try {
    const config = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
    const key = config.groqApiKey || config.groq_api_key;
    return typeof key === "string" && key.trim() && !key.startsWith("YOUR_") ? key.trim() : "";
  } catch {
    return "";
  }
}

function groqError(error) {
  // Mark errors so the WhatsApp client knows both providers were attempted.
  error.groqFallback = true;
  return error;
}

async function generateGroqReply(text, history = [], prompt = "", {
  voiceReply = false,
  post = axios.post,
} = {}) {
  const key = getGroqApiKey();
  if (!key) throw groqError(new Error("GROQ_API_KEY_MISSING"));
  const model = process.env.GROQ_MODEL?.trim() || DEFAULT_GROQ_MODEL;
  const messages = [
    { role: "system", content: String(prompt) +
      (voiceReply ? "\nReply in the same language as the speaker. Be short, natural, and suitable for spoken audio." : "") },
    ...history.filter((item) => typeof item?.content === "string" &&
      ["user", "assistant"].includes(item.role))
      .slice(-20).map(({ role, content }) => ({ role, content })),
    { role: "user", content: String(text) },
  ];
  try {
    const response = await post(GROQ_BASE_URL + "/chat/completions", {
      model, messages, max_completion_tokens: voiceReply ? 220 : 700,
    }, {
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      timeout: Math.min(60000, Math.max(3000, Number(process.env.GROQ_TIMEOUT_MS) || 18000)),
    });
    const answer = response.data?.choices?.[0]?.message?.content;
    if (typeof answer !== "string" || !answer.trim()) throw new Error("GROQ_EMPTY_RESPONSE");
    return answer.trim();
  } catch (error) {
    throw groqError(error);
  }
}

function isGeminiSafetyBlock(error) {
  if (error?.geminiSafetyBlocked) return true;
  return /(?:SAFETY|PROHIBITED_CONTENT|BLOCKLIST|SPII)/i.test(error?.geminiFinishReason || "");
}
function shouldFallbackToGroq(error) {
  if (!getGroqApiKey() || isGeminiSafetyBlock(error)) return false;
  // User input errors should not be re-sent to another provider.
  if (["VOICE_TOO_LARGE", "VOICE_EMPTY_AUDIO", "VOICE_NO_SPEECH", "VOICE_UNSUPPORTED_FORMAT"].includes(error?.message)) return false;
  return true;
}

async function transcribeGroqVoiceNote(audioBuffer, mimeType, {
  fetchImpl = globalThis.fetch,
} = {}) {
  const key = getGroqApiKey();
  if (!key) throw groqError(new Error("GROQ_API_KEY_MISSING"));
  if (!Buffer.isBuffer(audioBuffer) || !audioBuffer.length) throw groqError(new Error("VOICE_EMPTY_AUDIO"));
  if (audioBuffer.length > MAX_AUDIO_BYTES) throw groqError(new Error("VOICE_TOO_LARGE"));
  const extension = String(mimeType || "").includes("ogg") ? "ogg" :
    String(mimeType || "").includes("webm") ? "webm" :
    String(mimeType || "").includes("m4a") ? "m4a" : "wav";
  const form = new FormData();
  form.append("file", new Blob([audioBuffer], { type: mimeType || "audio/ogg" }), "voice." + extension);
  form.append("model", process.env.GROQ_TRANSCRIPTION_MODEL?.trim() || DEFAULT_TRANSCRIPTION_MODEL);
  form.append("response_format", "json");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetchImpl(GROQ_BASE_URL + "/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: "Bearer " + key },
      body: form,
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = new Error("GROQ_TRANSCRIPTION_FAILED");
      error.response = { status: response.status };
      throw error;
    }
    const result = await response.json();
    const transcript = typeof result.text === "string" ? result.text.trim() : "";
    if (!transcript) throw new Error("VOICE_NO_SPEECH");
    return transcript;
  } catch (error) {
    throw groqError(error);
  } finally {
    clearTimeout(timeout);
  }
}

function describeGroqError(error) {
  const status = error?.response?.status;
  const key = getGroqApiKey();
  const raw = String(error?.response?.data?.error?.message || error?.message || "Unknown error");
  let clean = key ? raw.split(key).join("[REDACTED]") : raw;
  clean = clean.replace(/\bgsk_[A-Za-z0-9_-]{12,}/g, "[REDACTED]");
  return (status ? "HTTP " + status + ": " : "") + clean.slice(0, 240);
}

module.exports = {
  GROQ_BASE_URL, getGroqApiKey, generateGroqReply,
  transcribeGroqVoiceNote, shouldFallbackToGroq, describeGroqError,
};