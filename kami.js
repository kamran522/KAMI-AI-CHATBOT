"use strict";

const fs = require("node:fs");
const path = require("node:path");
const axios = require("axios");
const https = require("node:https");
const { getGroqApiKey, generateGroqReply, transcribeGroqVoiceNote, describeGroqError } = require("./groq");

const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const MAX_HISTORY_MESSAGES = 20;
const DEFAULT_TTS_MODEL = "gemini-3.8-flash-lite-tts";
const VOICE_HISTORY_MESSAGES = 8;
// Reuse TLS connections across the two Gemini requests on Node.js 18 and later.
const voiceHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 4 });
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
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(chatHistory, null, 2) + "\n", "utf8"); }
  catch (error) { console.warn("Could not save chat history:", error.code || "WRITE_FAILED"); }
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
  const past = Array.isArray(chatHistory[chatId]) ? chatHistory[chatId] : [];
  let answer;
  let groqFailure;
  try {
    answer = await generateGroqReply(userText, past, loadPrompt(), { voiceReply });
  } catch (error) {
    groqFailure = error;
    console.warn("Groq failed; switching to Gemini:", describeGroqError(error));
  }
  if (!answer) {
  try {
  const apiKey = loadApiKey();
  if (!apiKey) throw new Error("GEMINI_API_KEY_MISSING");

  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
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
      timeout: getGroqApiKey()
        ? Math.min(60000, Math.max(3000, Number(process.env.GEMINI_PRIMARY_TIMEOUT_MS) || 12000))
        : 60000,
    },
    onRetry,
    2
  );

  answer = (response.data?.candidates?.[0]?.content?.parts || [])
    .filter((part) => typeof part.text === "string" && !part.thought)
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (!answer) {
    const cause = response.data?.candidates?.[0]?.finishReason || response.data?.promptFeedback?.blockReason || "No text in candidate";
    const error = new Error(`GEMINI_EMPTY_RESPONSE: ${cause}`);
    error.geminiFinishReason = String(cause);
    error.geminiSafetyBlocked = Boolean(response.data?.promptFeedback?.blockReason) ||
      /^(SAFETY|PROHIBITED_CONTENT|BLOCKLIST|SPII)$/.test(String(cause));
    throw error;
  }

  } catch (geminiError) {
    if (getGroqApiKey()) geminiError.groqFailure = groqFailure;
    throw geminiError;
  }
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
  // Speak the complete answer. Do not silently truncate and send the remainder as text.
  return trimmed;
}

/**
 * Low-latency voice mode: one multimodal Gemini request produces both the
 * transcript and its conversational answer. Previously this took two requests.
 * Synthesis remains separate because its output is audio.
 */
async function generateVoiceAnswer(chatId, audioBuffer, mimeType, { onRetry } = {}) {
  if (!Buffer.isBuffer(audioBuffer) || !audioBuffer.length) throw new Error("VOICE_EMPTY_AUDIO");
  if (audioBuffer.length > 8 * 1024 * 1024) throw new Error("VOICE_TOO_LARGE");
  const past = Array.isArray(chatHistory[chatId]) ? chatHistory[chatId] : [];
  let transcript, answer;
  try {
    transcript = await transcribeGroqVoiceNote(audioBuffer, mimeType);
    answer = await generateGroqReply(transcript, past, loadPrompt(), { voiceReply: true });
  } catch (error) {
    console.warn("Groq voice failed; switching to Gemini:", describeGroqError(error));
    try {
      return await generateGeminiVoiceAnswer(chatId, audioBuffer, mimeType, { onRetry });
    } catch (geminiError) {
      if (getGroqApiKey()) geminiError.groqFailure = error;
      throw geminiError;
    }
  }
  chatHistory[chatId] = [...past,
    { role: "user", content: transcript },
    { role: "assistant", content: answer },
  ].slice(-MAX_HISTORY_MESSAGES);
  saveChatHistory();
  return answer;
}

