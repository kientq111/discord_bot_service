require("dotenv").config();
const express = require("express");
const { Client, GatewayIntentBits, AttachmentBuilder } = require("discord.js");
const {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
} = require("@google/generative-ai");
const { GoogleAIFileManager } = require("@google/generative-ai/server");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const { BOT_PERSONALITY } = require("./completion");

// Setup Express server
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
const MAX_DISCORD_LENGTH = 1900;
const MAX_HISTORY = 10;
const messageHistory = new Map();
const TEMP_DIR = path.join(__dirname, "temp");

// Create temp directory if it doesn't exist
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Initialize Gemini and FileManager
const apiKey = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(apiKey);
const fileManager = new GoogleAIFileManager(apiKey);

// Model configuration
const generationConfig = {
  temperature: 1,
  topP: 0.95,
  topK: 40,
  maxOutputTokens: 8192,
  responseModalities: ["Text", "Image"]
};

// Helper function to upload file to Gemini
async function uploadToGemini(filePath, mimeType) {
  try {
    const uploadResult = await fileManager.uploadFile(filePath, {
      mimeType,
      displayName: path.basename(filePath),
    });
    console.log(
      `Uploaded file ${uploadResult.file.displayName} as: ${uploadResult.file.name}`
    );
    return uploadResult.file;
  } catch (error) {
    console.error("Error uploading to Gemini:", error);
    throw error;
  }
}

