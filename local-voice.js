"use strict";

// Offline CPU speech pipeline. Never sends speech to a remote API.
// Installed binaries and models live in the user's home, never in Git.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

const MODEL_DIR = process.env.LOCAL_VOICE_DIR || path.join(os.homedir(), ".local", "share", "kami-local-voice");
const LANG_FILE = path.join(__dirname, "local_voice_languages.json");
const ALLOWED_LANGS = new Set(["auto", "english", "urdu", "balochi", "off"]);
const MAX_TEXT_CHARS = 240;

function voiceEnabled() { return process.env.LOCAL_VOICE_ENABLED === "1"; }
function localLanguage(chatId) {
  return languageChoices[chatId] || (ALLOWED_LANGS.has(process.env.LOCAL_VOICE_DEFAULT_LANGUAGE)
    ? process.env.LOCAL_VOICE_DEFAULT_LANGUAGE : "auto");
}
function readChoices() {
  try {
    const data = JSON.parse(fs.readFileSync(LANG_FILE, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    return Object.fromEntries(Object.entries(data)
      .filter(([jid, language]) => typeof jid === "string" && ALLOWED_LANGS.has(language)));
  } catch { return {}; }
}
const languageChoices = readChoices();

function saveChoices() {
  const tmp = LANG_FILE + ".tmp-" + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(languageChoices) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, LANG_FILE);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

function handleVoiceCommand(chatId, text) {
  const trimmed = String(text || "").trim().toLowerCase();
  if (!/^\/voice(?:\s|$)/.test(trimmed)) return null;
  const argument = trimmed.slice("/voice".length).trim();
  if (!argument || argument === "status") {
    return "Local voice: " + (voiceEnabled() ? "ENABLED" : "DISABLED on server") +
      "\nLanguage for this chat: " + localLanguage(chatId) +
      "\nChoose /voice english, /voice urdu, /voice balochi, /voice auto, or /voice off." +
      "\nBalochi requires the optional Balochi models and may make recognition errors.";
  }
  if (!ALLOWED_LANGS.has(argument))
    return "Unsupported language. Choose /voice english, /voice urdu, /voice balochi, /voice auto, or /voice off.";
  languageChoices[chatId] = argument;
  saveChoices();
  return "Voice language set to " + argument + " for this chat." +
    (argument === "balochi" ? " Install the optional Balochi models on the server first." : "");
}

// Explicit language avoids mistaking Arabic-script Balochi for Urdu.
function detectLanguage(transcript, requested) {
  if (requested !== "auto") return requested;
  return /[\u0600-\u06ff]/u.test(transcript) ? "urdu" : "english";
}

function runCommand(program, args, { input, timeoutMs = 90000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"], env, windowsHide: true });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let done = false;
    const fail = (error) => { if (!done) { done = true; clearTimeout(timer); reject(error); } };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error("LOCAL_VOICE_TIMEOUT"));
    }, timeoutMs);
    const collect = (which, chunk) => {
      const old = which === "stdout" ? stdout : stderr;
      if (old.length + chunk.length > 512 * 1024) {
        child.kill("SIGKILL");
        fail(new Error("LOCAL_VOICE_OUTPUT_LIMIT"));
      } else if (which === "stdout") stdout = Buffer.concat([old, chunk]);
      else stderr = Buffer.concat([old, chunk]);
    };
    child.stdout.on("data", chunk => collect("stdout", chunk));
    child.stderr.on("data", chunk => collect("stderr", chunk));
    child.on("error", () => fail(new Error("LOCAL_VOICE_COMMAND_UNAVAILABLE")));
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) reject(new Error("LOCAL_VOICE_COMMAND_FAILED"));
      else resolve(stdout.toString("utf8").trim());
    });
    if (input) child.stdin.on("error", () => {}); // e.g. Piper exits before input is accepted
    child.stdin.end(input || "");
  });
}

function assets() {
  return {
    root: MODEL_DIR,
    whisperBinary: process.env.LOCAL_WHISPER_BIN || path.join(MODEL_DIR, "whisper.cpp", "build", "bin", "whisper-cli"),
    whisperModel: process.env.LOCAL_WHISPER_MODEL || path.join(MODEL_DIR, "whisper.cpp", "models", "ggml-small.bin"),
    piperBinary: process.env.LOCAL_PIPER_BIN || path.join(MODEL_DIR, "venv", "bin", "piper"),
    piperEnglish: path.join(MODEL_DIR, "voices", "en_US-lessac-medium.onnx"),
    piperUrdu: path.join(MODEL_DIR, "voices", "ur_PK-fasih-medium.onnx"),
    python: path.join(MODEL_DIR, "balochi-venv", "bin", "python"),
    balochiStt: path.join(MODEL_DIR, "balochi-stt"),
    balochiTts: path.join(MODEL_DIR, "balochi-tts"),
  };
}

function verifyWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44 ||
      buffer.toString("ascii", 0, 4) !== "RIFF" ||
      buffer.toString("ascii", 8, 12) !== "WAVE")
    throw new Error("LOCAL_VOICE_INVALID_WAV");
  return buffer;
}

