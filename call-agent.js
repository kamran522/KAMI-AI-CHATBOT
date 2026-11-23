"use strict";

const { loadApiKey } = require("./kami");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

// Read the existing bot personality without saving a separate caller profile.
function loadCallPrompt() {
  const raw = fs.readFileSync(path.join(__dirname, "custom_prompt.txt"), "utf8").trim();
  if (!raw.startsWith("KAMI_PROMPT_V1:")) return raw;
  return zlib.gunzipSync(Buffer.from(raw.slice("KAMI_PROMPT_V1:".length), "base64")).toString("utf8").trim();
}

function getCallModel() {
  return process.env.GEMINI_CALL_MODEL?.trim() || process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash-lite";
}

function parseSseEvent(event) {
  const data = event.split("\n").filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart()).join("\n");
  if (!data || data === "[DONE]") return "";
  const payload = JSON.parse(data);
  const parts = payload.candidates?.[0]?.content?.parts || [];
  return parts.filter((part) => typeof part.text === "string" && !part.thought)
    .map((part) => part.text).join("");
}

// Stream short Gemini text fragments directly to the speech relay. No slow
// Gemini transcription or Gemini TTS calls are needed during live calls.
async function* streamCallAnswer(history, { signal, fetchImpl = globalThis.fetch } = {}) {
  const apiKey = loadApiKey();
  if (!apiKey) throw new Error("GEMINI_API_KEY_MISSING");
  const contents = history.slice(-12).map(({ role, content }) => ({
    role: role === "assistant" ? "model" : "user",
    parts: [{ text: String(content).slice(0, 1200) }],
  }));
  const model = getCallModel();
  const response = await fetchImpl(
    "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":streamGenerateContent?alt=sse",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{
            text: loadCallPrompt().slice(0, 2500) +
              "\nYou are KAMI AI speaking on a live voice call. Answer directly and naturally. " +
              "Speak in short sentences, ideally under 70 words. Do not use markdown. " +
              "Tell users clearly that you are an AI assistant; do not pretend to be human.",
          }],
        },
        contents,
        generationConfig: { maxOutputTokens: 200, temperature: 0.5 },
      }),
      signal,
    }
  );
  if (!response.ok) {
    const error = new Error("Gemini live-call request failed");
    error.status = response.status;
    throw error;
  }
  if (!response.body) throw new Error("No Gemini streaming response");

  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    if (pending.length > 250000) throw new Error("Gemini stream exceeded safe size");
    let boundary;
    while ((boundary = pending.indexOf("\n\n")) >= 0) {
      const event = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      const text = parseSseEvent(event);
      if (text) yield text;
    }
  }
  const tail = (pending + decoder.decode()).trim();
  if (tail) {
    const text = parseSseEvent(tail);
    if (text) yield text;
  }
}

module.exports = { streamCallAnswer, parseSseEvent, getCallModel };