async function generateGeminiVoiceAnswer(chatId, audioBuffer, mimeType, { onRetry } = {}) {
  if (!Buffer.isBuffer(audioBuffer) || !audioBuffer.length) throw new Error("VOICE_EMPTY_AUDIO");
  if (audioBuffer.length > 8 * 1024 * 1024) throw new Error("VOICE_TOO_LARGE");
  const apiKey = loadApiKey();
  if (!apiKey) throw new Error("GEMINI_API_KEY_MISSING");

  const model = process.env.GEMINI_AUDIO_MODEL?.trim() || process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
  const past = Array.isArray(chatHistory[chatId]) ? chatHistory[chatId] : [];
  // A small recent-context window reduces voice request size and processing time.
  const contents = past.slice(-VOICE_HISTORY_MESSAGES)
    .filter((item) => typeof item.content === "string" && ["user", "assistant"].includes(item.role))
    .map((item) => ({
      role: item.role === "assistant" ? "model" : "user",
      parts: [{ text: item.content }],
    }));
  contents.push({
    role: "user",
    parts: [
      {
        text: "Listen to this WhatsApp voice note and respond to the speaker in their original language. "
          + "Return a JSON object with exactly two string fields: transcript (the user's words) "
          + "and answer (a useful, direct reply in one or two short sentences, ideally under 180 characters). "
          + "Return transcript as NO_SPEECH if the audio is not understandable. Do not translate the transcript.",
      },
      { inlineData: { mimeType, data: audioBuffer.toString("base64") } },
    ],
  });

  const response = await postGeminiWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      systemInstruction: {
        parts: [{ text: loadPrompt() + "\nFor a voice reply, be concise and use natural speech." }],
      },
      contents,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            transcript: { type: "STRING" },
            answer: { type: "STRING" },
          },
          required: ["transcript", "answer"],
        },
        maxOutputTokens: 2048,
      },
    },
    {
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      timeout: getGroqApiKey()
        ? Math.min(45000, Math.max(5000, Number(process.env.GEMINI_VOICE_TIMEOUT_MS) || 18000))
        : 45000,
      httpsAgent: voiceHttpsAgent,
    },
    onRetry,
    2
  );
  const finishReason = response.data?.candidates?.[0]?.finishReason;
  if (finishReason === "MAX_TOKENS") throw new Error("VOICE_INCOMPLETE_RESPONSE");
  const raw = (response.data?.candidates?.[0]?.content?.parts || [])
    .filter((p) => typeof p.text === "string" && !p.thought)
    .map((p) => p.text).join("").trim();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("VOICE_INVALID_RESPONSE");
  }
  const transcript = typeof parsed?.transcript === "string" ? parsed.transcript.trim() : "";
  const answer = typeof parsed?.answer === "string" ? parsed.answer.trim() : "";
  if (!transcript || /^NO_SPEECH[.!\s]*$/i.test(transcript)) throw new Error("VOICE_NO_SPEECH");
  if (!answer) throw new Error("VOICE_INVALID_RESPONSE");

  chatHistory[chatId] = [
    ...past,
    { role: "user", content: transcript },
    { role: "assistant", content: answer },
  ].slice(-MAX_HISTORY_MESSAGES);
  saveChatHistory();
  return answer;
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
  if (!transcript || /^NO_SPEECH[.!\s]*$/i.test(transcript)) {
    throw new Error("VOICE_NO_SPEECH");
  }
  return transcript;
}

