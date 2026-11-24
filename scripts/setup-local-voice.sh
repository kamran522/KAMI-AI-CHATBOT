#!/usr/bin/env bash
# Optional one-time CPU-only installation; does not restart or enable the bot.
# Usage: bash scripts/setup-local-voice.sh [--balochi]
set -Eeuo pipefail
MODE="$1"
if [[ -n "$MODE" && "$MODE" != "--balochi" ]]; then
  echo "Usage: bash scripts/setup-local-voice.sh [--balochi]" >&2
  exit 2
fi

cd "$(dirname "$0")/.."
ROOT="$(node -p 'require("./local-voice").assets().root')"
mkdir -p "$ROOT/voices"
chmod 700 "$ROOT"
echo "Installing offline voice tools under: $ROOT"
echo "This downloads open models; it does not install any cloud API keys."

for command in python3 git cmake ffmpeg curl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Missing $command. Install with: sudo apt-get install -y python3-venv python3-pip git cmake build-essential ffmpeg curl" >&2
    exit 1
  fi
done

if [[ ! -d "$ROOT/whisper.cpp" ]]; then
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git "$ROOT/whisper.cpp"
fi
cmake -S "$ROOT/whisper.cpp" -B "$ROOT/whisper.cpp/build" \
  -DCMAKE_BUILD_TYPE=Release -DWHISPER_FFMPEG=OFF
cmake --build "$ROOT/whisper.cpp/build" --config Release -j 2

if [[ ! -s "$ROOT/whisper.cpp/models/ggml-small.bin" ]]; then
  bash "$ROOT/whisper.cpp/models/download-ggml-model.sh" small "$ROOT/whisper.cpp/models"
fi

if [[ ! -x "$ROOT/venv/bin/python" ]]; then
  python3 -m venv "$ROOT/venv"
fi
"$ROOT/venv/bin/python" -m pip install --upgrade pip
"$ROOT/venv/bin/python" -m pip install "piper-tts>=1.3,<2"

get_voice() {
  local language="$1" subdir="$2"
  for extension in .onnx .onnx.json; do
    local name="$language$extension"
    local output="$ROOT/voices/$name"
    if [[ ! -s "$output" ]]; then
      curl --fail --location --retry 3 --silent --show-error \
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/$subdir/$name" \
        -o "$output.partial"
      mv "$output.partial" "$output"
    fi
  done
}
get_voice "en_US-lessac-medium" "en/en_US/lessac/medium"
get_voice "ur_PK-fasih-medium" "ur/ur_PK/fasih/medium"

if [[ "$MODE" == "--balochi" ]]; then
  echo "Balochi add-on: MMS Southern Balochi TTS is CC-BY-NC 4.0 (non-commercial use only)."
  echo "Balochi ASR is experimental. Published held-out WER was about 54%."
  if [[ ! -x "$ROOT/balochi-venv/bin/python" ]]; then
    python3 -m venv "$ROOT/balochi-venv"
  fi
  "$ROOT/balochi-venv/bin/python" -m pip install --upgrade pip
  "$ROOT/balochi-venv/bin/python" -m pip install torch --index-url https://download.pytorch.org/whl/cpu
  "$ROOT/balochi-venv/bin/python" -m pip install "transformers>=4.46,<5" "numpy<2" "soundfile" "sentencepiece" "huggingface_hub"
  ROOT="$ROOT" "$ROOT/balochi-venv/bin/python" - <<'PY'
import os
from huggingface_hub import snapshot_download
root = os.environ["ROOT"]
for repo, folder in (
    ("umairjamali/balochi-whisper-small-v3", "balochi-stt"),
    ("facebook/mms-tts-bcc-script_arabic", "balochi-tts"),
):
    snapshot_download(repo_id=repo, local_dir=os.path.join(root, folder))
print("Balochi checkpoints downloaded for offline use.")
PY
fi

if command -v ollama >/dev/null 2>&1; then
  ollama pull "$(node -p 'require("./local-ai").modelName()')"
else
  echo ""
  echo "Ollama not found. Install from https://ollama.com/download/linux"
  echo "Then run: ollama pull qwen3:4b"
fi

echo ""
echo "Local speech packages installed."
echo "To validate: npm run check:local-voice"
echo "To enable via PM2:"
echo "LOCAL_VOICE_ENABLED=1 LOCAL_TEXT_ENABLED=1 pm2 restart kami-ai-chat-bot --update-env"
echo "pm2 save"
echo "Balochi chat mode: send /voice balochi (only if --balochi was installed)."
