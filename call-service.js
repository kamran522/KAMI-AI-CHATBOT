"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const { streamCallAnswer } = require("./call-agent");

const MAX_WEBHOOK_BYTES = 16384;
const MAX_TURN_CHARS = 1200;
const MAX_TURNS = 12;

function validateTwilioSignature(token, url, signature, params = {}) {
  if (!token || !signature || !url) return false;
  const signed = url + Object.keys(params).sort()
    .map((key) => key + String(params[key])).join("");
  const expected = crypto.createHmac("sha1", token).update(signed, "utf8").digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function getCallConfig(env = process.env) {
  const baseUrl = String(env.CALL_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  const accountSid = String(env.TWILIO_ACCOUNT_SID || "");
  const token = String(env.TWILIO_AUTH_TOKEN || "");
  if (!/^https:\/\/[^/?#]+$/i.test(baseUrl) || !token || !/^AC[a-f0-9]{32}$/i.test(accountSid)) {
    throw new Error("Configure CALL_PUBLIC_BASE_URL (https), TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN for call service");
  }
  const language = String(env.CALL_LANGUAGE || "en-US");
  if (!/^[a-z]{2,3}-[A-Z]{2}$/.test(language)) throw new Error("Invalid CALL_LANGUAGE locale");
  const port = Number(env.CALL_PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid CALL_PORT");
  return { baseUrl, accountSid, token, language, port, host: env.CALL_HOST || "127.0.0.1" };
}

function xmlEscape(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function incomingCallTwiml(config) {
  const wsUrl = config.baseUrl.replace(/^https:\/\//, "wss://") + "/calls/relay";
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response><Connect><ConversationRelay url="' + xmlEscape(wsUrl) +
    '" language="' + xmlEscape(config.language) +
    '" transcriptionProvider="google" ttsProvider="google"' +
    ' interruptible="true" speechTimeout="700"' +
    ' welcomeGreeting="Hello, I am KAMI AI, an AI assistant. How can I help you?"' +
    '/></Connect></Response>';
}

function sendText(ws, text, last) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify({
    type: "text",
    token: text,
    last,
    interruptible: true,
    preemptible: true,
  }));
}

// Logic is separated from the transport so tests can simulate real prompts,
// interruptions and provider errors without any paid calls.
function attachCallSession(ws, {
  accountSid,
  streamReply = streamCallAnswer,
  logger = console,
} = {}) {
  let ready = false;
  let active = null;
  let turnNumber = 0;
  let callHistory = [];

  function cancel() {
    turnNumber++;
    if (active) active.abort();
    active = null;
  }

  async function answerPrompt(utterance) {
    cancel();
    const generation = turnNumber;
    const controller = new AbortController();
    active = controller;
    const question = utterance.trim().slice(0, MAX_TURN_CHARS);
    if (!question) return;
    const history = [...callHistory, { role: "user", content: question }];
    let answer = "";
    try {
      for await (const token of streamReply(history, { signal: controller.signal })) {
        if (generation !== turnNumber || ws.readyState !== 1) return;
        answer += token;
        if (answer.length > 3000) throw new Error("Call answer exceeded safe size");
        // Twilio synthesizes speech incrementally rather than waiting for Gemini.
        sendText(ws, token, false);
      }
      if (generation !== turnNumber || ws.readyState !== 1) return;
      if (!answer.trim()) throw new Error("Gemini returned an empty call answer");
      sendText(ws, "", true);
      callHistory = [...history, { role: "assistant", content: answer }].slice(-MAX_TURNS);
    } catch (error) {
      if (generation !== turnNumber || controller.signal.aborted) return;
      logger.warn("Live call answer failed:", error.status || error.code || error.message);
      sendText(ws, answer ? " Sorry, the connection is having trouble." :
        "Sorry, I am having trouble answering right now. Please try again.", true);
    } finally {
      if (generation === turnNumber) active = null;
    }
  }

  function onMessage(raw) {
    let event;
    try {
      event = JSON.parse(String(raw));
    } catch {
      ws.close(1003, "Invalid payload");
      return;
    }

    if (!ready) {
      if (event.type !== "setup" || event.accountSid !== accountSid ||
          typeof event.callSid !== "string" || !/^CA[a-f0-9]{32}$/i.test(event.callSid)) {
        ws.close(1008, "Invalid call setup");
        return;
      }
      ready = true;
      return;
    }
    if (event.type === "interrupt") {
      cancel();
      return;
    }
    if (event.type === "prompt" && event.last === true &&
        typeof event.voicePrompt === "string") {
      void answerPrompt(event.voicePrompt);
    }
    if (event.type === "error") {
      logger.warn("ConversationRelay returned a session error");
    }
  }

  ws.on("message", onMessage);
  ws.on("close", cancel);
  ws.on("error", cancel);
  return { cancel, onMessage };
}

function createCallServer(config = getCallConfig(), { streamReply, logger = console } = {}) {
  // This server is only for a Business Calling sender connected to Twilio.
  // The existing Linked Devices/Baileys bot cannot answer live phone calls.
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.method !== "POST" || req.url !== "/calls/incoming") {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString("utf8");
      if (Buffer.byteLength(body) > MAX_WEBHOOK_BYTES) req.destroy();
    });
    req.on("end", () => {
      const params = Object.fromEntries(new URLSearchParams(body));
      const signature = req.headers["x-twilio-signature"];
      const url = config.baseUrl + "/calls/incoming";
      if (params.AccountSid !== config.accountSid ||
          !validateTwilioSignature(config.token, url, signature, params)) {
        res.writeHead(403);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
      res.end(incomingCallTwiml(config));
    });
  });

  // Load ws only when this optional call service starts.
  const { WebSocketServer } = require("ws");
  const websocket = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/calls/relay" ||
        !validateTwilioSignature(
          config.token,
          config.baseUrl.replace(/^https:\/\//, "wss://") + "/calls/relay",
          req.headers["x-twilio-signature"]
        )) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    websocket.handleUpgrade(req, socket, head, (ws) => {
      websocket.emit("connection", ws, req);
    });
  });
  websocket.on("connection", (ws) => {
    attachCallSession(ws, { accountSid: config.accountSid, streamReply, logger });
  });
  return server;
}

if (require.main === module) {
  try {
    const config = getCallConfig();
    createCallServer(config).listen(config.port, config.host, () => {
      console.log("Optional Twilio call service listening on " + config.host + ":" + config.port);
    });
  } catch (error) {
    console.error("Call service could not start:", error.message);
    process.exitCode = 1;
  }
}

module.exports = { getCallConfig, validateTwilioSignature, incomingCallTwiml, attachCallSession, createCallServer };
