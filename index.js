require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Readable } = require('stream');


// ─── Config Checks ─────────────────────────────────────────────────────────
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token || token === 'YOUR_TELEGRAM_BOT_TOKEN_HERE') {
  console.error("❌ ERROR: Please set your TELEGRAM_BOT_TOKEN in the .env file.");
  process.exit(1);
}

const backendUrl = (process.env.BACKEND_URL || 'http://localhost:3001').replace(/\/$/, '');

// ─── Bot Init ───────────────────────────────────────────────────────────────
const bot = new TelegramBot(token, { polling: true });
console.log("🤖 OmniGrab Telegram Bot is running...");
console.log(`🔗 Backend: ${backendUrl}`);

// Register command menu so users see the "/" command list in Telegram's UI
bot.setMyCommands([
  { command: 'start',   description: 'Welcome message & how to use' },
  { command: 'help',    description: 'How to download + FAQ' },
  { command: 'about',   description: 'About OmniGrab Bot' },
  { command: 'privacy', description: 'Privacy Policy' },
  { command: 'terms',   description: 'Terms of Service & Disclaimer' },
  { command: 'dmca',    description: 'DMCA & Copyright Policy' },
]).then(() => console.log('✅ Bot commands registered.')).catch(console.error);

// ─── In-Memory Session Store ────────────────────────────────────────────────
// Stores video info keyed by chatId so we can retrieve it when the user
// taps a quality button (callback_query).
const sessions = new Map(); // chatId -> { url, title, uploader, duration_string, formats }

// ─── Helpers ────────────────────────────────────────────────────────────────
const urlRegex = /(https?:\/\/[^\s]+)/;

function formatNumber(n) {
  if (!n) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function truncate(str, max = 200) {
  if (!str) return '';
  return str.length > max ? str.substring(0, max) + '…' : str;
}

// Build a human-friendly quality label for a format object coming from /api/info
function buildQualityOptions(formats) {
  const options = [];

  // ── Audio Only ────────────────────────────────────────────────────────────
  options.push({ label: '🎵 Audio Only (MP3)', audioOnly: true, quality: null });

  // ── Video qualities  (deduplicated, lowest → highest height) ──────────────
  const heights = [360, 480, 720, 1080, 1440, 2160];
  const labels = {
    360:  '📱 Low Quality (360p)',
    480:  '📺 Standard (480p)',
    720:  '✨ HD (720p)',
    1080: '🔥 Full HD (1080p)',
    1440: '💎 2K (1440p)',
    2160: '🚀 4K Ultra HD (2160p)',
  };

  // Collect resolutions actually available in formats
  const availableHeights = new Set(
    formats
      .filter(f => f.has_video)
      .map(f => {
        const m = (f.resolution || '').match(/\d+x(\d+)/);
        return m ? parseInt(m[1]) : null;
      })
      .filter(Boolean)
  );

  for (const h of heights) {
    // Include if any available height is >= this threshold
    if ([...availableHeights].some(ah => ah >= h)) {
      options.push({ label: labels[h], audioOnly: false, quality: h });
    }
  }

  return options;
}

// ─── /start command ─────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId,
    `👋 *Welcome to OmniGrab Bot!*\n\n` +
    `I can download videos and audio from *1000+ sites* including:\n` +
    `📺 YouTube  •  📸 Instagram  •  🎵 TikTok  •  🐦 Twitter/X\n` +
    `📘 Facebook  •  👾 Reddit  •  🎮 Twitch  •  ☁️ SoundCloud\n\n` +
    `*How to use:*\nSimply paste any video link and I'll take care of the rest!\n\n` +
    `_Powered by OmniGrab`,
    `⚠️ *Limit:* Files over 50MB cannot be sent via Telegram bots. Try official website omnigrab.live for downloading videos upto 8k without any limitations`,
    { parse_mode: 'Markdown' }
  );
});

