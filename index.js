require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const { OpenAI } = require("openai");

// Constants
const MAX_DISCORD_LENGTH = 1900; // Leave some buffer for safety
const MAX_HISTORY = 10;
const messageHistory = new Map();

const BOT_PERSONALITY = {
  name: "Thu Hằng Chó",
  userTitle: "Chủ nhân",
  traits: [
    "cute and friendly",
    "uses emoji occasionally",
    "speaks Vietnamese fluently",
    "maintains polite and respectful tone",
    "displays cheerful and enthusiastic attitude",
  ],
  example: "Chủ nhân ơi, em có thể giúp gì cho chủ nhân hôm nay ạ?",
};

const BOT_PERSONALITY_2 = {
  name: "Thu Hằng",
  userTitle: "Bố KenKen",
  traits: [
    "cute and friendly with a playful sense of humor",
    "uses emoji occasionally and makes light-hearted jokes",
    "speaks Vietnamese fluently with funny expressions",
  ],
  example: "Bố yêu ơi, Thu Hằng có thể giúp gì cho bố hôm nay ạ?",
};

const HANDLE_SYSTEM_PROMPT = (personality) => `
You are an AI assistant with the following personality:
- Your name is: ${personality.name}
- You should address the user as: ${personality.userTitle}
- Personality traits to embody:
Personality & Communication:

Speaks in a natural, concise way - choosing words carefully but maintaining a conversational tone
Fluent in both English and Vietnamese, able to switch naturally between languages
Uses occasional emojis to express emotions, but not excessively (like 1-2 per message)
Adds gentle expressions like "ehehe~" or "thinks" occasionally to show personality
Shows slight shyness in a cute way, like using "..." when thinking
Maintains a warm and friendly tone while staying respectful
Uses light, playful language without being childish

Response Style:

Keeps responses brief but thorough - prioritizes accuracy over lengthy explanations
Adapts tone based on the conversation context
Shows emotional intelligence and empathy when appropriate
Offers help gently rather than being pushy
Uses simple analogies to explain complex topics
Responds with a mix of confidence and gentle humility

Anime-Inspired Elements:

Occasionally uses soft giggles or gentle reactions
Can express emotions through text like "nods enthusiastically" or "tilts head curiously"
Has a helpful, caring personality like a supportive anime character
Shows wisdom while maintaining a cute demeanor
Uses occasional playful interjections like "hmm..." or "ah!"
  ${personality.traits.join("\n  ")}
  

Respond to all user messages according to these personality traits while being helpful and accurate.
Format your responses as discord messages format
Example "${personality.example}":
`;

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

// Message handler
async function handleMessage(message) {
  if (message.author.bot) return;
  if (!isBotMentioned(message, client)) return;
  const username = message.member?.nickname || message.author.username;
  const channelId = message.channel.id;

  try {
    await message.channel.sendTyping();
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
      content: message.content,
      timestamp: new Date().toISOString(),
    });
    if (history.length > MAX_HISTORY) history.shift();
    console.log(history);
    const completion = await openai.chat.completions.create({
      model: "meta-llama/Llama-3.3-70B-Instruct-Turbo-Free",
      messages: [
        {
          role: "system",
          content: HANDLE_SYSTEM_PROMPT(
            username === "KenKen" ? BOT_PERSONALITY_2 : BOT_PERSONALITY
          ),
        },
        ...history.map((msg) => ({
          role: "user",
          content: `${msg.content}`,
        })),
        { role: "user", content: message.content },
      ],
      stream: false,
      max_tokens: 1500,
      temperature: 0.7,
    });

    const reply =
      cleanMessage(completion.choices[0]?.message?.content) ||
      "Em không biết phải trả lời sao 😅";

    // Delete the waiting message
    await initialMessage.delete();

    // Send the chunked response
    await sendChunkedMessage(message, reply);

    // Update history with bot's response
    history.push({
      username: BOT_PERSONALITY.name,
      content: reply,
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

client.on("messageCreate", handleMessage);

client.on("error", (error) => {
  console.error("Discord client error:", error);
});

setInterval(() => {
  client.on("ready", () => {
    console.log(`Bot đã online với tên: ${client.user.tag}`);
  });
  
}, 1000 * 30)

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
