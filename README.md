# KAMI AI CHAT BOT

A WhatsApp auto-reply bot powered by Google Gemini and Baileys. Incoming text messages are sent to Gemini automatically—no `!ai`, `/ai`, or other command is required.

**Creator:** Kamran Hasil  
**WhatsApp:** +92 339 5267262  
**Email:** kamranhasilbaloch@gmail.com

## Features

- Automatic replies to incoming WhatsApp text in private chats and groups
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