// ─── /help command ──────────────────────────────────────────────────────────
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId,
    `ℹ️ *OmniGrab Bot — Help*\n\n` +
    `*How to download:*\n` +
    `1️⃣ Paste any video URL in the chat\n` +
    `2️⃣ Wait while I analyze the link\n` +
    `3️⃣ Pick your preferred quality\n` +
    `4️⃣ Your file arrives right here!\n\n` +
    `*Supported Sites:*\n` +
    `YouTube · Instagram · TikTok · Twitter/X · Facebook · Reddit · Twitch · SoundCloud · Vimeo · Dailymotion · and 1000+ more\n\n` +
    `*Commands:*\n` +
    `/start — Welcome & intro\n` +
    `/help — This help page\n` +
    `/about — About OmniGrab Bot\n` +
    `/privacy — Privacy Policy\n` +
    `/terms — Terms of Service\n` +
    `/dmca — DMCA & Copyright\n\n` +
    `⚠️ *Limit:* Files over 50MB cannot be sent via Telegram bots. Try a lower quality.`,
    { parse_mode: 'Markdown' }
  );
});

// ─── /about command ──────────────────────────────────────────────────────────
bot.onText(/\/about/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId,
    `🤖 *About OmniGrab Bot*\n\n` +
    `OmniGrab Bot is the official Telegram companion to *omnigrab.live* — a free online video and audio downloader powered by yt-dlp.\n\n` +
    `*Features:*\n` +
    `• Download from 1000+ sites\n` +
    `• Choose quality: 4K, 1080p, 720p, 480p, 360p\n` +
    `• Audio-only download (MP3)\n` +
    `• Fast, free, no sign-up\n\n` +
    `*Website:* [omnigrab.live](https://omnigrab.live)\n\n` +
    `_This is a free bot provided as-is without any warranty. By using it you agree to our /terms._`,
    { parse_mode: 'Markdown', disable_web_page_preview: true }
  );
});

// ─── /privacy command ─────────────────────────────────────────────────────────
bot.onText(/\/privacy/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId,
    `🔒 *Privacy Policy*\n_Last updated: April 2025_\n\n` +
    `*What we collect:*\n` +
    `• Your Telegram chat ID and username (only to reply to your messages).\n` +
    `• The URLs you send (processed in real-time, never stored).\n\n` +
    `*What we DON'T collect:*\n` +
    `• We do NOT store, log, or share any video URLs you send.\n` +
    `• We do NOT store downloaded files — all temporary files are deleted immediately after being sent to you.\n` +
    `• We do NOT sell or share any personal data with third parties.\n\n` +
    `*Third-party services:*\n` +
    `This bot uses the OmniGrab backend (omnigrab.live) to extract download links. Please review [omnigrab.live](https://omnigrab.live) for its full privacy policy.\n\n` +
    `*Contact:* For privacy concerns, contact us via [omnigrab.live](https://omnigrab.live).`,
    { parse_mode: 'Markdown', disable_web_page_preview: true }
  );
});

// ─── /terms command ───────────────────────────────────────────────────────────
bot.onText(/\/terms/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId,
    `📋 *Terms of Service & Disclaimer*\n_Last updated: April 2025_\n\n` +
    `By using OmniGrab Bot, you agree to the following:\n\n` +
    `*1. Educational Use Only*\n` +
    `This bot is intended for downloading content that is non-copyrighted, in the public domain, or for which you have explicit permission from the rights holder.\n\n` +
    `*2. No Piracy*\n` +
    `You must NOT use this bot to download, reproduce, or distribute copyrighted content without authorization. Doing so may violate copyright laws in your jurisdiction.\n\n` +
    `*3. No Warranty*\n` +
    `This bot is provided \"as-is\" without any warranty. We are not liable for any damages, data loss, or legal consequences resulting from use of this bot.\n\n` +
    `*4. Service Availability*\n` +
    `We do not guarantee 100% uptime. The bot may be unavailable during maintenance.\n\n` +
    `*5. Changes*\n` +
    `These terms may change at any time without notice.`,
    { parse_mode: 'Markdown' }
  );
});

