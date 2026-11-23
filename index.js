"use strict";

const BOT_NAME = "KAMI AI CHAT BOT";
const OWNER_NAME = "Kamran Hasil";
const OWNER_PHONE = "923395267262";
const SESSION_NAME = "kami-ai-session";

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} = require("@adiwajshing/baileys");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const {
  extractIncomingText, generateGeminiReply, splitReply, getSafeErrorReply,
  describeGeminiError, transcribeVoiceNote, synthesizeVoiceReply, getSpeechText,
} = require("./kami");
const { extractIncomingVoiceNote, validateVoiceNote, wavToWhatsAppVoiceNote } = require("./voice");

async function startKamiBot() {
  const { state, saveCreds } = await useMultiFileAuthState(`./${SESSION_NAME}`);
  const { version } = await fetchLatestBaileysVersion();
  const client = makeWASocket({
    logger: pino({ level: "silent" }),
    browser: [BOT_NAME, "Chrome", "120.0.0"],
    version,
    auth: state,
  });

  // Responses are serialized per chat to keep conversation history in order.
  const pendingChats = new Map();
  // Prevent a repeated event from producing duplicate replies; bound memory usage.
  const recentMessages = new Set();

  client.ev.on("messages.upsert", (chatUpdate) => {
    // "append" is old chat history being synchronized, not a new message.
    if (chatUpdate.type && chatUpdate.type !== "notify") return;
    for (const message of chatUpdate.messages || []) {
      const jid = message.key?.remoteJid;
      if (!jid || !message.message || message.key?.fromMe) continue;
      if (jid === "status@broadcast" || jid.endsWith("@broadcast") || jid.endsWith("@newsletter")) continue;

      const text = extractIncomingText(message.message);
      const voiceNote = extractIncomingVoiceNote(message.message);
      if (!text && !voiceNote) continue;

      const messageId = message.key?.id;
      if (messageId) {
        const identifier = `${jid}:${messageId}`;
        if (recentMessages.has(identifier)) continue;
        recentMessages.add(identifier);
        if (recentMessages.size > 1000) recentMessages.delete(recentMessages.values().next().value);
      }

      const previous = pendingChats.get(jid) || Promise.resolve();
      const task = previous.catch(() => {}).then(async () => {
        try {
          let hasNotifiedRetry = false;
          const onRetry = async (retryError) => {
            console.warn("Gemini request failed temporarily; retrying:", describeGeminiError(retryError));
            if (hasNotifiedRetry) return;
            hasNotifiedRetry = true;
            await client.sendMessage(
              jid,
              { text: "🔄 Updating, please wait... I'm retrying your message." },
              { quoted: message }
            );
          };

          if (voiceNote) {
            const mimeType = validateVoiceNote(voiceNote);
            // Keep media in memory, with Baileys handling expired media re-uploads.
            const audio = await downloadMediaMessage(
              message, "buffer", {},
              { logger: pino({ level: "silent" }), reuploadRequest: client.updateMediaMessage }
            );
            const transcript = await transcribeVoiceNote(audio, mimeType, { onRetry });
            const answer = await generateGeminiReply(jid, transcript, { onRetry, voiceReply: true });

            try {
              const wav = await synthesizeVoiceReply(answer, { onRetry });
              const ogg = await wavToWhatsAppVoiceNote(wav);
              await client.sendMessage(
                jid,
                { audio: ogg, ptt: true, mimetype: "audio/ogg; codecs=opus" },
                { quoted: message }
              );
              // A long answer is spoken in shortened form; send full details as text.
              if (getSpeechText(answer).length < answer.trim().length) {
                for (const chunk of splitReply(answer)) {
                  await client.sendMessage(jid, { text: chunk }, { quoted: message });
                }
              }
            } catch (voiceError) {
              console.error("Voice reply failed; falling back to text:", describeGeminiError(voiceError));
              for (const chunk of splitReply("🔊 Voice reply is unavailable right now. Here's the text answer:\n" + answer)) {
                await client.sendMessage(jid, { text: chunk }, { quoted: message });
              }
            }
          } else {
            // Keep automatic text replies unchanged.
            const answer = await generateGeminiReply(jid, text, { onRetry });
            for (const chunk of splitReply(answer)) {
              await client.sendMessage(jid, { text: chunk }, { quoted: message });
            }
          }
        } catch (error) {
          console.error("Gemini auto-reply failed:", describeGeminiError(error));
          try {
            await client.sendMessage(jid, { text: getSafeErrorReply(error) }, { quoted: message });
          } catch (sendError) {
            console.error("Could not send error reply:", sendError.message);
          }
        }
      });
      pendingChats.set(jid, task);
      void task.finally(() => {
        if (pendingChats.get(jid) === task) pendingChats.delete(jid);
      });
    }
  });

  client.ev.on("creds.update", saveCreds);
  client.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("Scan this QR code in WhatsApp > Linked Devices:");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      console.log(`${BOT_NAME} connected. Owner: ${OWNER_NAME}, WhatsApp: +${OWNER_PHONE}`);
      try {
        await client.sendMessage(`${OWNER_PHONE}@s.whatsapp.net`, {
          text: `${BOT_NAME} started!\nOwner: ${OWNER_NAME}\nWhatsApp: +${OWNER_PHONE}\nAuto-reply: ON (all incoming text)`,
        });
      } catch (error) {
        console.error("Unable to send startup notification:", error.message);
      }
    }
    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if ([DisconnectReason.loggedOut, DisconnectReason.badSession, DisconnectReason.connectionReplaced].includes(reason)) {
        console.error("Session ended or replaced. Please log in again if necessary.");
        return;
      }
      console.log("WhatsApp connection closed. Reconnecting...");
      setTimeout(() => startKamiBot().catch(console.error), 2000);
    }
  });
  return client;
}

if (require.main === module) startKamiBot().catch(console.error);
module.exports = { startKamiBot };
