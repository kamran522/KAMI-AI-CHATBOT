"use strict";

const fs = require("node:fs");
const path = require("node:path");
const axios = require("axios");

const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const MAX_HISTORY_MESSAGES = 20;
const DEFAULT_TTS_MODEL = "gemini-3.8-flash-lite-tts";
const MAX_SPOKEN_CHARS = 1100;
const HISTORY_FILE = path.join(__dirname, "chat_history.json");
const PROMPT_FILE = path.join(__dirname, "custom_prompt.txt");
const KEY_FILE = path.join(__dirname, "key.json");

// The distribution packs custom_prompt.txt; legacy unencoded prompts are also accepted.
function loadPrompt() {
  const stored = fs.readFileSync(PROMPT_FILE, "utf8").trim();
  const marker = "KAMI_PROMPT_V1:";
  if (!stored.startsWith(marker)) return stored;
  return require("node:zlib").gunzipSync(Buffer.from(stored.slice(marker.length), "base64")).toString("utf8").trim();
}

function loadApiKey() {
  if (process.env.GEMINI_API_KEY?.trim()) return process.env.GEMINI_API_KEY.trim();
  try {
    const config = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
    const key = config.geminiApiKey || config.gemini_api_key;
    return typeof key === "string" && key.trim() && !key.includes("YOUR_GEMINI") ? key.trim() : "";
  } catch (error) {
    if (error.code !== "ENOENT") console.warn("Could not load key.json:", error.message);
    return "";
  }
}

function readChatHistory() {
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch (error) {
    if (error.code !== "ENOENT") console.warn("Could not load chat history:", error.message);
    return {};
  }
}

const chatHistory = readChatHistory();

function saveChatHistory() {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(chatHistory, null, 2) + "\n", "utf8");
}

// Read normal text, replies, and text captions, including disappearing messages.
// Non-text messages are ignored: the bot only has a text Gemini integration.
function extractIncomingText(message) {
  let content = message;
  for (let depth = 0; depth < 6 && content && typeof content === "object"; depth++) {
    const wrapped =
      content.ephemeralMessage?.message ||
      content.viewOnceMessage?.message ||
      content.viewOnceMessageV2?.message ||
      content.viewOnceMessageV2Extension?.message ||
      content.documentWithCaptionMessage?.message;
    if (!wrapped) break;
    content = wrapped;
  }
  if (!content || typeof content !== "object") return "";
  const options = [
    content.conversation,
    content.extendedTextMessage?.text,
    content.imageMessage?.caption,
    content.videoMessage?.caption,
    content.documentMessage?.caption,
    content.buttonsResponseMessage?.selectedDisplayText,
    content.listResponseMessage?.title,
    content.templateButtonReplyMessage?.selectedDisplayText,
  ];
  return options.find((value) => typeof value === "string" && value.trim())?.trim() || "";
}

async function generateGeminiReply(chatId, userText, { onRetry, voiceReply = false } = {}) {
  const apiKey = loadApiKey();
  if (!apiKey) throw new Error("GEMINI_API_KEY_MISSING");

  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
  const past = Array.isArray(chatHistory[chatId]) ? chatHistory[chatId] : [];
  const contents = [...past, { role: "user", content: userText }]
    .filter((item) => typeof item.content === "string" && ["user", "assistant"].includes(item.role))
    .map((item) => ({
      role: item.role === "assistant" ? "model" : "user",
      parts: [{ text: item.content }],
    }));

  const response = await postGeminiWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      systemInstruction: {
        parts: [{
          text: loadPrompt() + (voiceReply
            ? "\nFor this WhatsApp voice-note reply, answer in the same language as the user. Keep the answer natural, concise and suitable for speaking aloud."
            : ""),
        }],
      },
      contents,
    },
    {
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      timeout: 60000,
    },
    onRetry
  );

  const answer = (response.data?.candidates?.[0]?.content?.parts || [])
    .filter((part) => typeof part.text === "string" && !part.thought)
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (!answer) {
    const cause = response.data?.candidates?.[0]?.finishReason || response.data?.promptFeedback?.blockReason || "No text in candidate";
    throw new Error(`GEMINI_EMPTY_RESPONSE: ${cause}`);
  }

  chatHistory[chatId] = [
    ...past,
    { role: "user", content: userText },
    { role: "assistant", content: answer },
  ].slice(-MAX_HISTORY_MESSAGES);
  saveChatHistory();
  return answer;
}

