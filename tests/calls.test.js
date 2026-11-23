"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const {
  getCallConfig, validateTwilioSignature, incomingCallTwiml,
  attachCallSession, createCallServer,
} = require("../call-service");
const { streamCallAnswer, parseSseEvent } = require("../call-agent");

const SID = "AC" + "a".repeat(32);
const TOKEN = "test-auth-token";
const BASE = "https://example.test";

function signature(url, params = {}) {
  return crypto.createHmac("sha1", TOKEN).update(
    url + Object.keys(params).sort().map((key) => key + params[key]).join("")
  ).digest("base64");
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function fakeWs() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.sent = [];
  ws.send = (data) => ws.sent.push(JSON.parse(data));
  ws.close = (code) => { ws.closeCode = code; ws.readyState = 3; };
  return ws;
}

test("Twilio webhook and WebSocket signatures reject incorrect credentials", () => {
  const params = { From: "whatsapp:+123", AccountSid: SID, CallSid: "CA" + "b".repeat(32) };
  const url = BASE + "/calls/incoming";
  const sig = signature(url, params);
  assert.equal(validateTwilioSignature(TOKEN, url, sig, params), true);
  assert.equal(validateTwilioSignature(TOKEN, url, sig, { ...params, From: "not signed" }), false);
  assert.equal(validateTwilioSignature(TOKEN, url, "wrong", params), false);
  assert.equal(validateTwilioSignature(TOKEN, url, "", params), false);

  const config = getCallConfig({
    CALL_PUBLIC_BASE_URL: BASE + "/",
    TWILIO_ACCOUNT_SID: SID,
    TWILIO_AUTH_TOKEN: TOKEN,
    CALL_PORT: "3999",
  });
  assert.equal(config.port, 3999);
  assert.match(incomingCallTwiml(config), /ConversationRelay/);
  assert.match(incomingCallTwiml(config), /wss:\/\/example\.test\/calls\/relay/);
  assert.throws(() => getCallConfig({ TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN }), /CALL_PUBLIC_BASE_URL/);
});

test("call session streams text tokens to Twilio and remembers speech across turns", async () => {
  const ws = fakeWs();
  const prompts = [];
  attachCallSession(ws, { accountSid: SID, streamReply: async function* (history) {
    prompts.push(history);
    yield "Hello";
    yield " there.";
  } });
  ws.emit("message", JSON.stringify({ type: "setup", accountSid: SID, callSid: "CA" + "b".repeat(32) }));
  ws.emit("message", JSON.stringify({ type: "prompt", voicePrompt: "Hello bot", last: false }));
  await flush();
  assert.equal(ws.sent.length, 0);
  ws.emit("message", JSON.stringify({ type: "prompt", voicePrompt: "Hello bot", last: true }));
  await flush();
  assert.deepEqual(ws.sent.map((m) => [m.token, m.last]), [
    ["Hello", false], [" there.", false], ["", true],
  ]);
  ws.emit("message", JSON.stringify({ type: "prompt", voicePrompt: "Second question", last: true }));
  await flush();
  assert.deepEqual(prompts[1].map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(prompts[1][1].content, "Hello there.");
});

test("invalid call setup is closed and caller interruptions cancel previous answer", async () => {
  const bad = fakeWs();
  attachCallSession(bad, { accountSid: SID, streamReply: async function* () {} });
  bad.emit("message", JSON.stringify({ type: "setup", accountSid: SID, callSid: "fake" }));
  assert.equal(bad.closeCode, 1008);

  const ws = fakeWs();
  const controllers = [];
  attachCallSession(ws, { accountSid: SID, streamReply: async function* (history, { signal }) {
    controllers.push(signal);
    if (history.at(-1).content === "First") {
      yield "partial";
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      yield "should never be spoken";
    } else {
      yield "second";
    }
  } });
  ws.emit("message", JSON.stringify({ type: "setup", accountSid: SID, callSid: "CA" + "b".repeat(32) }));
  ws.emit("message", JSON.stringify({ type: "prompt", voicePrompt: "First", last: true }));
  await flush();
  ws.emit("message", JSON.stringify({ type: "interrupt", utteranceUntilInterrupt: "part" }));
  ws.emit("message", JSON.stringify({ type: "prompt", voicePrompt: "Second", last: true }));
  await flush();
  assert.equal(controllers[0].aborted, true);
  assert.deepEqual(ws.sent.map((x) => x.token), ["partial", "second", ""]);
});

test("call transport rejects unsigned hooks and accepts a verified incoming call", async () => {
  const config = getCallConfig({
    CALL_PUBLIC_BASE_URL: BASE,
    TWILIO_AUTH_TOKEN: TOKEN,
    TWILIO_ACCOUNT_SID: SID,
  });
  const server = createCallServer(config, { streamReply: async function* () { yield "hi"; } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const params = { AccountSid: SID, CallSid: "CA" + "b".repeat(32) };
  try {
    const uri = "http://127.0.0.1:" + port + "/calls/incoming";
    const denied = await fetch(uri, { method: "POST", body: new URLSearchParams(params) });
    assert.equal(denied.status, 403);
    const approved = await fetch(uri, {
      method: "POST",
      body: new URLSearchParams(params),
      headers: { "X-Twilio-Signature": signature(BASE + "/calls/incoming", params) },
    });
    assert.equal(approved.status, 200);
    assert.match(await approved.text(), /ConversationRelay/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Gemini server events parse and stream into short text fragments", async () => {
  const original = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "fake-key";
  try {
    const payload1 = JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hello" }] } }] });
    const payload2 = JSON.stringify({ candidates: [{ content: { parts: [{ text: " world." }] } }] });
    assert.equal(parseSseEvent("data: " + payload1), "Hello");
    const stream = (async function* () {
      yield Buffer.from("data: " + payload1 + "\n\n" + "data: " + payload2.slice(0, 16));
      yield Buffer.from(payload2.slice(16) + "\n\n");
    })();
    const args = [];
    const answer = [];
    for await (const chunk of streamCallAnswer(
      [{ role: "user", content: "Hi" }],
      { fetchImpl: async (url, options) => {
        args.push({ url, options });
        return { ok: true, body: stream };
      } }
    )) answer.push(chunk);
    assert.deepEqual(answer, ["Hello", " world."]);
    assert.ok(args[0].url.includes("streamGenerateContent?alt=sse"));
    assert.equal(args[0].options.headers["x-goog-api-key"], "fake-key");
  } finally {
    if (original === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = original;
  }
});
