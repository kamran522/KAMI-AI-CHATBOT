"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

function withGeminiStub(post) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kami-recovery-"));
  for (const file of ["kami.js", "custom_prompt.txt", "groq.js"]) {
    fs.copyFileSync(path.join(__dirname, "..", file), path.join(dir, file));
  }
  const realLoad = Module._load;
  Module._load = function (name, ...args) {
    if (name === "axios") return { post };
    return realLoad.call(this, name, ...args);
  };
  let bot;
  try {
    bot = require(path.join(dir, "kami.js"));
  } finally {
    Module._load = realLoad;
  }
  return {
    bot,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function restoreKey(original) {
  if (original === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = original;
}

test("transient Gemini failure sends one retry notification and returns the successful answer", async () => {
  const original = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  let calls = 0;
  const { bot, cleanup } = withGeminiStub(async () => {
    if (++calls === 1) {
      throw Object.assign(new Error("Unavailable"), { response: { status: 503 } });
    }
    return { data: { candidates: [{ content: { parts: [{ text: "Recovered reply" }] } }] } };
  });
  const notifications = [];
  try {
    const result = await bot.generateGeminiReply("chat-1", "Hello", {
      onRetry: async (error) => notifications.push(error.response.status),
    });
    assert.equal(result, "Recovered reply");
    assert.equal(calls, 2);
    assert.deepEqual(notifications, [503]);
    assert.match(bot.getSafeErrorReply({ response: { status: 503 } }), /Updating, please wait/);
  } finally {
    restoreKey(original);
    cleanup();
  }
});

test("invalid model does not retry and returns a useful WhatsApp error message", async () => {
  const original = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  let calls = 0;
  const { bot, cleanup } = withGeminiStub(async () => {
    calls++;
    throw Object.assign(new Error("Not found"), { response: { status: 404 } });
  });
  let notified = 0;
  try {
    await assert.rejects(bot.generateGeminiReply("chat-2", "Hello", {
      onRetry: async () => { notified++; },
    }), /Not found/);
    assert.equal(calls, 1);
    assert.equal(notified, 0);
    assert.match(bot.getSafeErrorReply({ response: { status: 404 } }), /Updating, please wait/);
    assert.match(bot.getSafeErrorReply({ response: { status: 404 } }), /GEMINI_MODEL/);
  } finally {
    restoreKey(original);
    cleanup();
  }
});

test("WhatsApp sends a progress message before a recovered Gemini response", async () => {
  const ev = new EventEmitter();
  const sent = [];
  const socket = {
    ev,
    sendMessage: async (jid, payload, options) => { sent.push({ jid, payload, options }); },
  };
  const realLoad = Module._load;
  Module._load = function (name, ...args) {
    if (name === "@adiwajshing/baileys") {
      return {
        default: () => socket,
        useMultiFileAuthState: async () => ({ state: {}, saveCreds: () => {} }),
        fetchLatestBaileysVersion: async () => ({ version: [1, 2, 3] }),
        DisconnectReason: { loggedOut: 401, badSession: 500, connectionReplaced: 440 },
      };
    }
    if (name === "pino") return () => ({ level: "silent" });
    if (name === "qrcode-terminal") return { generate: () => {} };
    if (name === "./kami") {
      return {
        extractIncomingText: (m) => m.conversation,
        splitReply: (text) => [text],
        describeGeminiError: () => "HTTP 503",
        getSafeErrorReply: () => "Could not recover",
        generateGeminiReply: async (jid, text, { onRetry }) => {
          await onRetry({ response: { status: 503 } });
          return "Recovered answer";
        },
      };
    }
    return realLoad.call(this, name, ...args);
  };
  let bot;
  try {
    const entry = path.join(__dirname, "..", "index.js");
    delete require.cache[require.resolve(entry)];
    bot = require(entry);
  } finally {
    Module._load = realLoad;
  }

  await bot.startKamiBot();
  const incoming = { key: { remoteJid: "123@s.whatsapp.net", id: "recovery-test", fromMe: false }, message: { conversation: "Hello" } };
  ev.emit("messages.upsert", { type: "notify", messages: [incoming] });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sent.length, 2);
  assert.match(sent[0].payload.text, /Updating, please wait/);
  assert.equal(sent[1].payload.text, "Recovered answer");
  assert.ok(sent.every((message) => message.options.quoted === incoming));
});
