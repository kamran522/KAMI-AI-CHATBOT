#!/usr/bin/env bash
# Update KAMI while keeping an edited, tracked custom_prompt.txt intact.
# Usage (from anywhere): bash ~/KAMI-AI-CHATBOT/scripts/update-bot.sh
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "ERROR: Switch to the main branch before updating." >&2
  exit 1
fi
if ! git diff --cached --quiet || ! git diff --quiet -- . ':(exclude)custom_prompt.txt'; then
  echo "ERROR: Other tracked files contain local changes. Commit or stash them first." >&2
  exit 1
fi
if [[ ! -f custom_prompt.txt ]]; then
  echo "ERROR: custom_prompt.txt is missing." >&2
  exit 1
fi

# Keep a permanent, private recovery copy even if a pull fails.
umask 077
backup_dir="${HOME}/.kami-ai-backups"
mkdir -p "$backup_dir"
backup="$backup_dir/custom_prompt-$(date +%Y%m%d-%H%M%S)-$$.txt"
cp -p -- custom_prompt.txt "$backup"
echo "Saved local prompt backup: $backup"

restore_prompt() {
  cp -p -- "$backup" custom_prompt.txt
}
# Restore the original prompt on success or failure. Never discard its backup.
trap restore_prompt EXIT

# A local tracked-file edit prevents git pull; remove only this edit, after backup.
git restore --worktree -- custom_prompt.txt
git pull --ff-only origin main

# Test repository code against the checked-in default prompt before restoring
# user-specific customizations that may intentionally differ.
npm install
npm test

restore_prompt
trap - EXIT

# Run live diagnostics before restarting. Credentials remain on this server.
npm run check:gemini

# The optional live-call feature has been retired. Stop its old PM2 service
# if it was previously started, so a deleted script is not kept running.
if pm2 describe kami-ai-calls > /dev/null 2>&1; then
  pm2 delete kami-ai-calls
fi
pm2 restart kami-ai-chat-bot --update-env
pm2 save

echo "Updated KAMI AI CHAT BOT. Custom prompt preserved."