// Helper function to download image from URL and save to disk
async function downloadImageAndSave(url, userId) {
  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to download image: ${response.statusText}`);
    }

    const buffer = await response.buffer();
    const fileName = `${userId}_${Date.now()}.png`;
    const filePath = path.join(TEMP_DIR, fileName);

    fs.writeFileSync(filePath, buffer);
    return { filePath, buffer };
  } catch (error) {
    console.error("Error downloading image:", error);
    throw error;
  }
}

// Function to edit image using Gemini
async function editImageWithGemini(imagePath, editPrompt) {
  try {
    // Upload the image to Gemini
    const uploadedFile = await uploadToGemini(imagePath, "image/png");

    // Get the model for image generation/editing
    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash-exp-image-generation",
      generationConfig,
    });

    // Start a chat session
    const chatSession = model.startChat({
      generationConfig,
      history: [],
    });

    // Send the message with the image and edit prompt
    const result = await chatSession.sendMessage([
      {
        fileData: {
          mimeType: uploadedFile.mimeType,
          fileUri: uploadedFile.uri,
        },
      },
      { text: editPrompt },
    ]);

    console.log("Gemini response received, checking for image data...");
    
    // Extract the image data from the response
    // First try the fileData format
    const imagePart = result.response.candidates[0].content.parts.find(
      (part) => part.fileData && part.fileData.mimeType.startsWith("image/")
    );

    if (imagePart) {
      // Download the generated image
      const imageUrl = imagePart.fileData.fileUri;
      const response = await fetch(imageUrl);

      if (!response.ok) {
        throw new Error(
          `Failed to download edited image: ${response.statusText}`
        );
      }

      const buffer = await response.buffer();
      const editedImagePath = imagePath.replace(".png", "_edited.png");
      fs.writeFileSync(editedImagePath, buffer);

      return { buffer, path: editedImagePath };
    }
    
    // Try alternative response structure (for inline data)
    const inlineImagePart = result.response.candidates[0].content.parts.find(
      (part) => part.inlineData && part.inlineData.mimeType.startsWith("image/")
    );
    
    if (inlineImagePart) {
      // Handle inline data format
      console.log("Found image in inlineData format");
      const buffer = Buffer.from(inlineImagePart.inlineData.data, 'base64');
      const editedImagePath = imagePath.replace(".png", "_edited.png");
      fs.writeFileSync(editedImagePath, buffer);
      return { buffer, path: editedImagePath };
    }
    
    // If we get here, no image was found
    console.error("Response structure:", JSON.stringify(result.response.candidates[0].content.parts, null, 2));
    throw new Error("No edited image was generated");
  } catch (error) {
    console.error("Gemini image editing error:", error);
    throw error;
  }
}

// Helper function to chunk messages
function chunkMessage(text) {
  const chunks = [];
  let currentChunk = "";

  const lines = text.split("\n");

  for (const line of lines) {
    if (currentChunk.length + line.length + 1 > MAX_DISCORD_LENGTH) {
      if (currentChunk) {
        chunks.push(currentChunk);
        currentChunk = "";
      }

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

function isBotMentioned(message, client) {
  return message.mentions.users.has(client.user.id);
}

function extractEditPrompt(content) {
  return content.replace(/<@!?\d+>/g, "").trim();
}

// Main message handler
async function handleMessage(message) {
  if (message.author.bot) return;
  if (!isBotMentioned(message, client)) return;

  const userId = message.author.id;
  const username = message.member?.nickname || message.author.username;
  const channelId = message.channel.id;

  // Check if the message has attachments
  if (message.attachments.size > 0) {
    // User is uploading an image to edit
    const attachment = message.attachments.first();

    if (attachment.contentType && attachment.contentType.startsWith("image")) {
      try {
        await message.channel.sendTyping();
        const initialMessage = await message.channel.send(
          "Đợi em chút nha..đang xử lý hình ảnh ⏳"
        );

        // Get the edit prompt
        const editPrompt = extractEditPrompt(message.content);

        if (!editPrompt) {
          await initialMessage.delete();
          await message.reply(
            "Vui lòng cung cấp chi tiết chỉnh sửa bạn muốn thực hiện với hình ảnh."
          );
          return;
        }

        // Download and save the image
        const { filePath, buffer } = await downloadImageAndSave(
          attachment.url,
          userId
        );

        // Edit the image with Gemini
        const editedImage = await editImageWithGemini(filePath, editPrompt);

        // Delete the waiting message
        await initialMessage.delete();

        // Create a Discord attachment from the buffer
        const attachmentBuilder = new AttachmentBuilder(editedImage.buffer, {
          name: "edited-image.png",
        });

        // Send the edited image
        await message.channel.send({
          content: `${username}, đây là hình ảnh đã chỉnh sửa theo yêu cầu của bạn:`,
          files: [attachmentBuilder],
        });

        // Update message history
        if (!messageHistory.has(channelId)) {
          messageHistory.set(channelId, []);
        }

        const history = messageHistory.get(channelId);
        history.push({
          username,
          content: `[Image upload with edit prompt: ${editPrompt}]`,
          timestamp: new Date().toISOString(),
        });

        history.push({
          username: BOT_PERSONALITY.name,
          content: "[Edited image sent]",
          timestamp: new Date().toISOString(),
        });

        if (history.length > MAX_HISTORY) history.shift();

        // Cleanup temporary files
        try {
          fs.unlinkSync(filePath);
          fs.unlinkSync(editedImage.path);
        } catch (err) {
          console.error("Error cleaning up temp files:", err);
        }
      } catch (error) {
        console.error("Error processing image:", error);
        await message.reply(
          `Em bị lỗi rồi ${username} ơi! Không thể chỉnh sửa hình ảnh 😭\nLỗi: ${error.message}`
        );
      }
    }
  } else {
    // No image attached
    await message.reply(
      "Vui lòng tải lên hình ảnh cùng với lời nhắn của bạn để chỉnh sửa."
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

// Clean up temp directory periodically
setInterval(() => {
  try {
    const files = fs.readdirSync(TEMP_DIR);
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      const stats = fs.statSync(filePath);

      if (stats.mtimeMs < oneDayAgo) {
        fs.unlinkSync(filePath);
        console.log(`Deleted old temp file: ${filePath}`);
      }
    }
  } catch (error) {
    console.error("Error cleaning temp directory:", error);
  }
}, 3 * 60 * 60 * 1000); // Every 3 hours

client.login(process.env.DISCORD_TOKEN).catch((error) => {
  console.error("Failed to start bot:", error);
  process.exit(1);
});
