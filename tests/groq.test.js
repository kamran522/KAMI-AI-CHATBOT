"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

function makeBot(post, get) {
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
    },
      get: (...params) => {
        requests.push(params);
        if (!get) throw new Error("No Groq model listing was expected");
        return get(...params);
      },
    };
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

test("Groq succeeds without contacting Gemini and preserves history", async () => {
  await withKeys(async () => {
    const f = makeBot(async url => {
      assert.match(url, /api.groq.com/);
      return { data: { choices: [{ message: { content: "Groq answer" } }] } };
    });
    try {
      assert.equal(await f.bot.generateGeminiReply("chat", "Hi"), "Groq answer");
      assert.equal(f.requests.length, 1);
      assert.deepEqual(f.bot.readChatHistory().chat.map(r => r.content), ["Hi", "Groq answer"]);
    } finally { f.cleanup(); }
  });
});

for (const status of [401, 429, 503]) {
  test("Groq HTTP " + status + " falls back to Gemini", async () => {
    await withKeys(async () => {
      const f = makeBot(async url => {
        if (url.includes("api.groq.com")) throw Object.assign(new Error("Groq failure"), { response: { status } });
        return { data: { candidates: [{ content: { parts: [{ text: "Gemini answer" }] } }] } };
      });
      try {
        assert.equal(await f.bot.generateGeminiReply("chat", "Hi"), "Gemini answer");
        assert.equal(f.requests.length, 2);
        assert.match(f.requests[0][0], /api.groq.com/);
        assert.match(f.requests[1][0], /generativelanguage/);
      } finally { f.cleanup(); }
    });
  });
}

test("Both providers failing leaves history unchanged", async () => {
  await withKeys(async () => {
    const f = makeBot(async () => { throw new Error("network"); });
    try {
      await assert.rejects(f.bot.generateGeminiReply("chat", "Hi"), e => Boolean(e.groqFailure));
      assert.deepEqual(f.bot.readChatHistory(), {});
    } finally { f.cleanup(); }
  });
});

test("Groq transcribes voice and answers without Gemini", async () => {
  await withKeys(async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ text: "Hello" }) });
    const f = makeBot(async url => {
      assert.match(url, /api.groq.com/);
      return { data: { choices: [{ message: { content: "Hi" } }] } };
    });
    try {
      assert.equal(await f.bot.generateVoiceAnswer("chat", Buffer.from("audio"), "audio/ogg"), "Hi");
      assert.equal(f.requests.length, 1);
    } finally { f.cleanup(); globalThis.fetch = original; }
  });
});

test("Groq transcription failure falls back to Gemini audio", async () => {
  await withKeys(async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 429 });
    const f = makeBot(async url => {
      assert.match(url, /generativelanguage/);
      return { data: { candidates: [{ content: { parts: [{ text: JSON.stringify({ transcript: "Hello", answer: "Hi" }) }] } }] } };
    });
    try {
      assert.equal(await f.bot.generateVoiceAnswer("chat", Buffer.from("audio"), "audio/ogg"), "Hi");
      assert.equal(f.requests.length, 1);
    } finally { f.cleanup(); globalThis.fetch = original; }
  });
});

test("Groq 404 on default model lists permitted models and switches to a working replacement", async () => {
  await withKeys(async () => {
    const fixture = makeBot(async (url, body) => {
      if (url.includes("generativelanguage")) {
        throw Object.assign(new Error("Gemini unavailable"), { response: { status: 503 } });
      }
      if (body.model === "openai/gpt-oss-120b") {
        throw Object.assign(new Error("Model unavailable"), { response: { status: 404 } });
      }
      assert.equal(body.model, "openai/gpt-oss-20b");
      return { data: { choices: [{ message: { content: "Groq replacement answer" } }] } };
    }, async (url, config) => {
      assert.equal(url, "https://api.groq.com/openai/v1/models");
      assert.equal(config.headers.Authorization, "Bearer " + process.env.GROQ_API_KEY);
      return { data: { data: [
        { id: "whisper-large-v3-turbo" },
        { id: "openai/gpt-oss-120b" },
        { id: "openai/gpt-oss-20b" },
      ] } };
    });
    try {
      assert.equal(await fixture.bot.generateGeminiReply("chat", "Hello"), "Groq replacement answer");
      const firstCalls = fixture.requests.slice();
      assert.equal(firstCalls.filter((x) => x[0].endsWith("/models")).length, 1);
      assert.equal(firstCalls.filter((x) => x[0].endsWith("/chat/completions")).length, 2);
      assert.equal(await fixture.bot.generateGeminiReply("chat", "Next"), "Groq replacement answer");
      // The new default is cached in the module and avoids repeated 404s/list requests.
      assert.equal(fixture.requests.filter((x) => x[0].endsWith("/models")).length, 1);
      assert.equal(fixture.requests.filter((x) => x[0].endsWith("/chat/completions")).length, 3);
    } finally { fixture.cleanup(); }
  });
});

test("explicit GROQ_MODEL is not silently overridden when that model is rejected", async () => {
  await withKeys(async () => {
    process.env.GROQ_MODEL = "invalid-manual-model";
    const fixture = makeBot(async (url) => {
      if (url.includes("generativelanguage")) throw new Error("Gemini failed");
      throw Object.assign(new Error("Unknown model"), { response: { status: 404 } });
    });
    try {
      await assert.rejects(fixture.bot.generateGeminiReply("chat", "Hello"),
        (error) => error.groqFailure?.response?.status === 404);
      assert.equal(fixture.requests.length, 2);
    } finally { fixture.cleanup(); }
  });
});