function getSpeechText(answer) {
  const trimmed = String(answer || "").trim();
  if (!trimmed) throw new Error("VOICE_EMPTY_REPLY");
  return trimmed.length <= MAX_SPOKEN_CHARS
    ? trimmed
    : trimmed.slice(0, MAX_SPOKEN_CHARS).trimEnd() + "...";
}

// Transcribe without changing chat history; the recognized words are later passed
// through the normal Gemini chat flow and stored like any other user message.
async function transcribeVoiceNote(audioBuffer, mimeType, { onRetry } = {}) {
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    throw new Error("VOICE_EMPTY_AUDIO");
  }
  if (audioBuffer.length > 8 * 1024 * 1024) {
    throw new Error("VOICE_TOO_LARGE");
  }
  const apiKey = loadApiKey();
  if (!apiKey) throw new Error("GEMINI_API_KEY_MISSING");
  const model = process.env.GEMINI_AUDIO_MODEL?.trim() || process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
  const response = await postGeminiWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      contents: [{
        role: "user",
        parts: [
          { text: "Transcribe the speech in this voice note exactly in its original language. Return only the spoken words, without timestamps, commentary or translation. If there is no intelligible speech, return NO_SPEECH." },
          { inlineData: { mimeType, data: audioBuffer.toString("base64") } },
        ],
      }],
    },
    {
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      timeout: 90000,
    },
    onRetry
  );
  const transcript = (response.data?.candidates?.[0]?.content?.parts || [])
    .filter((part) => typeof part.text === "string" && !part.thought)
    .map((part) => part.text)
    .join(" ").trim();
  if (!transcript || /^NO_SPEECH[.!\\s]*$/i.test(transcript)) {
    throw new Error("VOICE_NO_SPEECH");
  }
  return transcript;
}

// Gemini 3.8 speech uses the Interactions API; its unary output is a complete
// WAV file, which voice.js converts to the OGG/Opus format required by WhatsApp.
async function synthesizeVoiceReply(answer, { onRetry } = {}) {
  const apiKey = loadApiKey();
  if (!apiKey) throw new Error("GEMINI_API_KEY_MISSING");
  const response = await postGeminiWithRetry(
    "https://generativelanguage.googleapis.com/v1beta/interactions",
    {
      model: process.env.GEMINI_TTS_MODEL?.trim() || DEFAULT_TTS_MODEL,
      input: [{
        type: "user_input",
        content: [{
          type: "text",
          text: getSpeechText(answer),
          annotations: [{ type: "speech_metadata", style: "Natural, clear, conversational" }],
        }],
      }],
      response_format: { type: "audio" },
      generation_config: {
        speech_config: [{ voice: process.env.GEMINI_TTS_VOICE?.trim() || "Kore" }],
      },
    },
    {
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      timeout: 120000,
      maxContentLength: 12 * 1024 * 1024,
    },
    onRetry
  );
  const audioBlock = (response.data?.steps || [])
    .filter((step) => step.type === "model_output")
    .flatMap((step) => step.content || [])
    .filter((part) => part.type === "audio" && typeof part.data === "string")
    .at(-1);
  if (!audioBlock?.data) throw new Error("GEMINI_TTS_EMPTY_RESPONSE");
  const audio = Buffer.from(audioBlock.data, "base64");
  if (!audio.length || audio.length > 8 * 1024 * 1024) {
    throw new Error("VOICE_OUTPUT_TOO_LARGE");
  }
  return audio;
}

function splitReply(answer, limit = 3500) {
  const chunks = [];
  for (let i = 0; i < answer.length; i += limit) chunks.push(answer.slice(i, i + limit));
  return chunks;
}

