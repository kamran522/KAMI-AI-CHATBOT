# KAMI AI CHAT BOT

A WhatsApp auto-reply bot powered by Google Gemini, with Groq AI as an optional failover provider, using Baileys. Incoming text messages receive text answers and incoming WhatsApp voice notes receive spoken answers automatically—no `!ai`, `/ai`, or other command is required.

**Creator:** Kamran Hasil  
**WhatsApp:** +92 339 5267262  
**Email:** kamranhasilbaloch@gmail.com

## Features

- Automatic replies to incoming WhatsApp text in private chats and groups
- Faster WhatsApp voice-note replies: one Gemini audio request understands the note and drafts its response; a second request generates the voice (OGG/Opus)
- Keeps conversation context between voice notes and text; voice-note replies stay audio-only and do not send transcript or subtitle messages
- Google Gemini integration with optional Groq failover for text replies and voice-note understanding
- Groq Whisper fallback transcription when Gemini cannot understand a voice note, including empty, malformed, or token-truncated Gemini audio responses
- Google Gemini integration and a custom bot personality/prompt
- Recent conversation context per chat
- WhatsApp QR-code pairing
- Gemini connection diagnostics via `npm run check:gemini`
- Automatic retry notifications: the bot says “🔄 Updating, please wait...” when Gemini has a temporary outage
- Clearer final error messages and server-side diagnostic details

> **Note:** The prompt contains examples of searches, appointments, and reminders. Those actions are not standalone integrations in this repository. Text replies require a working Gemini or Groq API key; synthesized voice replies also require Gemini TTS, an internet connection, and a connected WhatsApp session.

## Requirements

- Linux server (the commands below use Ubuntu/Debian conventions)
- Node.js **18 or newer** and npm
- Git
- Google Gemini API key or a Groq key for text and voice understanding (Gemini still required for voice synthesis)
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

## Groq AI primary provider and Gemini fallback

The bot attempts **Gemini first**. If it fails (including timeout, quota, invalid/missing Gemini key, or unavailable model), the bot automatically asks **Groq chat** using its separate private API key, preserving the same custom prompt and chat history. Gemini safety blocks are not automatically bypassed.

To configure Groq, add `groqApiKey` to your **private**, gitignored `key.json` on the server. Keep the Gemini key if you have one:

```json
{
  "geminiApiKey": "YOUR_REAL_GEMINI_KEY",
  "groqApiKey": "YOUR_REAL_GROQ_KEY"
}
```

Never put API keys into GitHub, WhatsApp, or public logs. Both `GEMINI_API_KEY` and `GROQ_API_KEY` environment variables are supported and override the corresponding `key.json` fields.

Groq chat uses `openai/gpt-oss-120b` by default, replacing the `llama-3.3-70b-versatile` model deprecated for Free and Developer accounts on August 16, 2026. If the default receives HTTP 404, the bot fetches `GET /openai/v1/models` and tries a listed replacement from `openai/gpt-oss-20b` or `qwen/qwen3.8-27b` (where available), caching the working choice. An explicit `GROQ_MODEL` setting is always respected and is not automatically replaced. Groq speech-to-text uses `whisper-large-v3-turbo`. Supported environment overrides: `GROQ_MODEL`, `GROQ_TRANSCRIPTION_MODEL`, `GROQ_TIMEOUT_MS` (default 18000), `GEMINI_PRIMARY_TIMEOUT_MS` (default 12000 with Groq enabled), and `GEMINI_VOICE_TIMEOUT_MS` (default 18000 with Groq enabled). The models need to be available to your account.

Test Groq with a live text request:

```bash
cd ~/KAMI-AI-CHATBOT
npm run check:groq
```

To test a specific current model without permanently changing the configuration:

```bash
GROQ_MODEL=openai/gpt-oss-120b npm run check:groq
```