async function runBalochi(mode, input, output, { run = runCommand } = {}) {
  const a = assets();
  if (![a.python, mode === "stt" ? a.balochiStt : a.balochiTts]
      .every((p) => fs.existsSync(p)))
    throw new Error("LOCAL_BALOCHI_NOT_INSTALLED");
  await run(a.python, [
    path.join(__dirname, "scripts", "local-balochi.py"),
    mode, input, output, mode === "stt" ? a.balochiStt : a.balochiTts,
  ], {
    timeoutMs: 150000,
    env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1",
      HF_HUB_DISABLE_TELEMETRY: "1", OMP_NUM_THREADS: "4" },
  });
}

// Each voice request has a private scratch directory, deleted on success/failure.
async function transcribeLocalVoice(audio, mimeType, requestedLanguage, { run = runCommand } = {}) {
  if (!Buffer.isBuffer(audio) || !audio.length) throw new Error("VOICE_EMPTY_AUDIO");
  if (audio.length > 8 * 1024 * 1024) throw new Error("VOICE_TOO_LARGE");
  if (!["auto", "english", "urdu", "balochi"].includes(requestedLanguage))
    throw new Error("LOCAL_VOICE_LANGUAGE_INVALID");
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "kami-stt-"));
  try {
    const input = path.join(dir, "input.audio");
    const wav = path.join(dir, "input.wav");
    await fsp.writeFile(input, audio, { mode: 0o600 });
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-i", input,
      "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav,
    ], { timeoutMs: 35000 });

    if (requestedLanguage === "balochi") {
      const output = path.join(dir, "transcript.txt");
      await runBalochi("stt", wav, output, { run });
      const transcript = (await fsp.readFile(output, "utf8")).trim();
      if (!transcript) throw new Error("VOICE_NO_SPEECH");
      return { transcript: transcript.slice(0, 3000), language: "balochi" };
    }

    const a = assets();
    if (!fs.existsSync(a.whisperBinary) || !fs.existsSync(a.whisperModel))
      throw new Error("LOCAL_WHISPER_NOT_INSTALLED");
    const prefix = path.join(dir, "speech");
    const lang = requestedLanguage === "urdu" ? "ur" :
      requestedLanguage === "english" ? "en" : "auto";
    await run(a.whisperBinary, [
      "-m", a.whisperModel, "-f", wav, "-t", "4", "-l", lang,
      "-otxt", "-of", prefix, "-nt",
    ], { timeoutMs: 100000 });
    const transcript = (await fsp.readFile(prefix + ".txt", "utf8")).trim();
    if (!transcript) throw new Error("VOICE_NO_SPEECH");
    return { transcript: transcript.slice(0, 3000),
      language: detectLanguage(transcript, requestedLanguage) };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function synthesizeLocalVoice(text, language, { run = runCommand } = {}) {
  const spoken = String(text || "").trim().slice(0, MAX_TEXT_CHARS);
  if (!spoken) throw new Error("LOCAL_VOICE_EMPTY_ANSWER");
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "kami-tts-"));
  try {
    const wav = path.join(dir, "reply.wav");
    if (language === "balochi") {
      // MMS Balochi TTS expects Southern Balochi text written in Arabic script.
      if (!/[\u0600-\u06ff]/u.test(spoken))
        throw new Error("LOCAL_BALOCHI_REQUIRES_ARABIC_SCRIPT");
      const input = path.join(dir, "reply.txt");
      await fsp.writeFile(input, spoken, { mode: 0o600 });
      await runBalochi("tts", input, wav, { run });
    } else {
      const a = assets();
      const voice = language === "urdu" ? a.piperUrdu : a.piperEnglish;
      if (!fs.existsSync(a.piperBinary) || !fs.existsSync(voice) ||
          !fs.existsSync(voice + ".json"))
        throw new Error("LOCAL_PIPER_NOT_INSTALLED");
      await run(a.piperBinary, [
        "--model", voice, "--config", voice + ".json", "--output_file", wav,
      ], { input: spoken + "\n", timeoutMs: 65000 });
    }
    return verifyWav(await fsp.readFile(wav));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

function safeLocalVoiceError(error) {
  const known = new Set([
    "LOCAL_WHISPER_NOT_INSTALLED", "LOCAL_PIPER_NOT_INSTALLED",
    "LOCAL_BALOCHI_NOT_INSTALLED", "LOCAL_BALOCHI_REQUIRES_ARABIC_SCRIPT",
    "LOCAL_VOICE_TIMEOUT", "LOCAL_VOICE_COMMAND_FAILED",
    "LOCAL_VOICE_COMMAND_UNAVAILABLE", "VOICE_NO_SPEECH", "VOICE_TOO_LARGE",
    "VOICE_EMPTY_AUDIO", "LOCAL_VOICE_INVALID_WAV", "LOCAL_VOICE_LANGUAGE_INVALID",
    "LOCAL_VOICE_EMPTY_ANSWER", "LOCAL_VOICE_OUTPUT_LIMIT",
  ]);
  return known.has(error?.message) ? error.message : "LOCAL_VOICE_UNAVAILABLE";
}
module.exports = {
  voiceEnabled, localLanguage, handleVoiceCommand, detectLanguage,
  assets, runCommand, transcribeLocalVoice, synthesizeLocalVoice,
  safeLocalVoiceError, verifyWav,
};