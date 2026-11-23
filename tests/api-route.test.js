"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

function setupRoute(available = [
  { id: "gemini-3.5-flash" },
  { id: "gemini-3.8-flash" },
  { id: "gemini-3.8-flash-image", supported_endpoints: ["image-generation"] },
]) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kami-route-"));
  for (const file of ["kami.js", "api-route.js", "custom_prompt.txt"]) {
    fs.copyFileSync(path.join(__dirname, "..", file), path.join(tempDir, file));
  }
  const calls = [];
  const axiosStub = {
    get: async (...args) => {
      calls.push({ type: "get", args });
      return { data: { object: "list", data: available } };
    },
    post: async (...args) => {
      calls.push({ type: "post", args });
      return { data: { choices: [{ message: { content: "API Route answer" } }] } };
    },
  };
  const priorLoad = Module._load;
  Module._load = function (request, ...args) {
    if (request === "axios") return axiosStub;
    return priorLoad.call(this, request, ...args);
  };
  let provider, bot;
  try {
    provider = require(path.join(tempDir, "api-route.js"));
    bot = require(path.join(tempDir, "kami.js"));
  } finally {
    Module._load = priorLoad;
  }
  return {
    provider, bot, calls, tempDir,
    cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
  };
}

async function withKey(run) {
  const before = {
    API_ROUTE_KEY: process.env.API_ROUTE_KEY,
    API_ROUTE_MODEL: process.env.API_ROUTE_MODEL,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  };
  process.env.API_ROUTE_KEY = "sk-very-secret-test-route-key";
  delete process.env.API_ROUTE_MODEL;
  delete process.env.GEMINI_API_KEY;
  try { await run(); } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("API Route lists only key-visible model IDs and marks non-chat models", async () => {
  await withKey(async () => {
    const fixture = setupRoute();
    try {
      const models = await fixture.provider.listAvailableModels();
      assert.deepEqual(models.map((m) => m.id), [
        "gemini-3.5-flash", "gemini-3.8-flash", "gemini-3.8-flash-image",
      ]);
      assert.equal(models.at(-1).chat, false);
      await fixture.provider.listAvailableModels();
      assert.equal(fixture.calls.filter((call) => call.type === "get").length, 1);
      assert.equal(fixture.calls[0].args[0], "https://global.api-route.com/v1/models");
      assert.equal(fixture.calls[0].args[1].headers.Authorization, "Bearer " + process.env.API_ROUTE_KEY);
      const output = await fixture.provider.runModelCommand("chat@s.whatsapp.net", "/models");
      assert.match(output, /gemini-3\.8-flash-image \[non-chat\]/);
      assert.doesNotMatch(output, /sk-very-secret/);
    } finally { fixture.cleanup(); }
  });
});

test("model switch is validated against key permissions and persists per chat", async () => {
  await withKey(async () => {
    const fixture = setupRoute();
    try {
      assert.match(await fixture.provider.runModelCommand("chat1", "/model not-allowed"), /not listed/);
      assert.match(await fixture.provider.runModelCommand("chat1", "/model gemini-3.8-flash-image"), /does not support/);
      assert.match(await fixture.provider.runModelCommand("chat1", "/model gemini-3.8-flash"), /gemini-3.8-flash/);
      assert.equal(await fixture.provider.resolveChatModel("chat1"), "gemini-3.8-flash");
      assert.equal(await fixture.provider.resolveChatModel("chat2"), "gemini-3.5-flash");
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixture.tempDir, "api_route_models.json"), "utf8")), {
        chat1: "gemini-3.8-flash",
      });
      assert.match(await fixture.provider.runModelCommand("chat1", "/model reset"), /cleared/);
      assert.equal(await fixture.provider.resolveChatModel("chat1"), "gemini-3.5-flash");
    } finally { fixture.cleanup(); }
  });
});

test("auto replies route to selected API Route model while retaining prompt and history", async () => {
  await withKey(async () => {
    const fixture = setupRoute();
    try {
      assert.equal(await fixture.bot.generateGeminiReply("chat1", "Hello"), "API Route answer");
      await fixture.provider.runModelCommand("chat1", "/model gemini-3.8-flash");
      assert.equal(await fixture.bot.generateGeminiReply("chat1", "Follow-up"), "API Route answer");
      const requests = fixture.calls.filter((call) => call.type === "post").map(({ args }) => args);
      assert.equal(requests.length, 2);
      assert.equal(requests[0][0], "https://global.api-route.com/v1/chat/completions");
      assert.equal(requests[0][1].model, "gemini-3.5-flash");
      assert.equal(requests[1][1].model, "gemini-3.8-flash");
      assert.deepEqual(requests[1][1].messages.map((m) => m.role), [
        "system", "user", "assistant", "user",
      ]);
      assert.equal(requests[1][2].headers.Authorization, "Bearer " + process.env.API_ROUTE_KEY);
      assert.match(requests[0][1].messages[0].content, /Kamran Hasil/);
      assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.tempDir, "chat_history.json"), "utf8")).chat1.length, 4);
    } finally { fixture.cleanup(); }
  });
});

test("route key never appears in safe errors; invalid key configuration is rejected", async () => {
  await withKey(async () => {
    const fixture = setupRoute();
    try {
      const secret = process.env.API_ROUTE_KEY;
      const error = { apiRoute: true, message: "request failed with " + secret, response: { status: 403 } };
      assert.match(fixture.bot.describeGeminiError(error), /REDACTED/);
      assert.doesNotMatch(fixture.bot.describeGeminiError(error), /sk-very-secret/);
      assert.match(fixture.bot.getSafeErrorReply(error), /API Route denied access/);
      assert.doesNotMatch(fixture.bot.getSafeErrorReply(error), /sk-very-secret/);
      assert.deepEqual(fixture.provider.validateModels({ data: [{ id: "abc" }, { id: "abc" }, { id: "../../oops" }] }),
        [{ id: "../../oops", chat: true }, { id: "abc", chat: true }]);
    } finally { fixture.cleanup(); }
  });
});

test("models command uses page numbers for large permitted lists", async () => {
  await withKey(async () => {
    const fixture = setupRoute(Array.from({ length: 25 }, (_, i) => ({ id: "gemini-chat-" + String(i).padStart(2, "0") })));
    try {
      assert.match(await fixture.provider.runModelCommand("chat", "/models 2"), /page 2\/2/);
      assert.match(await fixture.provider.runModelCommand("chat", "/models 99"), /Invalid page/);
    } finally { fixture.cleanup(); }
  });
});