Check the models exposed to your account in [Groq's model API documentation](https://console.groq.com/docs/models). A 404 for a configured model can mean that the model was retired or your Groq account cannot access it. Model permissions and pricing may differ by plan.

**WhatsApp text:** When Groq is configured, the bot tries Gemini once and switches to Groq upon failure, without spending time on extra Gemini retries. Without Groq, the previous Gemini retry behavior is unchanged.

**WhatsApp voice notes:** Groq Whisper transcribes voice notes first and Groq chat generates the reply. If either fails, Gemini handles the original voice note. **Speaking the reply uses Groq Orpheus first (male Troy), then Gemini Charon if Groq fails or the answer exceeds 200 characters.** If both speech providers fail, the bot sends a voice-generation error notice. Groq Orpheus officially supports English and Saudi Arabic only.

Voice notes go to Groq first and may be shared with Gemini when Groq fails. The bot does not save original audio files, but chat transcripts continue to be stored in `chat_history.json`. Different providers may charge separately and have different privacy policies.

If both providers fail, the bot sends an error message rather than silently dropping the reply. The update script checks Gemini and, if it fails, validates Groq before restarting PM2. API keys stay on your server and are never uploaded by the updater.

## Voice-note replies

Voice notes sent to the bot (WhatsApp push-to-talk audio, including disappearing voice notes) are processed automatically in private chats and groups. Audio files sent as attachments are not processed as voice notes.

1. The bot downloads an incoming voice note in memory. **One Gemini request** transcribes it and drafts the answer. If this fails, Groq Whisper and Groq chat can provide the transcript and answer.
2. The transcript and answer enter the existing conversation context.
3. Gemini Text-to-Speech speaks the complete generated answer. FFmpeg converts its WAV output to OGG/Opus, and Baileys sends it with `ptt: true` so WhatsApp displays a voice message.
4. Voice-note replies are audio-only: the bot does not send the transcript, subtitles, or the remainder of a spoken answer as text. If Gemini speech synthesis or FFmpeg fails, it sends a short error notice without exposing the answer as text. If transcription fails, it sends a short error message. Large notes (over **8 MB** or **3 minutes**) are rejected.

Install FFmpeg on the Linux server before starting the bot:

```bash
sudo apt-get update
sudo apt-get install -y ffmpeg
ffmpeg -encoders | grep libopus
```

Check speech generation and conversion before testing WhatsApp:

```bash
npm run check:voice
```

This performs one real Gemini TTS request using your API key and validates FFmpeg OGG/Opus conversion. It prints whether the error is from the speech API, a timeout, or encoding. It does not send a WhatsApp message, save the audio, or print your API key. A working `npm run check:gemini` only proves text generation works, **not voice synthesis**.

The existing `GEMINI_API_KEY` or `key.json` is reused. Optional environment variables:

| Variable | Default | Use |
| --- | --- | --- |
| `GEMINI_AUDIO_MODEL` | `GEMINI_MODEL` / `gemini-3.5-flash-lite` | Audio transcription |
| `GEMINI_TTS_MODEL` | `gemini-3.8-flash-lite-tts` | Speech synthesis via Gemini Interactions API |
| `GEMINI_TTS_VOICE` | `Charon` | Synthetic voice |

Voice replies speak the complete generated answer rather than truncating it at a character limit. The bot also sends only the most recent four conversation turns to Gemini for voice notes and reuses the HTTPS connection between its AI and speech requests. Actual response time still depends on Gemini and WhatsApp. For diagnosis, check the `Voice-note timings (ms)` line in `pm2 logs kami-ai-chat-bot`.

Voice synthesis defaults to a 25-second deadline, after which the bot returns the text answer instead of continuing long TTS retries. Adjust with `VOICE_TTS_TIMEOUT_MS` (milliseconds, allowed range 3000–60000). This is an upper bound on the **TTS request**, not a total response-time guarantee.

The selected models must be available to your Gemini API key. The audio-to-answer request and the text-to-speech request each consume Gemini API quota or paid credits. The existing `npm run check:gemini` command tests text generation only; it does not verify TTS model access.

**Privacy:** Incoming voice-note bytes are sent to Google's Gemini API for transcription and processed in memory rather than stored locally. The resulting transcript is saved in the same `chat_history.json` file used for text conversations. Use this bot only where participants understand voice notes will be processed by Gemini.

**Troubleshooting failed voice replies:** The bot prints `Voice reply failed at Gemini TTS`, `Voice reply failed at FFmpeg OGG/Opus encoding`, or `Voice reply failed at WhatsApp audio delivery` with safe diagnostic details and processing times. An HTTP 404 usually means the TTS model is unavailable to the API key, HTTP 429 can mean quota/rate limiting, and a timeout suggests the TTS service is too slow for the configured deadline. Change `VOICE_TTS_TIMEOUT_MS` only after checking the real error.

**Limitations:** Voice notes are limited to 8 MB and 3 minutes. Long answers are spoken in shortened form and followed by the full text. Actual voice synthesis depends on the external Gemini TTS model; it cannot be guaranteed offline.

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

This backs up your local `custom_prompt.txt` under `~/.kami-ai-backups/`, temporarily restores its committed version for `git pull --ff-only`, then restores your own prompt. It runs tests and checks Gemini connectivity before restarting PM2. It will not overwrite other modified tracked files. The GitHub repository also merges the owner's own pull requests after CI tests pass; external contributors' PRs still require review.

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

### Groq speech configuration

`GROQ_TTS_MODEL` defaults to `canopylabs/orpheus-v1-english`; `GROQ_TTS_VOICE` defaults to `troy`. Groq speech requires an enabled Groq API key and model access. Gemini remains the backup for long replies and Groq synthesis errors.
