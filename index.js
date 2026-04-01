require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Readable } = require('stream');
const { finished } = require('stream/promises');

// Check for Bot Token
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token || token === 'YOUR_TELEGRAM_BOT_TOKEN_HERE') {
  console.error("❌ ERROR: Please set your TELEGRAM_BOT_TOKEN in the .env file.");
  process.exit(1);
}

const backendUrl = process.env.BACKEND_URL || 'http://localhost:3001';

// Initialize Bot (Long Polling)
const bot = new TelegramBot(token, { polling: true });
console.log("🤖 Telegram Bot is running...");
console.log(`🔗 Connected to backend at: ${backendUrl}`);

// Simple Regex to extract the first URL from a message
const urlRegex = /(https?:\/\/[^\s]+)/g;

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || '';

  // 1. Try to find a URL in the message
  const match = text.match(urlRegex);
  if (!match) {
    if (text === '/start') {
      bot.sendMessage(chatId, "Welcome to the Video Downloader Bot! 🎬\n\nJust send me a link from YouTube, Instagram, TikTok, Twitter, etc., and I'll download the video for you.");
    } else {
      bot.sendMessage(chatId, "Hi! Send me a valid video URL (like a YouTube or TikTok link) and I'll download it for you. 📥");
    }
    return;
  }

  const targetUrl = match[0];
  let statusMsg;
  let tempDir;
  let downloadedFile;

  try {
    // 2. Notify User
    statusMsg = await bot.sendMessage(chatId, "⏳ Analyzing link via Backend API...");

    // 3. Setup Temp Directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdbot-'));
    downloadedFile = path.join(tempDir, 'download.mp4');

    // 4. Fetch URLs from the Backend API
    const urlsRes = await fetch(`${backendUrl}/api/urls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: targetUrl, quality: 720, preferMuxed: true })
    });

    if (!urlsRes.ok) {
        const errObj = await urlsRes.json().catch(() => ({}));
        throw new Error(errObj.error || "FAILED_EXTRACT");
    }

    const urlData = await urlsRes.json();
    if (!urlData.urls || urlData.urls.length === 0) {
        throw new Error("FAILED_EXTRACT");
    }

    const cdnUrl = urlData.urls[0];
    console.log(`[DL] API extracted CDN URL for: ${targetUrl}`);

    await bot.editMessageText("📥 Downloading file... This might take a minute.", { chat_id: chatId, message_id: statusMsg.message_id });

    // 5. Download the file locally using the Backend Proxy (bypasses CORS & User-Agent blocks)
    const proxyFetchUrl = new URL(`${backendUrl}/api/proxy`);
    proxyFetchUrl.searchParams.set('url', cdnUrl);

    const fileRes = await fetch(proxyFetchUrl.toString());
    if (!fileRes.ok) throw new Error("FAILED_DOWNLOAD");

    // Check size header if available
    const contentLength = fileRes.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > 50 * 1024 * 1024) {
        throw new Error("FILE_TOO_LARGE");
    }

    // Pipe the proxy stream to our local file
    const dest = fs.createWriteStream(downloadedFile);
    const bodyStream = Readable.fromWeb(fileRes.body);
    bodyStream.pipe(dest);
    await finished(dest);

    // 6. Verify final size to ensure it obeys Telegram's 50MB Node.js limit 
    const stats = fs.statSync(downloadedFile);
    if (stats.size > 50 * 1024 * 1024 || stats.size === 0) {
      throw new Error("FILE_TOO_LARGE");
    }

    // 7. Send the Video to Telegram
    await bot.editMessageText("📤 Uploading video to Telegram...", { chat_id: chatId, message_id: statusMsg.message_id });
    
    await bot.sendVideo(chatId, downloadedFile, {
      caption: `Downloaded successfully!\n🔗 ${targetUrl}`
    });

    // 8. Cleanup temp file and final status message
    if (fs.existsSync(downloadedFile)) fs.unlinkSync(downloadedFile);
    if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
    await bot.deleteMessage(chatId, statusMsg.message_id);
    console.log(`[DL] Success! Sent to chat: ${chatId}`);

  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    
    // Attempt Cleanup on Error
    if (downloadedFile && fs.existsSync(downloadedFile)) fs.unlinkSync(downloadedFile);
    if (tempDir && fs.existsSync(tempDir)) fs.rmdirSync(tempDir);

    let errorText = "❌ Failed to download the video. Please check the link and try again.";
    if (err.message === "FILE_TOO_LARGE") {
      errorText = "❌ This video is too large for Telegram to handle via bots (maximum limit is 50MB).";
    } else if (err.message.includes("yt-dlp")) {
       errorText = `❌ Backend Error: ${err.message}`;
    }

    if (statusMsg) {
       await bot.editMessageText(errorText, { chat_id: chatId, message_id: statusMsg.message_id }).catch(console.error);
    } else {
       await bot.sendMessage(chatId, errorText).catch(console.error);
    }
  }
});

// Render Web Service requires binding to a PORT within 60 seconds
// We create a dummy HTTP server so Render knows the bot is alive.
const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Telegram Bot is running!');
}).listen(PORT, () => {
  console.log(`🌐 Dummy Web Server listening on port ${PORT} for Render Health Checks`);
});

// Graceful exit
process.on('SIGINT', () => {
    console.log("Shutting down bot...");
    bot.stopPolling();
    process.exit(0);
});
