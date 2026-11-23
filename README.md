# KAMI AI CHAT BOT

A WhatsApp auto-reply bot powered by Google Gemini and Baileys. Incoming text messages receive text answers and incoming WhatsApp voice notes receive spoken answers automatically—no `!ai`, `/ai`, or other command is required.

**Creator:** Kamran Hasil  
**WhatsApp:** +92 339 5267262  
**Email:** kamranhasilbaloch@gmail.com

## Features

- Automatic replies to incoming WhatsApp text in private chats and groups
- Faster WhatsApp voice-note replies: one Gemini audio request understands the note and drafts its response; a second request generates the voice (OGG/Opus)
- Optional auto-answering WhatsApp Business Calling integration using Twilio ConversationRelay (separate from Baileys/Linked Devices)
- Keeps conversation context between voice notes and text; text answers are used as a fallback if speech synthesis fails
- Google Gemini integration and a custom bot personality/prompt
- Recent conversation context per chat
- WhatsApp QR-code pairing
- Gemini connection diagnostics via `npm run check:gemini`
- Automatic retry notifications: the bot says “🔄 Updating, please wait...” when Gemini has a temporary outage
- Clearer final error messages and server-side diagnostic details

> **Note:** The prompt contains examples of searches, appointments, and reminders. Those actions are not standalone integrations in this repository. Automatic replies require a working Gemini API key, internet connection, and a connected WhatsApp session.

## Requirements

- Linux server (the commands below use Ubuntu/Debian conventions)
- Node.js **18 or newer** and npm
- Git
- Google Gemini API key
- A WhatsApp account to link as a device
- **FFmpeg with libopus support** for outgoing WhatsApp voice-note encoding (`sudo apt-get install -y ffmpeg`)

## Installation

Connect to your server over SSH and run:

```bash
git clone https://github.com/kamran522/KAMI-AI-CHATBOT.git
cd KAMI-AI-CHATBOT
node --version
npm --version
npm install
```

Create `key.json` in the project directory with your own Gemini API key. Do **not** commit or share it:

```json
{
  "geminiApiKey": "YOUR_GEMINI_API_KEY"
}
```

Protect the key file:

```bash
chmod 600 key.json
```

The default model is `gemini-3.5-flash-lite`. Test Gemini access before launching WhatsApp:

```bash
npm run check:gemini
```

If needed, select a different model for a single command:

```bash
GEMINI_MODEL=gemini-3.5-flash-lite npm run check:gemini
```

## What happens when Gemini fails

When Gemini returns a temporary HTTP 429, HTTP 5xx, timeout, or certain network errors, the bot sends a **“🔄 Updating, please wait...”** WhatsApp message (once per incoming request) and retries up to **two additional times**, using backoff and honoring short `Retry-After` delays. If a retry succeeds, the normal AI answer follows.

If the retries fail, or the error is permanent (invalid key, unavailable model, billing issue), the bot sends an error message starting with **“🔄 Updating, please wait...”** and including a short explanation. Permanent errors **are not fixed automatically**. Check the server logs and correct the cause before expecting normal responses. The bot does not endlessly retry and does not automatically resend a failed question after its retries are exhausted.

Run `npm test` to check the bot’s message handling and retry behavior without a live Gemini API key. Run `npm run check:gemini` on the server with a real key to determine whether Gemini access works.

## Voice-note replies

Voice notes sent to the bot (WhatsApp push-to-talk audio, including disappearing voice notes) are processed automatically in private chats and groups. Audio files sent as attachments are not processed as voice notes.

1. The bot downloads an incoming voice note in memory. **One Gemini request** transcribes it and produces the conversational answer in the user's language (previously two requests).
2. The transcript and answer enter the existing conversation context.
3. Gemini Text-to-Speech speaks a concise response (450-character maximum). FFmpeg converts its WAV output to OGG/Opus, and Baileys sends it with `ptt: true` so WhatsApp displays a voice message.
4. If speech synthesis or FFmpeg fails, the bot sends the **text answer** instead. If transcription fails, it sends a short error message. Large notes (over **8 MB** or **3 minutes**) are rejected.

Install FFmpeg on the Linux server before starting the bot:

```bash
sudo apt-get update
sudo apt-get install -y ffmpeg
ffmpeg -encoders | grep libopus
```

The existing `GEMINI_API_KEY` or `key.json` is reused. Optional environment variables:

| Variable | Default | Use |
| --- | --- | --- |
| `GEMINI_AUDIO_MODEL` | `GEMINI_MODEL` / `gemini-3.5-flash-lite` | Audio transcription |
| `GEMINI_TTS_MODEL` | `gemini-3.8-flash-lite-tts` | Speech synthesis via Gemini Interactions API |
| `GEMINI_TTS_VOICE` | `Kore` | Synthetic voice |

Voice synthesis defaults to a 14-second deadline, after which the bot returns the text answer instead of continuing long TTS retries. Adjust with `VOICE_TTS_TIMEOUT_MS` (milliseconds, allowed range 3000–60000). This is an upper bound on the **TTS request**, not a total response-time guarantee.