// ─── /dmca command ────────────────────────────────────────────────────────────
bot.onText(/\/dmca/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId,
    `⚖️ *DMCA & Copyright Policy*\n\n` +
    `OmniGrab Bot respects intellectual property rights and complies with the Digital Millennium Copyright Act (DMCA).\n\n` +
    `*Important:*\n` +
    `• OmniGrab does NOT host, store, or distribute any media content.\n` +
    `• We only provide a technical tool that extracts publicly available streaming URLs — the actual content is served directly from the original platform's CDN.\n` +
    `• All downloaded content is the sole responsibility of the user.\n\n` +
    `*To file a DMCA takedown request:*\n` +
    `If you believe content accessible through this bot infringes your copyright, please contact us via the OmniGrab website and we will investigate promptly.\n\n` +
    `📧 *Contact:* [omnigrab.live](https://omnigrab.live/dmca)\n\n` +
    `_Note: OmniGrab is a technical passthrough service. For takedowns at the source, please contact YouTube, Instagram, TikTok, or the relevant content platform directly._`,
    { parse_mode: 'Markdown', disable_web_page_preview: true }
  );
});

// ─── URL Message Handler ─────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || '';

  // Ignore commands
  if (text.startsWith('/')) return;

  const match = text.match(urlRegex);
  if (!match) {
    bot.sendMessage(chatId,
      `❓ I didn't recognize that as a video link.\n\nPlease paste a valid URL from YouTube, TikTok, Instagram, Twitter, etc.\n\nType /help for more info.`
    );
    return;
  }

  const targetUrl = match[1];
  let thinkingMsg;

  try {
    thinkingMsg = await bot.sendMessage(chatId, '🔍 *Analyzing link...*', { parse_mode: 'Markdown' });

    // ── Fetch video info from backend ─────────────────────────────────────
    const infoRes = await fetch(`${backendUrl}/api/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: targetUrl }),
    });

    if (!infoRes.ok) {
      const raw = await infoRes.text();
      console.error(`[INFO ERROR] ${infoRes.status}: ${raw}`);
      throw new Error('INFO_FAILED');
    }

    const info = await infoRes.json();
    const { title, uploader, view_count, duration_string, description, thumbnail, formats = [] } = info;

    // ── Save session ─────────────────────────────────────────────────────
    sessions.set(String(chatId), { url: targetUrl, title, uploader, duration_string, formats });

    // ── Build quality options ─────────────────────────────────────────────
    const qualityOptions = buildQualityOptions(formats);

    // ── Build inline keyboard (2 buttons per row) ─────────────────────────
    const keyboard = [];
    for (let i = 0; i < qualityOptions.length; i += 2) {
      const row = [];
      for (let j = i; j < Math.min(i + 2, qualityOptions.length); j++) {
        const opt = qualityOptions[j];
        const data = opt.audioOnly ? 'dl:audio' : `dl:video:${opt.quality}`;
        row.push({ text: opt.label, callback_data: data });
      }
      keyboard.push(row);
    }
    keyboard.push([{ text: '❌ Cancel', callback_data: 'dl:cancel' }]);

    // ── Caption ──────────────────────────────────────────────────────────
    const viewStr = view_count ? `👁 ${formatNumber(view_count)} views  ` : '';
    const durStr = duration_string ? `⏱ ${duration_string}` : '';
    const uploaderStr = uploader ? `\n👤 *${uploader}*` : '';
    const descStr = description ? `\n\n📝 ${truncate(description, 180)}` : '';

    const caption =
      `🎬 *${truncate(title, 100)}*${uploaderStr}\n` +
      `${viewStr}${durStr}${descStr}\n\n` +
      `*Choose your download format:*`;

    // ── Delete thinking message, send info card ───────────────────────────
    await bot.deleteMessage(chatId, thinkingMsg.message_id).catch(() => {});

    if (thumbnail) {
      await bot.sendPhoto(chatId, thumbnail, {
        caption,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard },
      });
    } else {
      await bot.sendMessage(chatId, caption, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard },
      });
    }

  } catch (err) {
    console.error(`[ERROR] analyze: ${err.message}`);
    if (thinkingMsg) {
      await bot.editMessageText(
        `❌ *Failed to analyze this link.*\n\nPlease make sure:\n• The link is publicly accessible\n• The video exists and isn't private`,
        { chat_id: chatId, message_id: thinkingMsg.message_id, parse_mode: 'Markdown' }
      ).catch(() => {});
    }
  }
});

