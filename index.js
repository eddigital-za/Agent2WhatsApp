const express = require("express");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());
app.use(cors());

const MEDIA_DIR = path.join("/tmp", "whatsapp-media");
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
app.use("/media", express.static(MEDIA_DIR, { fallthrough: false, maxAge: "1h" }));

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: "/app/.wwebjs_auth" }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

let latestQr = null;

app.get("/qr", (req, res) => {
  if (!latestQr) return res.send("<html><body style='font-family:Arial;text-align:center;padding:40px'><h2>Waiting for WhatsApp QR...</h2><p>Refresh this page in a few seconds.</p></body></html>");
  res.send(`<!DOCTYPE html><html><head><title>WhatsApp QR</title><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script></head><body style="font-family:Arial;text-align:center;padding:40px"><h2>Link WhatsApp</h2><p>WhatsApp → Linked Devices → Link a Device</p><div id="qrcode" style="display:inline-block;margin-top:20px"></div><script>new QRCode(document.getElementById("qrcode"),{text:${JSON.stringify(latestQr)},width:320,height:320});</script></body></html>`);
});

client.on("qr", (qr) => { latestQr = qr; console.log("New WhatsApp QR generated. Open /qr to scan it."); });
client.on("ready", () => console.log("WhatsApp Session is Ready and Connected!"));
client.on("authenticated", () => { latestQr = null; console.log("WhatsApp Session authenticated successfully!"); });

async function resolveFreshMessage(message) {
  if (!message?.hasMedia || !message.from?.endsWith("@g.us")) return message;
  try {
    const chat = await message.getChat();
    const recent = await chat.fetchMessages({ limit: 30 });
    const fresh = recent.find((candidate) =>
      candidate?.id?.id === message.id?.id ||
      (candidate?.timestamp === message.timestamp && candidate?.body === message.body && candidate?.type === message.type)
    );
    if (fresh) {
      console.log("Using fresh group message object for media download");
      return fresh;
    }
  } catch (error) {
    console.error("Could not refresh group message before media download:", error?.message || error);
  }
  return message;
}

client.on("message", async (message) => {
  try {
    if (message.fromMe) return;

    const ALLOWED_DIRECT_ID = process.env.ALLOWED_DIRECT_ID || "263311610368253@lid";
    const ALLOWED_GROUP_ID = process.env.ALLOWED_GROUP_ID;
    const isGroup = message.from.endsWith("@g.us");

    if (isGroup) {
      if (!ALLOWED_GROUP_ID) { console.log("GROUP DETECTED:", message.from); return; }
      if (message.from !== ALLOWED_GROUP_ID) { console.log("Ignored group message from:", message.from); return; }
    } else if (message.from !== ALLOWED_DIRECT_ID) return;

    const payload = {
      from: message.from,
      phone: message.from.replace("@c.us", ""),
      text: message.body || "",
      messageId: message.id?._serialized || "",
      timestamp: message.timestamp,
      type: message.type,
      hasMedia: message.hasMedia,
      mediaType: null,
      mediaFilename: null,
      mediaData: null,
      mediaUrl: null,
      media: null,
    };

    if (message.hasMedia) {
      try {
        let mediaMessage = await resolveFreshMessage(message);

        // Preserve the proven LID workaround for direct messages. Do not synthesize
        // group IDs: group media needs the participant metadata on the fresh object.
        if (!mediaMessage.from?.endsWith("@g.us") && mediaMessage.id && !mediaMessage.id._serialized && mediaMessage.id.fromMe !== undefined && mediaMessage.id.remote && mediaMessage.id.id) {
          mediaMessage.id._serialized = `${mediaMessage.id.fromMe}_${mediaMessage.id.remote}_${mediaMessage.id.id}`;
          console.log("Reconstructed WhatsApp message ID for media download:", mediaMessage.id._serialized);
        }

        let media = await mediaMessage.downloadMedia();
        if (!media && isGroup) {
          console.log("Group media download returned nothing; retrying once");
          await new Promise((resolve) => setTimeout(resolve, 1500));
          mediaMessage = await resolveFreshMessage(message);
          media = await mediaMessage.downloadMedia();
        }

        if (media) {
          const extensions = { "image/jpeg":"jpg", "image/png":"png", "image/webp":"webp", "image/gif":"gif", "video/mp4":"mp4", "video/quicktime":"mov" };
          const extension = extensions[media.mimetype] || "bin";
          const generatedFilename = `whatsapp-${message.type || "media"}-${message.timestamp}-${Date.now()}.${extension}`;
          const finalFilename = path.basename(media.filename || generatedFilename).replace(/[^a-zA-Z0-9._-]/g, "_");
          const mediaBuffer = Buffer.from(media.data || "", "base64");
          const mediaFilePath = path.join(MEDIA_DIR, finalFilename);
          fs.writeFileSync(mediaFilePath, mediaBuffer);

          const publicBaseUrl = process.env.PUBLIC_BASE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);
          if (publicBaseUrl) payload.mediaUrl = `${publicBaseUrl.replace(/\/$/, "")}/media/${encodeURIComponent(finalFilename)}`;
          else console.error("Could not generate mediaUrl. Set PUBLIC_BASE_URL or ensure RAILWAY_PUBLIC_DOMAIN exists.");

          payload.mediaType = media.mimetype || "";
          payload.mediaFilename = finalFilename;
          payload.mediaData = media.data || "";
          payload.media = { mimetype: media.mimetype || "", filename: finalFilename, data: media.data || "", url: payload.mediaUrl };
          console.log("Media downloaded:", media.mimetype, finalFilename);
          console.log("Media saved:", mediaFilePath);
          console.log("Public media URL:", payload.mediaUrl);
        } else {
          payload.media = { error: "downloadMedia returned no data" };
          console.error("Message reported media, but downloadMedia returned nothing");
        }
      } catch (mediaError) {
        payload.media = { error: "downloadMedia failed", details: mediaError?.message || String(mediaError) };
        console.error("Media download failed:", mediaError?.message || mediaError);
      }
    }

    console.log("Incoming WhatsApp message:", {
      from: payload.from, phone: payload.phone, text: payload.text, messageId: payload.messageId,
      timestamp: payload.timestamp, type: payload.type, hasMedia: payload.hasMedia,
      mediaType: payload.mediaType, mediaFilename: payload.mediaFilename,
      mediaDataPresent: Boolean(payload.mediaData), mediaUrl: payload.mediaUrl,
    });

    if (!process.env.MAKE_WEBHOOK_URL) { console.error("MAKE_WEBHOOK_URL is not configured"); return; }
    const response = await fetch(process.env.MAKE_WEBHOOK_URL, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    if (!response.ok) { console.error("Make webhook failed:", response.status, await response.text()); return; }
    console.log("Message forwarded to Make successfully");
  } catch (error) {
    console.error("Error forwarding WhatsApp message to Make:", error);
  }
});

