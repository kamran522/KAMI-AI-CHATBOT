"use strict";

const { getGroqApiKey, generateGroqReply, describeGroqError } = require("../groq");

async function main() {
  if (!getGroqApiKey()) {
    console.error("Groq API key is missing. Set GROQ_API_KEY or add groqApiKey to private key.json.");
    process.exitCode = 1;
    return;
  }
  try {
    const answer = await generateGroqReply("Reply with the word OK.", [], "You are a brief AI assistant.");
    if (!answer) throw new Error("GROQ_EMPTY_RESPONSE");
    console.log("GROQ CHECK PASSED");
    console.log("Model:", process.env.GROQ_MODEL?.trim() || "llama-3.3-70b-versatile");
    console.log("A live Groq text request succeeded. API key and reply are not printed.");
  } catch (error) {
    console.error("GROQ CHECK FAILED:", describeGroqError(error));
    const status = error.response?.status;
    if (status === 401 || status === 403) console.error("Verify your Groq key and model permissions.");
    else if (status === 404) console.error("The Groq model may be unavailable; check GROQ_MODEL.");
    else if (status === 429) console.error("Groq rate limit or quota reached.");
    process.exitCode = 1;
  }
}
if (require.main === module) main();
module.exports = { main };