// ─── Callback Query Handler (Quality Selection) ──────────────────────────────
bot.on('callback_query', async (query) => {
  const chatId = String(query.message.chat.id);
  const messageId = query.message.message_id;
  const data = query.data;

  // Acknowledge the button tap
  await bot.answerCallbackQuery(query.id);

  if (data === 'dl:cancel') {
    await bot.editMessageCaption('❌ Download cancelled.', {
      chat_id: chatId,
      message_id: messageId,
    }).catch(() => bot.editMessageText('❌ Download cancelled.', { chat_id: chatId, message_id: messageId }));
    sessions.delete(chatId);
    return;
  }

  const session = sessions.get(chatId);
  if (!session) {
    await bot.sendMessage(chatId, '⚠️ Session expired. Please send the link again.');
    return;
  }

  sessions.delete(chatId);

  const { url, title } = session;
  const isAudio = data === 'dl:audio';
  const quality = !isAudio ? parseInt(data.split(':')[2]) : null;

  const qualityLabel = isAudio
    ? '🎵 Audio (MP3)'
    : quality === 1080 ? '🔥 Full HD (1080p)'
    : quality === 720  ? '✨ HD (720p)'
    : quality === 480  ? '📺 Standard (480p)'
    : quality === 360  ? '📱 Low Quality (360p)'
    : `${quality}p`;

  let statusMsg;
  let tempDir;
  let downloadedFile;

  try {
    // Remove inline keyboard from info card
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: chatId, message_id: messageId
    }).catch(() => {});

    statusMsg = await bot.sendMessage(chatId,
      `⏳ *Downloading ${qualityLabel}...*\n_This might take a moment depending on the file size._`,
      { parse_mode: 'Markdown' }
    );

    // ── Get CDN URL from backend ─────────────────────────────────────────
    const urlsPayload = isAudio
      ? { url, audioOnly: true }
      : { url, quality, preferMuxed: true };

    const urlsRes = await fetch(`${backendUrl}/api/urls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(urlsPayload),
    });

    if (!urlsRes.ok) {
      const raw = await urlsRes.text();
      console.error(`[URLS ERROR] ${urlsRes.status}: ${raw}`);
      throw new Error('URLS_FAILED');
    }

    const urlData = await urlsRes.json();
    if (!urlData.urls || urlData.urls.length === 0) throw new Error('URLS_EMPTY');

    const cdnUrl = urlData.urls[0];
    console.log(`[DL] Downloading (${qualityLabel}) for chat ${chatId}: ${url}`);

    // ── Stream file via proxy with live progress ───────────────────────────
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnigrab-'));
    const ext = isAudio ? 'mp3' : 'mp4';
    downloadedFile = path.join(tempDir, `download.${ext}`);

    const proxyUrl = new URL(`${backendUrl}/api/proxy`);
    proxyUrl.searchParams.set('url', cdnUrl);

    const fileRes = await fetch(proxyUrl.toString());
    if (!fileRes.ok) throw new Error('DOWNLOAD_FAILED');

    const totalBytes = parseInt(fileRes.headers.get('content-length') || '0');
    if (totalBytes > 50 * 1024 * 1024) throw new Error('FILE_TOO_LARGE');

    // Helper: build a visual progress bar string
    function buildProgressMsg(received, total, startTime) {
      const elapsed = (Date.now() - startTime) / 1000; // seconds
      const speed = elapsed > 0 ? received / elapsed : 0; // bytes/s
      const speedStr = speed > 1_048_576
        ? `${(speed / 1_048_576).toFixed(1)} MB/s`
        : `${(speed / 1024).toFixed(0)} KB/s`;

      if (total > 0) {
        const pct = Math.min(100, Math.round((received / total) * 100));
        const filled = Math.round(pct / 10);
        const bar = '▓'.repeat(filled) + '░'.repeat(10 - filled);
        const receivedMB = (received / 1_048_576).toFixed(1);
        const totalMB   = (total   / 1_048_576).toFixed(1);
        const eta = speed > 0 ? Math.ceil((total - received) / speed) : 0;
        const etaStr = eta > 60 ? `${Math.floor(eta / 60)}m ${eta % 60}s` : `${eta}s`;
        return (
          `📥 *Downloading ${qualityLabel}*\n\n` +
          `${bar} ${pct}%\n\n` +
          `📦 ${receivedMB} / ${totalMB} MB\n` +
          `⚡ ${speedStr}  •  ⏳ ETA: ${etaStr}`
        );
      } else {
        // No content-length — show rolling size + speed
        const receivedMB = (received / 1_048_576).toFixed(1);
        return (
          `📥 *Downloading ${qualityLabel}*\n\n` +
          `⬇️ ${receivedMB} MB downloaded\n` +
          `⚡ ${speedStr}`
        );
      }
    }

    await bot.editMessageText(
      `📥 *Downloading ${qualityLabel}*\n\n░░░░░░░░░░ 0%\n\n_Starting download..._`,
      { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
    );

    // Manual chunk-by-chunk stream so we can track progress
    await new Promise((resolve, reject) => {
      let received = 0;
      let lastEditAt = 0;
      const startTime = Date.now();
      const dest = fs.createWriteStream(downloadedFile);

      const bodyStream = Readable.fromWeb(fileRes.body);

      bodyStream.on('data', (chunk) => {
        received += chunk.length;
        dest.write(chunk);

        // Update Telegram message at most once every 2.5 seconds (rate-limit safe)
        const now = Date.now();
        if (now - lastEditAt > 2500) {
          lastEditAt = now;
          bot.editMessageText(
            buildProgressMsg(received, totalBytes, startTime),
            { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
          ).catch(() => {}); // ignore rate-limit errors
        }
      });

      bodyStream.on('end', () => dest.end());
      bodyStream.on('error', reject);
      dest.on('finish', resolve);
      dest.on('error', reject);
    });

    const stats = fs.statSync(downloadedFile);
    if (stats.size > 50 * 1024 * 1024 || stats.size === 0) throw new Error('FILE_TOO_LARGE');

    // ── Upload to Telegram ────────────────────────────────────────────────
    await bot.editMessageText(
      `📤 *Uploading to Telegram...*`,
      { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
    );

    const caption = `✅ *${truncate(title, 80)}*\n📦 ${qualityLabel}\n\n_Downloaded via OmniGrab Bot_`;

    if (isAudio) {
      await bot.sendAudio(chatId, downloadedFile, { caption, parse_mode: 'Markdown' });
    } else {
      await bot.sendVideo(chatId, downloadedFile, { caption, parse_mode: 'Markdown', supports_streaming: true });
    }

    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    console.log(`[DL] ✅ Success (${qualityLabel}) → chat ${chatId}`);

  } catch (err) {
    console.error(`[ERROR] download: ${err.message}`);

    let errorText = '❌ *Download failed.*\n\nSomething went wrong while downloading. Please try again.';
    if (err.message === 'FILE_TOO_LARGE') {
      errorText = '❌ *File Too Large*\n\nThis video exceeds Telegram\'s 50MB limit for bots. Try a lower quality.';
    } else if (err.message === 'URLS_FAILED' || err.message === 'URLS_EMPTY') {
      errorText = '❌ *Could not extract download link.*\n\nThe video may be restricted or region-locked. Try another link.';
    }

    if (statusMsg) {
      await bot.editMessageText(errorText, {
        chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown'
      }).catch(() => {});
    } else {
      await bot.sendMessage(chatId, errorText, { parse_mode: 'Markdown' });
    }
  } finally {
    if (downloadedFile && fs.existsSync(downloadedFile)) fs.unlinkSync(downloadedFile);
    if (tempDir && fs.existsSync(tempDir)) fs.rmdirSync(tempDir, { recursive: true });
  }
});

// ─── Health Check HTTP Server (Render.com requirement) ──────────────────────
const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OmniGrab Bot is running!');
}).listen(PORT, () => {
  console.log(`🌐 Health server on port ${PORT}`);
});

// ─── Graceful Exit ───────────────────────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down OmniGrab Bot...');
  bot.stopPolling();
  process.exit(0);
});
