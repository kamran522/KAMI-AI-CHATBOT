"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

function wav() {
  const b = Buffer.alloc(44 + 480);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(480, 40);
  return b;
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kami-local-test-"));
  fs.mkdirSync(path.join(dir, "whisper.cpp", "build", "bin"), { recursive: true });
  fs.mkdirSync(path.join(dir, "whisper.cpp", "models"), { recursive: true });
  fs.mkdirSync(path.join(dir, "venv", "bin"), { recursive: true });
  fs.mkdirSync(path.join(dir, "voices"), { recursive: true });
  fs.mkdirSync(path.join(dir, "balochi-stt"), { recursive: true });
  fs.mkdirSync(path.join(dir, "balochi-tts"), { recursive: true });
  fs.mkdirSync(path.join(dir, "balochi-venv", "bin"), { recursive: true });
  for (const relative of [
    "whisper.cpp/build/bin/whisper-cli",
    "whisper.cpp/models/ggml-small.bin",
    "venv/bin/piper", "voices/en_US-lessac-medium.onnx",
    "voices/en_US-lessac-medium.onnx.json", "voices/ur_PK-fasih-medium.onnx",
    "voices/ur_PK-fasih-medium.onnx.json", "balochi-venv/bin/python",
  ]) fs.writeFileSync(path.join(dir, relative), "fixture");
  const previous = process.env.LOCAL_VOICE_DIR;
  process.env.LOCAL_VOICE_DIR = dir;
  const target = path.join(dir, "local-voice.js");
  fs.copyFileSync(path.join(__dirname, "..", "local-voice.js"), target);
  const api = require(target);
  return {
    api, dir,
    cleanup: () => {
      if (previous === undefined) delete process.env.LOCAL_VOICE_DIR;
      else process.env.LOCAL_VOICE_DIR = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("per-chat local language commands persist without changing unrelated chats", () => {
  const s = setup();
  try {
    assert.equal(s.api.localLanguage("chat-a"), "auto");
    assert.match(s.api.handleVoiceCommand("chat-a", "/voice balochi"), /balochi/);
    assert.equal(s.api.localLanguage("chat-a"), "balochi");
    assert.equal(s.api.localLanguage("chat-b"), "auto");
    assert.equal(s.api.handleVoiceCommand("chat-a", "ordinary message"), null);
    assert.match(s.api.handleVoiceCommand("chat-b", "/voice no-such-language"), /Unsupported/);
    assert.equal(s.api.handleVoiceCommand("chat-a", "/voice off").includes("off"), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, "local_voice_languages.json"), "utf8"))["chat-a"], "off");
    assert.equal(s.api.detectLanguage("یہ اردو ہے", "auto"), "urdu");
    assert.equal(s.api.detectLanguage("Hello world", "auto"), "english");
    assert.equal(s.api.detectLanguage("بلوچی", "balochi"), "balochi");
  } finally { s.cleanup(); }
});

test("local Whisper receives decoded 16k WAV and returns Urdu transcription", async () => {
  const s = setup(); const commands = [];
  try {
    const result = await s.api.transcribeLocalVoice(
      Buffer.from("ogg audio"), "audio/ogg", "urdu", {
        run: async (command, args) => {
          commands.push({ command, args });
          if (command === "ffmpeg") await fsp.writeFile(args.at(-1), wav());
          else {
            assert.equal(args[args.indexOf("-l") + 1], "ur");
            await fsp.writeFile(args[args.indexOf("-of") + 1] + ".txt", "آپ کیسے ہیں");
          }
        },
      }
    );
    assert.equal(result.transcript, "آپ کیسے ہیں");
    assert.equal(result.language, "urdu");
    assert.equal(commands.length, 2);
    assert.equal(commands[0].args[commands[0].args.indexOf("-ar") + 1], "16000");
  } finally { s.cleanup(); }
});

test("Piper chooses English and Urdu voices, returns valid WAV, and never logs text", async () => {
  const s = setup();
  try {
    const seen = [];
    const runner = async (command, args, config) => {
      seen.push({ command, args, config });
      assert.ok(command.includes("piper"));
      assert.ok(config.input);
      await fsp.writeFile(args[args.indexOf("--output_file") + 1], wav());
    };
    assert.deepEqual(await s.api.synthesizeLocalVoice("Hello there", "english", { run: runner }), wav());
    assert.deepEqual(await s.api.synthesizeLocalVoice("سلام", "urdu", { run: runner }), wav());
    assert.ok(seen[0].args.join(" ").includes("en_US-lessac-medium"));
    assert.ok(seen[1].args.join(" ").includes("ur_PK-fasih-medium"));
    assert.throws(() => s.api.verifyWav(Buffer.from("incorrect")), /LOCAL_VOICE_INVALID_WAV/);
  } finally { s.cleanup(); }
});

test("Balochi transcription and speech run optional offline Python worker", async () => {
  const s = setup(); const commands = [];
  try {
    const run = async (command, args, config) => {
      commands.push({ command, args, config });
      if (command === "ffmpeg") await fsp.writeFile(args.at(-1), wav());
      else if (args[1] === "stt") {
        assert.equal(config.env.HF_HUB_OFFLINE, "1");
        await fsp.writeFile(args[3], "من بلوچی زبان ءَ گپ جنان");
      } else if (args[1] === "tts") {
        await fsp.writeFile(args[3], wav());
      } else throw new Error("unexpected command");
    };
    const received = await s.api.transcribeLocalVoice(
      Buffer.from("audio"), "audio/ogg", "balochi", { run });
    assert.equal(received.language, "balochi");
    assert.match(received.transcript, /بلوچی/);
    assert.deepEqual(await s.api.synthesizeLocalVoice("من بلوچی زبان ءَ گپ جنان", "balochi", { run }), wav());
    await assert.rejects(s.api.synthesizeLocalVoice("Latin Balochi", "balochi", { run }),
      /LOCAL_BALOCHI_REQUIRES_ARABIC_SCRIPT/);
    assert.equal(commands.filter(x => x.args[1] === "stt" || x.args[1] === "tts").length, 2);
  } finally { s.cleanup(); }
});