// Gemini 3.8 speech uses the Interactions API; unary requests return complete WAV.
// REST responses expose the audio in steps[].content[].data. Some SDK-compatible
// response shapes use output_audio.data instead; accept both without decoding twice.
function extractTtsWav(data) {
  const stepAudio = (data?.steps || [])
    .filter((step) => step.type === "model_output")
    .flatMap((step) => step.content || [])
    .filter((part) => part.type === "audio" && typeof part.data === "string")
    .at(-1);
  const encoded = stepAudio?.data || data?.output_audio?.data || data?.outputAudio?.data;
  if (typeof encoded !== "string" || !encoded) throw new Error("GEMINI_TTS_EMPTY_RESPONSE");
  const audio = Buffer.from(encoded, "base64");
  if (audio.length > 8 * 1024 * 1024) throw new Error("VOICE_OUTPUT_TOO_LARGE");
  if (audio.length < 44 || audio.toString("ascii", 0, 4) !== "RIFF" ||
      audio.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("GEMINI_TTS_INVALID_AUDIO");
  }
  return audio;
}
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
        speech_config: [{ voice: process.env.GEMINI_TTS_VOICE?.trim() || "Charon" }],
      },
    },
    {
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      // Do not allow two more long retries on speech synthesis: prefer a fast text fallback.
      timeout: Math.min(60000, Math.max(3000, Number(process.env.VOICE_TTS_TIMEOUT_MS) || 25000)),
      maxContentLength: 12 * 1024 * 1024,
      httpsAgent: voiceHttpsAgent,
    },
    onRetry,
    0
  );
  return extractTtsWav(response.data);
}

function splitReply(answer, limit = 3500) {
  const chunks = [];
  for (let i = 0; i < answer.length; i += limit) chunks.push(answer.slice(i, i + limit));
  return chunks;
}

// Retry only temporary Gemini failures, never configuration or authorization errors.
// Notify WhatsApp on the first transient failure, then retry with bounded backoff.
async function postGeminiWithRetry(url, body, options, onRetry, maxRetries = 2) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await axios.post(url, body, options);
    } catch (error) {
      const status = error.response?.status;
      const transient = status === 408 || status === 429 || (status >= 500 && status <= 599) ||
        ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ECONNABORTED", "EAI_AGAIN", "ENETUNREACH"].includes(error.code);
      if (!transient || attempt >= maxRetries) throw error;

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
  const groqKey = getGroqApiKey();
  let safe = String(description);
  if (key) safe = safe.split(key).join("[REDACTED]");
  if (groqKey) safe = safe.split(groqKey).join("[REDACTED]");
  safe = safe.replace(/\bgsk_[A-Za-z0-9_-]{12,}/g, "[REDACTED]");
  safe = safe.replace(/AIza[0-9A-Za-z_-]{20,}/g, "[REDACTED]");
  return `${status ? `HTTP ${status}` : "No HTTP response"}${code}: ${safe.slice(0, 500)}`;
}

function getSafeErrorReply(error) {
  // Every failure gets a useful status; only temporary errors are retried.
  const prefix = "🔄 Updating, please wait...\n";
  if (error.groqFailure) {
    if (error.message === "VOICE_NO_SPEECH") return "I couldn’t understand the voice note. Please record it again.";
    return prefix + "Both Groq and Gemini failed to provide a reply. Please try again later.";
  }
  if (error.groqFallback) {
    const status = error.response?.status;
    if (status === 401 || status === 403) return prefix + "Gemini did not respond and the Groq API key was rejected. Contact the bot owner.";
    if (status === 429) return prefix + "Gemini did not respond and Groq reached its rate limit. Please try again later.";
    return prefix + "Both Gemini and Groq are unavailable right now. Please try again later.";
  }
  if (error.message === "VOICE_TOO_LARGE") return "Voice note is too long or too large. Please send a voice note shorter than 3 minutes and 8 MB.";
  if (error.message === "VOICE_INVALID_RESPONSE") return "I could not process that voice note. Please try again.";
  if (error.message === "VOICE_NO_SPEECH" || error.message === "VOICE_EMPTY_AUDIO")
    return "I couldn't understand the voice note. Please record it again.";
  if (error.message === "VOICE_UNSUPPORTED_FORMAT")
    return "This voice-note format is not supported. Please send a normal WhatsApp voice note.";
  if (error.message === "GEMINI_API_KEY_MISSING") {
    return prefix + "Gemini API key is not configured. Set GEMINI_API_KEY or geminiApiKey in key.json.";
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
  synthesizeVoiceReply, getSpeechText, generateVoiceAnswer, extractTtsWav,
};
