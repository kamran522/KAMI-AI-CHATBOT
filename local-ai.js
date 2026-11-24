"use strict";

// Completely local Ollama client. Fixed loopback host prevents external API calls.
const OLLAMA_URL = "http://127.0.0.1:11434/api/chat";
const DEFAULT_MODEL = "qwen3:4b";
function isEnabled() { return process.env.LOCAL_TEXT_ENABLED === "1"; }
function modelName() { return process.env.LOCAL_AI_MODEL?.trim() || DEFAULT_MODEL; }

function voiceInstruction(language, isVoice) {
  const directive = {
    balochi: "Answer in Southern/Makrani Balochi in Arabic/Perso-Arabic script, not Urdu. Use simple, natural Balochi wording. If unsure about the correct translation, say so.",
    urdu: "Answer in Urdu, written in Urdu Arabic script. Do not translate into English.",
    english: "Answer in English.",
    auto: "Reply in the same language as the user's message, using its natural writing script.",
  }[language] || "Reply in the same language as the user.";
  return "\n" + directive + (isVoice ?
    "\nFor speech, answer in one or two short sentences without Markdown or formatting." : "");
}
async function generateOllamaAnswer(text, history = [], systemPrompt = "", {
  language = "auto", voiceReply = false,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("LOCAL_OLLAMA_UNAVAILABLE");
  const messages = [{
    role: "system",
    content: String(systemPrompt) + voiceInstruction(language, voiceReply),
  }, ...history.filter((x) => typeof x.content === "string" &&
    ["user", "assistant"].includes(x.role))
    .slice(-10).map(({ role, content }) => ({ role, content })),
  { role: "user", content: String(text).slice(0, 3000) }];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(),
    Math.min(180000, Math.max(10000, Number(process.env.LOCAL_AI_TIMEOUT_MS) || 90000)));
  try {
    const response = await fetchImpl(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelName(), messages, stream: false, think: false,
        options: {
          num_ctx: 2048, num_predict: voiceReply ? 120 : 256, num_thread: 4,
          temperature: 0.6,
        },
        keep_alive: "5m",
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("LOCAL_OLLAMA_HTTP_" + response.status);
    const data = await response.json();
    let answer = typeof data?.message?.content === "string" ? data.message.content.trim() : "";
    // Defensive only: Ollama supports think:false, but older templates may echo tags.
    answer = answer.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    if (!answer) throw new Error("LOCAL_OLLAMA_EMPTY_RESPONSE");
    return answer;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("LOCAL_OLLAMA_TIMEOUT");
    if (error instanceof TypeError) throw new Error("LOCAL_OLLAMA_UNAVAILABLE");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
function safeLocalAiError(error) {
  return /^LOCAL_OLLAMA_(?:HTTP_\d{3}|UNAVAILABLE|TIMEOUT|EMPTY_RESPONSE)$/.test(error?.message || "")
    ? error.message : "LOCAL_OLLAMA_UNAVAILABLE";
}
module.exports = {
  OLLAMA_URL, DEFAULT_MODEL, modelName, isEnabled, voiceInstruction,
  generateOllamaAnswer, safeLocalAiError,
};