The selected models must be available to your Gemini API key. Voice recognition and TTS each make an additional Gemini API request and can use quota or paid credits. The existing `npm run check:gemini` command tests text generation only; it does not verify TTS model access.

**Privacy:** Incoming voice-note bytes are sent to Google's Gemini API for transcription and processed in memory rather than stored locally. The resulting transcript is saved in the same `chat_history.json` file used for text conversations. Use this bot only where participants understand voice notes will be processed by Gemini.

**Limitations:** Voice notes are limited to 8 MB and 3 minutes. Long answers are spoken in shortened form and followed by the full text. Actual voice synthesis depends on the external Gemini TTS model; it cannot be guaranteed offline.

## Optional: Answer live WhatsApp Business calls with KAMI AI

**This feature is NOT supported by the current WhatsApp Linked Devices/Baileys session.** It uses a **separate** Twilio Programmable Voice and WhatsApp Business Calling integration. Your WhatsApp sender must be enabled for Business Calling through Twilio/Meta. You may need to migrate the number to the Business Platform; verify compatibility before changing or disconnecting your existing WhatsApp bot. Installing this repository by itself **will not** make personal WhatsApp calls auto-answer.

For qualifying numbers, Twilio sends incoming WhatsApp calls to a Voice webhook. KAMI answers with a ConversationRelay session: Twilio handles live speech recognition and speech synthesis; Gemini **streams text tokens** to Twilio as they are generated. Callers can interrupt the AI and continue speaking, using short per-call conversation history in memory. This avoids waiting for a full Gemini speech file before the bot speaks.

### Prerequisites

- A Twilio account with a WhatsApp Business sender registered and enabled for voice calling
- Twilio ConversationRelay access and acceptance of Twilio's generative AI terms
- A publicly reachable HTTPS hostname with valid TLS; **both HTTPS and WSS** forwarded to the call service
- Node.js 18+ and `npm install`; your existing Gemini key, accessible to this process
- An HTTPS proxy (such as nginx) to `127.0.0.1:3001` with WebSocket upgrades enabled

### Configure

Set these variables securely in the call server's environment, **never** in the public repository:

| Name | Example or default | Purpose |
| --- | --- | --- |
| `TWILIO_ACCOUNT_SID` | `AC...` | The Twilio account that owns the sender |
| `TWILIO_AUTH_TOKEN` | Secret | Verifies signed Twilio webhook and WebSocket requests |
| `CALL_PUBLIC_BASE_URL` | `https://calls.example.com` | Public HTTPS origin, **without trailing path** |
| `CALL_PORT` | `3001` | Local HTTP/WebSocket port |
| `CALL_HOST` | `127.0.0.1` | Bind to localhost behind a TLS reverse proxy |
| `CALL_LANGUAGE` | `en-US` | Speech recognition and TTS locale supported by your Twilio setup |
| `GEMINI_CALL_MODEL` | `GEMINI_MODEL` (or the default model) | Fast streaming answer generation |
| `GEMINI_API_KEY` | Existing Gemini key | Used when `key.json` is not present |

The public endpoints are:

- **POST `https://calls.example.com/calls/incoming`** — signed Twilio Voice webhook that answers using TwiML.
- **WSS `wss://calls.example.com/calls/relay`** — signed real-time ConversationRelay WebSocket.
- **GET `/healthz`** — simple server health check.

Configure the voice-capable Twilio WhatsApp sender to use a TwiML app with the Voice URL `https://calls.example.com/calls/incoming` (HTTP POST). Configure your reverse proxy to forward both paths, preserve WebSocket upgrade headers, and terminate TLS. The service rejects unsigned requests; do not bypass this check. Twilio authentication uses the *public* URL when validating signatures, so `CALL_PUBLIC_BASE_URL` must exactly match the hostname used in Twilio.

Start the call service in a **separate process** only after configuration:

```bash
cd ~/KAMI-AI-CHATBOT
npm install
npm run start:calls
```

To run it under PM2 instead:

```bash
pm2 start call-service.js --name kami-ai-calls --time
pm2 save
```

This does not start or replace your existing `kami-ai-chat-bot` process. If you change environment variables, restart `kami-ai-calls` with `--update-env`. **Do not start the call service without the required Twilio credentials or enable it on a non-voice-capable sender.**

### Latency, costs and privacy

Live calls use Twilio's streaming speech services and Gemini text generation. This should respond sooner than the voice-note pipeline that creates an audio file, but speed depends on network, language, and provider capacity; it is not a guaranteed fixed delay. Twilio Business Calling and ConversationRelay can incur separate charges from Gemini.

Caller transcripts are processed by Twilio and Gemini and kept in this process's memory during the call (not written to `chat_history.json`). Provide an AI disclosure to callers and inform them about third-party voice processing. No call recording is enabled in this code.

