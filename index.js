require("dotenv").config();
const express = require("express");
const { Client, GatewayIntentBits } = require("discord.js");
const { OpenAI } = require("openai");
const {
  BOT_PERSONALITY,
  BOT_PERSONALITY_2,
  HANDLE_SYSTEM_PROMPT,
} = require("./completion");

const app = express();
const port = process.env.PORT || 3000;

app.get("/ping", (req, res) => {
  const userAgent = req.get("User-Agent");
  console.log(`Request from: ${userAgent}`);
  res.send("Bot is alive on port: " + port);
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

// Constants
const MAX_DISCORD_LENGTH = 1900; // Leave some buffer for safety
const MAX_HISTORY = 10;
const messageHistory = new Map();

// Helper function to chunk messages
function chunkMessage(text) {
  const chunks = [];
  let currentChunk = "";

  // Split by newlines first to preserve formatting
  const lines = text.split("\n");

  for (const line of lines) {
    if (currentChunk.length + line.length + 1 > MAX_DISCORD_LENGTH) {
      if (currentChunk) {
        chunks.push(currentChunk);
        currentChunk = "";
      }

      // If single line is too long, split by characters
      if (line.length > MAX_DISCORD_LENGTH) {
        let remainingLine = line;
        while (remainingLine.length > 0) {
          chunks.push(remainingLine.slice(0, MAX_DISCORD_LENGTH));
          remainingLine = remainingLine.slice(MAX_DISCORD_LENGTH);
        }
      } else {
        currentChunk = line;
      }
    } else {
      currentChunk += (currentChunk ? "\n" : "") + line;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}

// Send chunked message
async function sendChunkedMessage(message, text) {
  const chunks = chunkMessage(text);
  let sentMessage = null;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (i === 0) {
      sentMessage = await message.channel.send(chunk);
    } else {
      await message.channel.send(chunk);
    }
  }

  return sentMessage;
}

// New function to send image from base64
async function sendImageFromBase64(message, base64Data) {
  try {
    // Decode the base64 string to a buffer
    const imageBuffer = Buffer.from(base64Data, "base64");

    // Create a Discord attachment
    const attachment = {
      attachment: imageBuffer,
      name: "generated-image.png",
    };

    // Send the image as an attachment
    return await message.channel.send({ files: [attachment] });
  } catch (error) {
    console.error("Error sending image:", error);
    await message.channel.send("Failed to process the generated image 😢");
    return null;
  }
}

function isBotMentioned(message, client) {
  return message.mentions.users.has(client.user.id);
}

function cleanMessage(content) {
  // Remove everything between <think> and </think>
  let cleanedContent = content.replace(/<think>.*?<\/think>/s, "");
  // Also handle the case where it's just <think> without closing tag
  cleanedContent = cleanedContent.replace(/<think>.*$/s, "");
  // Remove any remaining HTML-like tags
  cleanedContent = cleanedContent.replace(/<[^>]*>/g, "");
  // Trim extra whitespace
  cleanedContent = cleanedContent.trim();
  return cleanedContent;
}

// Refactored message handler for image generation
async function handleMessage(message) {
  if (message.author.bot) return;
  if (!isBotMentioned(message, client)) return;

  const username = message.member?.nickname || message.author.username;
  const channelId = message.channel.id;
  const userMessage = message.content;

  try {
    // Show typing indicator
    await message.channel.sendTyping();

    // Send waiting message
    const initialMessage = await message.channel.send(
      "Đợi em chút nha..meo meo ⏳"
    );

    // Update history
    if (!messageHistory.has(channelId)) {
      messageHistory.set(channelId, []);
    }

    const history = messageHistory.get(channelId);
    history.push({
      username,
      content: userMessage,
      timestamp: new Date().toISOString(),
    });

    if (history.length > MAX_HISTORY) history.shift();

    // Extract prompt from user message (you might want to enhance this)
    // Remove the bot mention from the message
    const cleanedMessage = userMessage.replace(/<@!?\d+>/g, "").trim();
    const imagePrompt = cleanedMessage || "Generate anime girl image";

    // Generate image
    const completion = await openai.images.generate({
      model: "black-forest-labs/FLUX.1-schnell-Free",
      prompt: `[
        "system: You are an anime art generator that creates high-quality anime-style images. Always produce images in anime or manga art style with vibrant colors, clean lines, and distinctive anime aesthetic features like large expressive eyes and stylized proportions.",
        "user: ${imagePrompt}"
      ]`,
      width: 1024,
      height: 768,
      steps: 2,
      n: 1,
      seed: 2085,
      response_format: "b64_json",
      _gl: "1*19sf9ev*_gcl_au*MTk4NjQ4NDA4OS4xNzM4NjQzMzMw*_ga*MTY3MDI3NzYuMTczODY0MzMzMA..*_ga_BS43X21GZ2*MTc0MDczNjQ1MC4xMS4xLjE3NDA3MzY1MzUuMC4wLjA.*_ga_BBHKJ5V8S0*MTc0MDczNjQ1MC4xLjEuMTc0MDczNjUzNS4wLjAuMA..",
    });

    // Get the base64 image data
    const imageBase64 = completion.data[0].b64_json;

    // Delete the waiting message
    await initialMessage.delete();

    // Send the image
    const sentMessage = await sendImageFromBase64(message, imageBase64);

    // Update history with image reference
    history.push({
      username: BOT_PERSONALITY.name,
      content: "[Image sent]", // More meaningful than storing the raw base64
      timestamp: new Date().toISOString(),
    });

    if (history.length > MAX_HISTORY) history.shift();
  } catch (error) {
    console.error("Error:", error);
    await message.reply(
      `Em bị lỗi rồi ${username} ${BOT_PERSONALITY.userTitle} ơi! 😭`
    );
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.BASE_URL,
});

client.setMaxListeners(15);

client.on("ready", () => {
  console.log(`Bot đã online với tên: ${client.user.tag}`);
});

client.on("messageCreate", handleMessage);

client.on("error", (error) => {
  console.error("Discord client error:", error);
});

// Clean up old history periodically
setInterval(() => {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  for (const [channelId, history] of messageHistory.entries()) {
    const recentHistory = history.filter(
      (msg) => new Date(msg.timestamp) > oneHourAgo
    );
    messageHistory.set(channelId, recentHistory);
  }
}, 60 * 60 * 1000);

client.login(process.env.DISCORD_TOKEN).catch((error) => {
  console.error("Failed to start bot:", error);
  process.exit(1);
});