// Retry only temporary Gemini failures, never configuration or authorization errors.
// Notify WhatsApp on the first transient failure, then retry with bounded backoff.
async function postGeminiWithRetry(url, body, options, onRetry) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await axios.post(url, body, options);
    } catch (error) {
      const status = error.response?.status;
      const transient = status === 408 || status === 429 || (status >= 500 && status <= 599) ||
        ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ECONNABORTED", "EAI_AGAIN", "ENETUNREACH"].includes(error.code);
      if (!transient || attempt >= 2) throw error;

      if (attempt === 0 && typeof onRetry === "function") {
        try {
          await onRetry(error);
        } catch (notificationError) {
          // A WhatsApp send error must not prevent Gemini from being retried.
          console.warn("Unable to send retry notification:", notificationError.message);
        }
      }

      const retryAfterHeader = error.response?.headers?.["retry-after"];
      const retryAfterSeconds = Number(retryAfterHeader);
      const retryAfterMs = typeof retryAfterHeader === "string" && retryAfterHeader.trim() !== "" &&
        Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? Math.min(retryAfterSeconds * 1000, 30000) : 0;
      const delay = Math.max(1000 * (2 ** attempt) + Math.floor(Math.random() * 250), retryAfterMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// For server logs only. Never include the API key or request headers.
function describeGeminiError(error) {
  const status = error.response?.status;
  const code = error.code && /^[A-Z_]+$/.test(error.code) ? ` (${error.code})` : "";
  const upstream = error.response?.data?.error?.message;
  const description = typeof upstream === "string" ? upstream : error.message || "Unknown error";
  const key = loadApiKey();
  let safe = String(description);
  if (key) safe = safe.split(key).join("[REDACTED]");
  safe = safe.replace(/AIza[0-9A-Za-z_-]{20,}/g, "[REDACTED]");
  return `${status ? `HTTP ${status}` : "No HTTP response"}${code}: ${safe.slice(0, 500)}`;
}

function getSafeErrorReply(error) {
  // Every failure gets a useful status; only temporary errors are retried.
  const prefix = "🔄 Updating, please wait...\n";
  if (error.message === "VOICE_TOO_LARGE") return "Voice note is too long or too large. Please send a voice note shorter than 3 minutes and 8 MB.";
  if (error.message === "VOICE_NO_SPEECH" || error.message === "VOICE_EMPTY_AUDIO")
    return "I couldn't understand the voice note. Please record it again.";
  if (error.message === "VOICE_UNSUPPORTED_FORMAT")
    return "This voice-note format is not supported. Please send a normal WhatsApp voice note.";
  if (error.message === "GEMINI_API_KEY_MISSING") {
    return prefix + "Gemini API key is not configured. The bot owner must set GEMINI_API_KEY or key.json.";
  }
  const status = error.response?.status;
  if (status === 400) return prefix + "Gemini rejected the request (HTTP 400). The bot owner should check the server logs.";
  if (status === 401 || status === 403) return prefix + "Gemini API authentication failed. Please contact the bot owner.";
  if (status === 402) return prefix + "Gemini API billing or credits are unavailable. Please contact the bot owner.";
  if (status === 404) return prefix + "Gemini model is not available. The bot owner should verify GEMINI_MODEL.";
  if (status === 429) return prefix + "Gemini is rate-limited. Automatic retries did not succeed. Please try again later.";
  if (status >= 500 && status <= 599) return prefix + "Gemini is temporarily unavailable. Automatic retries did not succeed. Please try again shortly.";
  if (error.message?.startsWith("GEMINI_EMPTY_RESPONSE")) return prefix + "Gemini returned no usable text. Please rephrase and try again.";
  return prefix + "Unable to get a Gemini reply right now. Please try again later.";
}

module.exports = {
  extractIncomingText, generateGeminiReply, splitReply, getSafeErrorReply,
  describeGeminiError, loadApiKey, readChatHistory, transcribeVoiceNote,
  synthesizeVoiceReply, getSpeechText,
};