For setup and eligibility, see the official [Twilio WhatsApp Business Calling guide](https://www.twilio.com/docs/voice/whatsapp-business-calling), [ConversationRelay setup](https://www.twilio.com/docs/voice/conversationrelay/onboarding), and [WebSocket message reference](https://www.twilio.com/docs/voice/conversationrelay/websocket-messages).

## Start the bot manually

```bash
npm start
```

If your WhatsApp account is not already linked, scan the terminal QR code using **WhatsApp → Linked devices → Link a device**.

Manual startup keeps the bot running only while the Node.js process is running. Use PM2 below for a long-running server deployment. Stop a manual instance with `Ctrl+C` **before** starting it through PM2 so two processes do not use the same WhatsApp session.

## Run the bot 24/7 with PM2 (recommended)

PM2 keeps the Node.js process running after you disconnect from SSH, automatically restarts it after a crash, and can restore it when the server reboots.

### 1. Install PM2

```bash
sudo npm install -g pm2
```

### 2. Start KAMI AI CHAT BOT

From your cloned repository directory:

```bash
cd ~/KAMI-AI-CHATBOT
pm2 start index.js --name kami-ai-chat-bot --time
```

The project uses `gemini-3.5-flash-lite` by default. To set it explicitly on first start, use:

```bash
GEMINI_MODEL=gemini-3.5-flash-lite pm2 start index.js --name kami-ai-chat-bot --time
```

Use **only one** of the two start commands above, not both.

### 3. Enable startup after reboot

```bash
pm2 startup
```

**Important:** PM2 prints a command beginning with `sudo env ...`. Copy and run that **exact command** on your server to register the startup service for your current Linux user.

Then save the running process list:

```bash
pm2 save
```

### 4. Check whether the bot is running

```bash
pm2 status
pm2 logs kami-ai-chat-bot --lines 100
```

Press `Ctrl+C` to stop *viewing the logs*; the PM2-managed bot keeps running.

### PM2 management commands

| Task | Command |
| --- | --- |
| Show running processes | `pm2 status` |
| Show live logs | `pm2 logs kami-ai-chat-bot` |
| Show last 100 log lines | `pm2 logs kami-ai-chat-bot --lines 100` |
| Restart the bot | `pm2 restart kami-ai-chat-bot` |
| Restart after changing environment variables | `pm2 restart kami-ai-chat-bot --update-env` |
| Stop the bot | `pm2 stop kami-ai-chat-bot` |
| Start a stopped bot | `pm2 start kami-ai-chat-bot` |
| Remove the bot from PM2 | `pm2 delete kami-ai-chat-bot` |
| Monitor CPU/memory | `pm2 monit` |
| Save process list after changes | `pm2 save` |

### Update the bot on the server

**Recommended:** Run the prompt-safe updater instead of a direct `git pull`:

```bash
bash ~/KAMI-AI-CHATBOT/scripts/update-bot.sh
```

This backs up your local `custom_prompt.txt` under `~/.kami-ai-backups/`, temporarily restores its committed version for `git pull --ff-only`, then restores your own prompt. It checks tests and Gemini connectivity before restarting PM2. It will not overwrite other modified tracked files. The GitHub repository also merges the owner's own pull requests after CI tests pass; external contributors' PRs still require review.

**One-time setup for existing installations with a blocked `git pull`:** First make the updater available while preserving your current prompt:

```bash
cd ~/KAMI-AI-CHATBOT
cp -p custom_prompt.txt ~/custom_prompt_backup.txt
git restore --worktree -- custom_prompt.txt
git pull --ff-only origin main
cp -p ~/custom_prompt_backup.txt custom_prompt.txt
bash scripts/update-bot.sh
```

The backup remains in your home directory. Do not use `git reset --hard` to fix a local prompt conflict.

```bash
cd ~/KAMI-AI-CHATBOT
git pull
npm install
npm run check:gemini
pm2 restart kami-ai-chat-bot --update-env
pm2 save
```

Do not delete `key.json` or `kami-ai-session/` while updating: they hold your credentials and WhatsApp login state. If you previously installed the bot in another directory (for example `~/new/kami-ai-chat-bot`), substitute your actual path in these examples.

### Troubleshooting

- **No WhatsApp QR:** The bot may already have a valid paired session. Check `pm2 logs kami-ai-chat-bot` first.
- **Gemini HTTP 503:** The selected model is temporarily overloaded. Retry later or test another available model with `GEMINI_MODEL=MODEL_NAME npm run check:gemini`.
- **Gemini HTTP 401/403:** Check your API key and project access.
- **Gemini HTTP 429:** Your requests are being rate-limited or quota-limited.
- **Repeated WhatsApp decryption errors:** Make sure only one bot process uses the same WhatsApp session. Avoid resetting a working session unless necessary.
- **Bot offline after reboot:** Run `pm2 startup`, execute the printed `sudo` command, then `pm2 save`. Check `pm2 status` after reboot.

**24/7 limitation:** PM2 cannot keep the bot online if the server is powered off, networking is down, the WhatsApp link is disconnected, or Gemini is unavailable. It manages the local bot process; it does not guarantee external service uptime.

## Security

- Never upload `key.json`, `kami-ai-session/`, or private chat history to GitHub.
- `.gitignore` excludes these sensitive files.
- Protect SSH access and keep server dependencies updated.
- Code obfuscation does not protect API keys embedded in published files.

## License

MIT. See [LICENSE](LICENSE).
