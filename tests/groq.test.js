"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

function makeBot(post) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kami-groq-fallback-"));
  for (const name of ["kami.js", "groq.js", "custom_prompt.txt"]) {
    fs.copyFileSync(path.join(__dirname, "..", name), path.join(tempDir, name));
  }
  fs.writeFileSync(path.join(tempDir, "chat_history.json"), "{}");
  const requests = [];
  const originalLoad = Module._load;
  Module._load = function (request, ...args) {
    if (request === "axios") return { post: (...params) => {
      requests.push(params);
      return post(...params);
    } };
    return originalLoad.call(this, request, ...args);
  };
  let bot;
  try { bot = require(path.join(tempDir, "kami.js")); }
  finally { Module._load = originalLoad; }
  return {
    bot,
    requests,
    tempDir,
    cleanup: () => fs.rmSync(tempDir, { force: true, recursive: true }),
  };
}

async function withKeys(run) {
  const names = ["GEMINI_API_KEY", "GROQ_API_KEY", "GROQ_MODEL", "GEMINI_PRIMARY_TIMEOUT_MS"];
  const previous = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  process.env.GEMINI_API_KEY = "test-gemini";
  process.env.GROQ_API_KEY = "gsk_test_fallback_secret_1234567890";
  delete process.env.GROQ_MODEL;
  delete process.env.GEMINI_PRIMARY_TIMEOUT_MS;
  try { await run(); }
  finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

test("Gemini success is primary and Groq is not contacted", async () => {
  await withKeys(async () => {
    const fixture = makeBot(async (url) => {
      assert.match(url, /generativelanguage.googleapis.com/);
      return { data: { candidates: [{ content: { parts: [{ text: "Gemini answer" }] } }] } };
    });
    try {
      assert.equal(await fixture.bot.generateGeminiReply("chat-a", "Hi"), "Gemini answer");
      assert.equal(fixture.requests.length, 1);
      assert.deepEqual(fixture.bot.readChatHistory()["chat-a"].map((r) => r.content),
        ["Hi", "Gemini answer"]);
    } finally { fixture.cleanup(); }
  });
});

test("Gemini 503 switches immediately to Groq, sends one notification and preserves conversation", async () => {
  await withKeys(async () => {
    const fixture = makeBot(async (url) => {
      if (url.includes("generativelanguage")) {
        throw Object.assign(new Error("Gemini outage"), { response: { status: 503 } });
      }
      return { data: { choices: [{ message: { content: "Groq answer" } }] } };
    });
    try {
      const notifications = [];
      const first = await fixture.bot.generateGeminiReply("chat-a", "Hello", {
        onRetry: async (err) => notifications.push(err.response.status),
      });
      assert.equal(first, "Groq answer");
      assert.deepEqual(notifications, [503]);
      assert.equal(fixture.requests.length, 2);
      assert.equal(fixture.requests[1][0], "https://api.groq.com/openai/v1/chat/completions");
      assert.equal(fixture.requests[1][1].model, "llama-3.3-70b-versatile");
      assert.equal(fixture.requests[1][2].headers.Authorization, "Bearer " + process.env.GROQ_API_KEY);
      assert.ok(fixture.requests[1][1].messages[0].content.length > 20);
      assert.equal(fixture.requests[0][2].timeout, 12000);
      assert.equal(await fixture.bot.generateGeminiReply("chat-a", "Next"), "Groq answer");
      assert.deepEqual(fixture.requests[3][1].messages.map((x) => x.role),
        ["system", "user", "assistant", "user"]);
      const history = fixture.bot.readChatHistory()["chat-a"];
      assert.deepEqual(history.map((r) => r.content), ["Hello", "Groq answer", "Next", "Groq answer"]);
    } finally { fixture.cleanup(); }
  });
});

test("Gemini missing key uses Groq, but blocked unsafe Gemini content is not bypassed", async () => {
  await withKeys(async () => {
    delete process.env.GEMINI_API_KEY;
    const fixture = makeBot(async (url) => {
      assert.ok(url.includes("api.groq.com"));
      return { data: { choices: [{ message: { content: "Groq only reply" } }] } };
    });
    try {
      assert.equal(await fixture.bot.generateGeminiReply("chat-b", "Hello"), "Groq only reply");
      assert.equal(fixture.requests.length, 1);
    } finally { fixture.cleanup(); }

    process.env.GEMINI_API_KEY = "test-gemini";
    const blocked = makeBot(async () => ({
      data: { candidates: [{ finishReason: "SAFETY", content: { parts: [] } }] },
    }));
    try {
      await assert.rejects(blocked.bot.generateGeminiReply("chat", "content"), /GEMINI_EMPTY_RESPONSE/);
      assert.equal(blocked.requests.length, 1);
    } finally { blocked.cleanup(); }
  });
});

test("Gemini and Groq failures are reported safely without leaking the Groq key", async () => {
  await withKeys(async () => {
    const fixture = makeBot(async (url) => {
      if (url.includes("generativelanguage")) throw Object.assign(new Error("Unavailable"), { response: { status: 503 } });
      throw Object.assign(new Error("Invalid key " + process.env.GROQ_API_KEY), { response: { status: 401 } });
    });
    try {
      await assert.rejects(fixture.bot.generateGeminiReply("chat", "hi"), (error) => {
        assert.equal(error.groqFallback, true);
        assert.ok(error.geminiFailure);
        assert.match(fixture.bot.getSafeErrorReply(error), /Groq API key was rejected/);
        assert.doesNotMatch(fixture.bot.describeGeminiError(error), /gsk_test_fallback_secret/);
        return true;
      });
      assert.deepEqual(fixture.bot.readChatHistory(), {});
    } finally { fixture.cleanup(); }
  });
});

test("Groq Whisper transcribes voice when Gemini voice understanding fails, then answers via Groq chat", async () => {
  await withKeys(async () => {
    const originalFetch = globalThis.fetch;
    const captures = [];
    globalThis.fetch = async (url, options) => {
      captures.push({ url, options });
      assert.equal(options.body.get("model"), "whisper-large-v3-turbo");
      assert.equal(options.body.get("file").name, "voice.ogg");
      return { ok: true, json: async () => ({ text: "What is the weather?" }) };
    };
    const fixture = makeBot(async (url) => {
      if (url.includes("generativelanguage")) throw Object.assign(new Error("Unavailable"), { response: { status: 503 } });
      return { data: { choices: [{ message: { content: "I cannot see live weather." } }] } };
    });
    try {
      const answer = await fixture.bot.generateVoiceAnswer("chat-a", Buffer.from("fake-ogg"), "audio/ogg");
      assert.equal(answer, "I cannot see live weather.");
      assert.equal(captures.length, 1);
      assert.equal(captures[0].url, "https://api.groq.com/openai/v1/audio/transcriptions");
      assert.equal(captures[0].options.headers.Authorization, "Bearer " + process.env.GROQ_API_KEY);
      assert.equal(fixture.requests.length, 2);
      assert.equal(fixture.requests[1][1].messages.at(-1).content, "What is the weather?");
      assert.match(fixture.requests[1][1].messages[0].content, /natural/);
      assert.deepEqual(fixture.bot.readChatHistory()["chat-a"].map((r) => r.content),
        ["What is the weather?", "I cannot see live weather."]);
    } finally {
      fixture.cleanup();
      globalThis.fetch = originalFetch;
    }
  });
});

test("Groq transcription failure does not invent a reply or modify history", async () => {
  await withKeys(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 429 });
    const fixture = makeBot(async (url) => {
      if (url.includes("generativelanguage")) throw new Error("network");
      throw new Error("unexpected Groq chat");
    });
    try {
      await assert.rejects(fixture.bot.generateVoiceAnswer("chat-b", Buffer.from("audio"), "audio/ogg"), (e) => {
        assert.equal(e.groqFallback, true);
        assert.equal(e.response.status, 429);
        return true;
      });
      assert.deepEqual(fixture.bot.readChatHistory(), {});
    } finally {
      fixture.cleanup();
      globalThis.fetch = originalFetch;
    }
  });
});