test("Ollama replies stay on loopback, disable thinking and match target language", async () => {
  const { generateOllamaAnswer } = require("../local-ai");
  let called = 0;
  const answer = await generateOllamaAnswer("How are you?", [
    { role: "user", content: "previous" },
    { role: "assistant", content: "reply" },
  ], "The local personality.", {
    language: "balochi", voiceReply: true,
    fetchImpl: async (url, options) => {
      called++;
      assert.equal(url, "http://127.0.0.1:11434/api/chat");
      const data = JSON.parse(options.body);
      assert.equal(data.model, "qwen3:4b");
      assert.equal(data.think, false);
      assert.equal(data.stream, false);
      assert.equal(data.messages.length, 4);
      assert.match(data.messages[0].content, /Balochi/);
      assert.equal(data.options.num_thread, 4);
      return { ok: true, json: async () => ({ message: { content: "بلوچی جواب" } }) };
    },
  });
  assert.equal(answer, "بلوچی جواب");
  assert.equal(called, 1);
});

test("local AI errors do not silently use any cloud service", async () => {
  const { generateOllamaAnswer } = require("../local-ai");
  await assert.rejects(generateOllamaAnswer("test", [], "", {
    fetchImpl: async () => { throw new TypeError("refused"); },
  }), /LOCAL_OLLAMA_UNAVAILABLE/);
  await assert.rejects(generateOllamaAnswer("test", [], "", {
    fetchImpl: async () => ({ ok: false, status: 404 }),
  }), /LOCAL_OLLAMA_HTTP_404/);
});

test("WhatsApp local voice replies are sent as push-to-talk audio and do not call Gemini", async () => {
  const previous = process.env.LOCAL_VOICE_ENABLED;
  const previousText = process.env.LOCAL_TEXT_ENABLED;
  process.env.LOCAL_VOICE_ENABLED = "1";
  process.env.LOCAL_TEXT_ENABLED = "1";
  const ev = new EventEmitter();
  const sent = [];
  const calls = [];
  const socket = {
    ev, updateMediaMessage: async () => {},
    sendMessage: async (jid, payload) => { sent.push({ jid, payload }); },
  };
  const oldLoad = Module._load;
  Module._load = function (name, ...args) {
    if (name === "@adiwajshing/baileys") return {
      default: () => socket,
      useMultiFileAuthState: async () => ({ state: {}, saveCreds: () => {} }),
      fetchLatestBaileysVersion: async () => ({ version: [1, 2, 3] }),
      DisconnectReason: { loggedOut: 401, badSession: 500, connectionReplaced: 440 },
      downloadMediaMessage: async () => Buffer.from("ogg bytes"),
    };
    if (name === "pino") return () => ({ level: "silent" });
    if (name === "qrcode-terminal") return { generate: () => {} };
    if (name === "./voice") return {
      extractIncomingVoiceNote: (m) => m.audioMessage?.ptt ? m.audioMessage : null,
      validateVoiceNote: () => "audio/ogg",
      wavToWhatsAppVoiceNote: async () => Buffer.from("OggS audio"),
    };
    if (name === "./local-voice") return {
      voiceEnabled: () => true,
      localLanguage: () => "urdu",
      handleVoiceCommand: () => null,
      transcribeLocalVoice: async () => ({ transcript: "سلام", language: "urdu" }),
      synthesizeLocalVoice: async () => wav(),
      safeLocalVoiceError: (e) => e.message,
    };
    if (name === "./local-ai") return {
      isEnabled: () => true, safeLocalAiError: (e) => e.message,
    };
    if (name === "./kami") return {
      extractIncomingText: (m) => m.conversation || "",
      generateGeminiReply: async () => { throw new Error("Remote text invoked"); },
      generateVoiceAnswer: async () => { throw new Error("Remote audio invoked"); },
      generateLocalReply: async (jid, text, opts) => {
        calls.push({ jid, text, opts });
        return "بالکل ٹھیک";
      },
      splitReply: (a) => [a],
      describeGeminiError: (e) => e.message,
      getSafeErrorReply: (e) => e.message,
    };
    return oldLoad.call(this, name, ...args);
  };
  let bot;
  try {
    const target = path.join(__dirname, "..", "index.js");
    delete require.cache[require.resolve(target)];
    bot = require(target);
  } finally { Module._load = oldLoad; }

  try {
    await bot.startKamiBot();
    ev.emit("messages.upsert", {
      type: "notify", messages: [{
        key: { remoteJid: "voice@s.whatsapp.net", id: "note-1", fromMe: false },
        message: { audioMessage: { ptt: true } },
      }],
    });
    for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.language, "urdu");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.ptt, true);
    assert.equal(sent[0].payload.mimetype, "audio/ogg; codecs=opus");
  } finally {
    if (previous === undefined) delete process.env.LOCAL_VOICE_ENABLED;
    else process.env.LOCAL_VOICE_ENABLED = previous;
    if (previousText === undefined) delete process.env.LOCAL_TEXT_ENABLED;
    else process.env.LOCAL_TEXT_ENABLED = previousText;
  }
});
