"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const { spawnSync } = require("node:child_process");
const { extractIncomingVoiceNote, validateVoiceNote, wavToWhatsAppVoiceNote } = require("../voice");

function makeWav() {
  const frames = 1200; // 50 ms of mono silence at 24 kHz
  const wav = Buffer.alloc(44 + frames * 2);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(frames * 2, 40);
  return wav;
}

function makeGeminiFixture(post) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "kami-voice-test-"));
  for (const file of ["kami.js", "custom_prompt.txt"]) {
    fs.copyFileSync(path.join(__dirname, "..", file), path.join(folder, file));
  }
  const originalLoad = Module._load;
  Module._load = function (name, ...args) {
    if (name === "axios") return { post };
    return originalLoad.call(this, name, ...args);
  };
  let api;
  try {
    api = require(path.join(folder, "kami.js"));
  } finally {
    Module._load = originalLoad;
  }
  return { api, cleanup: () => fs.rmSync(folder, { force: true, recursive: true }) };
}

async function withTestKey(callback) {
  const original = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "unit-test-key";
  try { await callback(); } finally {
    if (original === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = original;
  }
}

test("finds voice notes inside ephemeral and view-once wrappers but ignores audio files", () => {
  const note = { ptt: true, mimetype: "audio/ogg; codecs=opus", fileLength: "123" };
  assert.equal(extractIncomingVoiceNote({ audioMessage: note }), note);
  assert.equal(extractIncomingVoiceNote({ ephemeralMessage: { message: { audioMessage: note } } }), note);
  assert.equal(extractIncomingVoiceNote({ viewOnceMessageV2: { message: { audioMessage: note } } }), note);
  assert.equal(extractIncomingVoiceNote({ audioMessage: { ptt: false } }), null);
  assert.equal(extractIncomingVoiceNote({ conversation: "hi" }), null);
  assert.equal(validateVoiceNote(note), "audio/ogg");
  assert.throws(() => validateVoiceNote({ ...note, seconds: 181 }), /VOICE_TOO_LARGE/);
  assert.throws(() => validateVoiceNote({ ...note, fileLength: 9000000 }), /VOICE_TOO_LARGE/);
  assert.throws(() => validateVoiceNote({ ...note, mimetype: "application/pdf" }), /VOICE_UNSUPPORTED_FORMAT/);
});

test("transcription sends OGG as Gemini inline audio, without adding it to history", async () => {
  await withTestKey(async () => {
    const calls = [];
    const fixture = makeGeminiFixture(async (...args) => {
      calls.push(args);
      return { data: { candidates: [{ content: { parts: [{ text: "سلام" }] } }] } };
    });
    try {
      const result = await fixture.api.transcribeVoiceNote(Buffer.from("sound"), "audio/ogg");
      assert.equal(result, "سلام");
      assert.equal(calls.length, 1);
      assert.match(calls[0][0], /models\\/gemini-/);
      assert.equal(calls[0][1].contents[0].parts[1].inlineData.mimeType, "audio/ogg");
      assert.equal(calls[0][1].contents[0].parts[1].inlineData.data, Buffer.from("sound").toString("base64"));
      assert.equal(calls[0][2].headers["x-goog-api-key"], "unit-test-key");
      assert.deepEqual(fixture.api.readChatHistory(), {});
      await assert.rejects(fixture.api.transcribeVoiceNote(Buffer.alloc(0), "audio/ogg"), /VOICE_EMPTY_AUDIO/);
    } finally { fixture.cleanup(); }
  });
});

test("TTS requests speech through Interactions API and extracts WAV output", async () => {
  await withTestKey(async () => {
    const wav = makeWav();
    const calls = [];
    const fixture = makeGeminiFixture(async (...args) => {
      calls.push(args);
      return { data: { steps: [{ type: "model_output", content: [{ type: "audio", data: wav.toString("base64") }] }] } };
    });
    try {
      const result = await fixture.api.synthesizeVoiceReply("Hello");
      assert.deepEqual(result, wav);
      assert.equal(calls.length, 1);
      assert.match(calls[0][0], /v1beta\\/interactions$/);
      assert.equal(calls[0][1].model, "gemini-3.8-flash-lite-tts");
      assert.equal(calls[0][1].input[0].content[0].text, "Hello");
      assert.equal(calls[0][1].generation_config.speech_config[0].voice, "Kore");
      assert.equal(calls[0][1].response_format.type, "audio");
      assert.match(fixture.api.getSpeechText("a".repeat(1200)), /\\.\\.\\.$/);
    } finally { fixture.cleanup(); }
  });
});

test("OGG encoding produces a real WhatsApp-compatible Opus container", {
  skip: spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0,
}, async () => {
  const ogg = await wavToWhatsAppVoiceNote(makeWav());
  assert.equal(ogg.toString("ascii", 0, 4), "OggS");
  assert.match(ogg.toString("latin1"), /OpusHead/);
  await assert.rejects(wavToWhatsAppVoiceNote(Buffer.from("not a wav")), /VOICE_INVALID_WAV/);
});

function makeSocketFixture({ ttsFails = false, tooLarge = false } = {}) {
  const ev = new EventEmitter();
  const sent = [];
  let downloads = 0;
  const requests = [];
  const socket = {
    ev,
    updateMediaMessage: async () => {},
    sendMessage: async (jid, payload, opts) => { sent.push({ jid, payload, opts }); },
  };
  const oldLoad = Module._load;
  Module._load = function (name, ...args) {
    if (name === "@adiwajshing/baileys") return {
      default: () => socket,
      useMultiFileAuthState: async () => ({ state: {}, saveCreds: () => {} }),
      fetchLatestBaileysVersion: async () => ({ version: [1, 2, 3] }),
      DisconnectReason: { loggedOut: 401, badSession: 500, connectionReplaced: 440 },
      downloadMediaMessage: async () => { downloads++; return Buffer.from("voice bytes"); },
    };
    if (name === "pino") return () => ({ level: "silent" });
    if (name === "qrcode-terminal") return { generate: () => {} };
    if (name === "./voice") return {
      extractIncomingVoiceNote: (message) => message?.audioMessage?.ptt ? message.audioMessage : null,
      validateVoiceNote: (audio) => {
        if (tooLarge) throw new Error("VOICE_TOO_LARGE");
        return "audio/ogg";
      },
      wavToWhatsAppVoiceNote: async () => Buffer.from("OggS voice"),
    };
    if (name === "./kami") return {
      extractIncomingText: (msg) => msg.conversation || "",
      transcribeVoiceNote: async () => "spoken question",
      generateGeminiReply: async (jid, text, options) => {
        requests.push({ jid, text, options });
        return "The spoken answer";
      },
      synthesizeVoiceReply: async () => {
        if (ttsFails) throw new Error("VOICE_TTS_ERROR");
        return makeWav();
      },
      getSpeechText: (answer) => answer,
      splitReply: (answer) => [answer],
      describeGeminiError: () => "safe error",
      getSafeErrorReply: (error) => error.message,
    };
    return oldLoad.call(this, name, ...args);
  };
  let index;
  try {
    const filename = path.join(__dirname, "..", "index.js");
    delete require.cache[require.resolve(filename)];
    index = require(filename);
  } finally {
    Module._load = oldLoad;
  }
  return { index, ev, sent, requests, getDownloads: () => downloads };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("voice note gets a ptt=true audio response, and text messages still receive text", async () => {
  const fixture = makeSocketFixture();
  await fixture.index.startKamiBot();
  const voice = { key: { remoteJid: "1@s.whatsapp.net", id: "1" }, message: { audioMessage: { ptt: true } } };
  const text = { key: { remoteJid: "2@s.whatsapp.net", id: "2" }, message: { conversation: "hello" } };
  fixture.ev.emit("messages.upsert", { type: "notify", messages: [voice, text] });
  await flush();
  assert.equal(fixture.getDownloads(), 1);
  assert.equal(fixture.sent.length, 2);
  const outgoingVoice = fixture.sent.find((m) => m.jid === "1@s.whatsapp.net");
  assert.equal(outgoingVoice.payload.ptt, true);
  assert.equal(outgoingVoice.payload.mimetype, "audio/ogg; codecs=opus");
  assert.ok(Buffer.isBuffer(outgoingVoice.payload.audio));
  assert.equal(outgoingVoice.opts.quoted, voice);
  assert.equal(fixture.sent.find((m) => m.jid === "2@s.whatsapp.net").payload.text, "The spoken answer");
  assert.deepEqual(fixture.requests.map((r) => r.text).sort(), ["hello", "spoken question"]);
  assert.equal(fixture.requests.find((r) => r.text === "spoken question").options.voiceReply, true);
});

test("TTS failures deliver the generated answer as text; oversized voice is never downloaded", async () => {
  const a = makeSocketFixture({ ttsFails: true });
  await a.index.startKamiBot();
  a.ev.emit("messages.upsert", { type: "notify", messages: [
    { key: { remoteJid: "3@s.whatsapp.net", id: "1" }, message: { audioMessage: { ptt: true } } },
  ] });
  await flush();
  assert.equal(a.sent.length, 1);
  assert.match(a.sent[0].payload.text, /Voice reply is unavailable/);
  assert.match(a.sent[0].payload.text, /The spoken answer/);

  const b = makeSocketFixture({ tooLarge: true });
  await b.index.startKamiBot();
  b.ev.emit("messages.upsert", { type: "notify", messages: [
    { key: { remoteJid: "4@s.whatsapp.net", id: "1" }, message: { audioMessage: { ptt: true } } },
  ] });
  await flush();
  assert.equal(b.getDownloads(), 0);
  assert.equal(b.sent.length, 1);
  assert.match(b.sent[0].payload.text, /VOICE_TOO_LARGE/);
});
