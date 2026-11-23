"use strict";

const { spawn } = require("node:child_process");

const MAX_VOICE_NOTE_BYTES = 8 * 1024 * 1024;
const MAX_VOICE_NOTE_SECONDS = 180;
const MAX_OUTGOING_VOICE_BYTES = 8 * 1024 * 1024;

// A voice note is WhatsApp audio with ptt=true, including disappearing audio.
function extractIncomingVoiceNote(message) {
  let content = message;
  for (let depth = 0; depth < 6 && content && typeof content === "object"; depth++) {
    const nested =
      content.ephemeralMessage?.message ||
      content.viewOnceMessage?.message ||
      content.viewOnceMessageV2?.message ||
      content.viewOnceMessageV2Extension?.message;
    if (!nested) break;
    content = nested;
  }
  const audio = content?.audioMessage;
  return audio?.ptt === true ? audio : null;
}

function normalizeVoiceMimeType(mimeType) {
  const mime = String(mimeType || "audio/ogg").split(";")[0].trim().toLowerCase();
  if (mime === "audio/mp4" || mime === "audio/x-m4a") return "audio/m4a";
  const supported = new Set(["audio/ogg", "audio/opus", "audio/mpeg", "audio/mp3", "audio/m4a", "audio/aac", "audio/webm", "audio/wav"]);
  if (!supported.has(mime)) throw new Error("VOICE_UNSUPPORTED_FORMAT");
  return mime;
}

function validateVoiceNote(audio) {
  const size = Number(audio?.fileLength?.toString?.() || 0);
  const seconds = Number(audio?.seconds?.toString?.() || 0);
  if ((Number.isFinite(size) && size > MAX_VOICE_NOTE_BYTES) ||
      (Number.isFinite(seconds) && seconds > MAX_VOICE_NOTE_SECONDS)) {
    throw new Error("VOICE_TOO_LARGE");
  }
  return normalizeVoiceMimeType(audio?.mimetype);
}

// Gemini 3.8 TTS produces a WAV file. WhatsApp push-to-talk audio requires OGG/Opus.
// Conversion uses in-memory pipes: no voice notes are written to disk.
function wavToWhatsAppVoiceNote(wav, { ffmpegPath = "ffmpeg" } = {}) {
  if (!Buffer.isBuffer(wav) || wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" ||
      wav.toString("ascii", 8, 12) !== "WAVE") {
    return Promise.reject(new Error("VOICE_INVALID_WAV"));
  }
  if (wav.length > MAX_OUTGOING_VOICE_BYTES) {
    return Promise.reject(new Error("VOICE_OUTPUT_TOO_LARGE"));
  }

  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner", "-loglevel", "error",
      "-f", "wav", "-i", "pipe:0",
      "-vn", "-ac", "1", "-ar", "48000",
      "-c:a", "libopus", "-b:a", "32k", "-application", "voip",
      "-f", "ogg", "pipe:1",
    ];
    let child;
    try {
      child = spawn(ffmpegPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      reject(error);
      return;
    }

    let done = false;
    let total = 0;
    let diagnostics = "";
    const chunks = [];
    const finish = (error, output) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(output);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error("VOICE_FFMPEG_TIMEOUT"));
    }, 120000);

    child.on("error", (error) => {
      finish(new Error(error.code === "ENOENT" ? "VOICE_FFMPEG_NOT_INSTALLED" : "VOICE_FFMPEG_FAILED"));
    });
    child.stdout.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_OUTGOING_VOICE_BYTES) {
        child.kill();
        finish(new Error("VOICE_OUTPUT_TOO_LARGE"));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      diagnostics = (diagnostics + chunk.toString("utf8")).slice(-500);
    });
    child.stdin.on("error", () => {}); // A failed conversion can close stdin early.
    child.on("close", (code) => {
      if (code !== 0) {
        finish(new Error("VOICE_FFMPEG_FAILED: " + diagnostics));
      } else if (!total || Buffer.concat(chunks, total).toString("ascii", 0, 4) !== "OggS") {
        finish(new Error("VOICE_INVALID_OGG"));
      } else {
        finish(null, Buffer.concat(chunks, total));
      }
    });
    child.stdin.end(wav);
  });
}

module.exports = {
  extractIncomingVoiceNote,
  validateVoiceNote,
  wavToWhatsAppVoiceNote,
  MAX_VOICE_NOTE_BYTES,
};
