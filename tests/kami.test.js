"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

function createTestBot() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kami-bot-test-"));
  for (const filename of ["kami.js", "custom_prompt.txt"]) {
    fs.copyFileSync(path.join(__dirname, "..", filename), path.join(tempDir, filename));
  }
  fs.writeFileSync(path.join(tempDir, "key.json"), '{"geminiApiKey":"YOUR_GEMINI_API_KEY_HERE"}');
  fs.writeFileSync(path.join(tempDir, "chat_history.json"), "{}");
  const calls = [];
  const axiosStub = {
    post: async (...args) => {
      calls.push(args);
      return { data: { candidates: [{ content: { parts: [{ text: "Hello from Gemini" }] } }] } };
    },
  };
  const realLoad = Module._load;
  Module._load = function (name, ...args) {
    return name === "axios" ? axiosStub : realLoad.call(this, name, ...args);
  };
  let bot;
  try {
    bot = require(path.join(tempDir, "kami.js"));
  } finally {
    Module._load = realLoad;
  }
  return { bot, calls, tempDir, cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }) };
}

test("extracts plain text, extended text, captions and ephemeral text", () => {
  const { bot, cleanup } = createTestBot();
  try {
    assert.equal(bot.extractIncomingText({ conversation: "Hello" }), "Hello");
    assert.equal(bot.extractIncomingText({ extendedTextMessage: { text: "  What time is it? " } }), "What time is it?");
    assert.equal(bot.extractIncomingText({ imageMessage: { caption: "Image text" } }), "Image text");
    assert.equal(bot.extractIncomingText({ videoMessage: { caption: "Video text" } }), "Video text");
    assert.equal(bot.extractIncomingText({ documentMessage: { caption: "Document text" } }), "Document text");
    assert.equal(bot.extractIncomingText({ ephemeralMessage: { message: { conversation: "Disappearing text" } } }), "Disappearing text");
    assert.equal(bot.extractIncomingText({ viewOnceMessageV2: { message: { imageMessage: { caption: "View-once caption" } } } }), "View-once caption");
    assert.equal(bot.extractIncomingText({ stickerMessage: {} }), "");
    assert.equal(bot.extractIncomingText({ conversation: "  " }), "");
  } finally { cleanup(); }
});

test("any message text including command-like text is sent to Gemini and history is per-chat", async () => {
  const setup = createTestBot();
  const oldKey = process.env.GEMINI_API_KEY;
  const oldModel = process.env.GEMINI_MODEL;
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GEMINI_MODEL = "gemini-3.8-flash";
  try {
    const texts = ["Hi", "!owner", "!reset", "/anything", "!ai hello"];
    for (const text of texts) {
      assert.equal(await setup.bot.generateGeminiReply("group@g.us", text), "Hello from Gemini");
    }
    assert.equal(setup.calls.length, 5);
    assert.deepEqual(setup.calls.map((call) => call[1].contents.at(-1).parts[0].text), texts);
    assert.equal(setup.calls[0][2].headers["x-goog-api-key"], "test-key");
    assert.match(setup.calls[0][0], /gemini-3\.8-flash:generateContent$/);
    assert.match(setup.calls[0][1].systemInstruction.parts[0].text, /Kamran Hasil/);
    assert.match(setup.calls[0][1].systemInstruction.parts[0].text, /computer Science Student at UOT/);
    assert.match(setup.calls[0][1].systemInstruction.parts[0].text, /kamranhasilbaloch@gmail\.com/);
    assert.match(setup.calls[0][1].systemInstruction.parts[0].text, /923111008401/);
    assert.match(setup.calls[0][1].systemInstruction.parts[0].text, /Human: Hey, how are you doing today\?/);
    assert.deepEqual(setup.calls[1][1].contents.map((content) => content.role), ["user", "model", "user"]);

    await setup.bot.generateGeminiReply("second-chat@s.whatsapp.net", "Other chat");
    assert.equal(setup.calls[5][1].contents.length, 1);
    const history = JSON.parse(fs.readFileSync(path.join(setup.tempDir, "chat_history.json"), "utf8"));
    assert.equal(history["group@g.us"].length, 10);
    assert.equal(history["second-chat@s.whatsapp.net"].length, 2);
  } finally {
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = oldKey;
    if (oldModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = oldModel;
    setup.cleanup();
  }
});

test("API key is required, long replies split, and errors are not leaked", async () => {
  const setup = createTestBot();
  const oldKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    await assert.rejects(setup.bot.generateGeminiReply("group@g.us", "Hi"), /GEMINI_API_KEY_MISSING/);
    assert.equal(setup.calls.length, 0);
    assert.deepEqual(setup.bot.splitReply("abcde", 2), ["ab", "cd", "e"]);
    assert.match(setup.bot.getSafeErrorReply(new Error("GEMINI_API_KEY_MISSING")), /not configured/);
    assert.match(setup.bot.getSafeErrorReply({ message: "secret", response: { status: 429 } }), /rate-limited/);
    assert.match(setup.bot.getSafeErrorReply({ message: "secret", response: { status: 404 } }), /model is not available/);
    assert.doesNotMatch(setup.bot.getSafeErrorReply({ message: "private-api-key" }), /private-api-key/);
  } finally {
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = oldKey;
    setup.cleanup();
  }
});


test("diagnostic server logs include upstream status but redact secrets", () => {
  const { bot, cleanup } = createTestBot();
  const oldKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "AIza12345678901234567890123456789012";
  try {
    const err = { message: "Request failed", response: { status: 400, data: { error: { message: `Invalid field for ${process.env.GEMINI_API_KEY}` } } } };
    assert.match(bot.describeGeminiError(err), /HTTP 400/);
    assert.match(bot.describeGeminiError(err), /REDACTED/);
    assert.doesNotMatch(bot.describeGeminiError(err), /AIza123/);
    assert.match(bot.getSafeErrorReply(err), /HTTP 400/);
    assert.match(bot.getSafeErrorReply({ response: { status: 503 } }), /temporarily unavailable/);
  } finally {
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = oldKey;
    cleanup();
  }
});