client.on("auth_failure", (message) => console.error("Authentication failed:", message));
client.on("disconnected", (reason) => console.log("WhatsApp client disconnected:", reason));

app.get("/debug/groups", async (req, res) => {
  try {
    if (!process.env.GROUPS_DEBUG_TOKEN || req.query.token !== process.env.GROUPS_DEBUG_TOKEN) return res.status(403).end();
    if (!client.info) return res.status(503).json({ error: "Session not ready" });
    const chats = await client.getChats();
    res.status(200).json(chats.filter((chat) => chat.isGroup).map((chat) => ({ name: chat.name, id: chat.id._serialized })));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post("/send", async (req, res) => {
  try {
    const { phone, chatId, text } = req.body;
    if (!text) return res.status(400).send({ error: "Text is required" });
    if (!client.info) return res.status(503).send({ error: "WhatsApp session not ready. Scan QR code at /qr endpoint first.", ready: false });
    let targetChatId;
    if (chatId) {
      if (!chatId.endsWith("@g.us") && !chatId.endsWith("@c.us")) return res.status(400).send({ error: "Invalid chatId. Must end with @g.us (group) or @c.us (direct)." });
      targetChatId = chatId;
    } else if (phone) targetChatId = `${phone.replace(/\D/g, "")}@c.us`;
    else return res.status(400).send({ error: "Either phone or chatId is required" });
    await client.sendMessage(targetChatId, text);
    res.status(200).send({ success: true, message: "Message sent successfully" });
  } catch (error) { console.error("Error sending message:", error); res.status(500).send({ error: error.message }); }
});

function removeChromiumLocks(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) { removeChromiumLocks(fullPath); continue; }
    if (["SingletonLock","SingletonSocket","SingletonCookie"].includes(entry.name)) {
      try { fs.unlinkSync(fullPath); console.log(`Removed stale Chromium lock: ${fullPath}`); }
      catch (error) { console.error(`Could not remove lock ${fullPath}:`, error.message); }
    }
  }
}
removeChromiumLocks("/app/.wwebjs_auth");

function cleanupOldMediaFiles() {
  try {
    if (!fs.existsSync(MEDIA_DIR)) return;
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    for (const entry of fs.readdirSync(MEDIA_DIR, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const filePath = path.join(MEDIA_DIR, entry.name);
      try {
        if (fs.statSync(filePath).mtimeMs < oneHourAgo) { fs.unlinkSync(filePath); console.log(`Removed old temporary media file: ${filePath}`); }
      } catch (error) { console.error(`Could not inspect/remove temporary media file ${filePath}:`, error.message); }
    }
  } catch (error) { console.error("Temporary media cleanup failed:", error.message); }
}
setInterval(cleanupOldMediaFiles, 15 * 60 * 1000);

client.initialize();
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Microservice running on port ${PORT}`));
