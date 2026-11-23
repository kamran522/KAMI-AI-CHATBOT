"use strict";

// Test the speech service and WhatsApp audio conversion without logging or
// persisting your API key, the generated WAV, or chat messages.
const { synthesizeVoiceReply, describeGeminiError } = require("../kami");
const { wavToWhatsAppVoiceNote } = require("../voice");

async function main() {
  const started = Date.now();
  let stage = "Gemini TTS";
  try {
    const wav = await synthesizeVoiceReply("Hello. KAMI voice replies are working.");
    const ttsMs = Date.now() - started;
    stage = "FFmpeg OGG/Opus conversion";
    const ogg = await wavToWhatsAppVoiceNote(wav);
    console.log("VOICE CHECK PASSED");
    console.log(`Gemini TTS: ${ttsMs} ms; WhatsApp OGG/Opus: ${Date.now() - started - ttsMs} ms`);
    console.log(`Generated ${ogg.length} bytes of audio (not saved to disk).`);
  } catch (error) {
    console.error(`VOICE CHECK FAILED at ${stage}: ${describeGeminiError(error)}`);
    const status = error?.response?.status;
    if (error.message === "GEMINI_API_KEY_MISSING" || status === 401 || status === 403)
      console.error("Check GEMINI_API_KEY or key.json, and whether the key has access to the TTS model.");
    else if (status === 404)
      console.error("Verify GEMINI_TTS_MODEL and whether that model is available to your API key.");
    else if (status === 429)
      console.error("Speech model quota/rate limit reached. Check Gemini usage and billing.");
    else if (["ECONNABORTED", "ETIMEDOUT"].includes(error.code))
      console.error("Speech request timed out. Try VOICE_TTS_TIMEOUT_MS=35000, then test again.");
    else if (error.message === "VOICE_FFMPEG_NOT_INSTALLED")
      console.error("Install ffmpeg: sudo apt-get install -y ffmpeg");
    else if (stage === "FFmpeg OGG/Opus conversion")
      console.error("Check the ffmpeg build: ffmpeg -encoders | grep libopus");
    else
      console.error("Check the error above and the Gemini TTS model's availability.");
    process.exitCode = 1;
  }
}

if (require.main === module) main().catch((error) => {
  console.error("Voice diagnostic failed:", describeGeminiError(error));
  process.exitCode = 1;
});
module.exports = { main };
