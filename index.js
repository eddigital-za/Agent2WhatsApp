const express = require("express");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "30mb" }));
app.use(cors());

const MEDIA_DIR = path.join("/tmp", "whatsapp-media");
const STATE_FILE = "/app/.wwebjs_auth/btsa-social-pending.json";
const PUBLISH_WEBHOOK_URL = "https://hook.eu2.make.com/yijj3ssp95599eb7qfbarmogpcbwffdb";
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
app.use("/media", express.static(MEDIA_DIR, { fallthrough: false, maxAge: "1h" }));

function loadPending() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch (_) { return null; }
}
function savePending(value) {
  try {
    if (value) fs.writeFileSync(STATE_FILE, JSON.stringify(value));
    else if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  } catch (e) { console.error("Pending-state write failed:", e.message); }
}

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
  res.send(`<!DOCTYPE html><html><head><title>WhatsApp QR</title><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script></head><body style="font-family:Arial;text-align:center;padding:40px"><h2>Link WhatsApp</h2><p>WhatsApp → Linked Devices → Link a Device</p><div id="qrcode"></div><script>new QRCode(document.getElementById("qrcode"),{text:${JSON.stringify(latestQr)},width:320,height:320});</script></body></html>`);
});
client.on("qr", qr => { latestQr = qr; console.log("New WhatsApp QR generated. Open /qr to scan it."); });
client.on("ready", () => console.log("WhatsApp Session is Ready and Connected!"));
client.on("authenticated", () => { latestQr = null; console.log("WhatsApp Session authenticated successfully!"); });

function repairSerializedMessageId(message) {
  const id = message?.id;
  if (!id) return null;
  const serialized = id._serialized || id.$1 ||
    (id.fromMe !== undefined && id.remote && id.id ? `${id.fromMe}_${id.remote}_${id.id}` : null);
  if (serialized && !id._serialized) {
    id._serialized = serialized;
    console.log("Repaired WhatsApp serialized message ID:", serialized);
  }
  return serialized;
}

async function downloadMediaFromEventData(message) {
  const d = message?._data || {};
  const mediaArgs = {
    directPath: d.directPath, encFilehash: d.encFilehash, filehash: d.filehash,
    mediaKey: d.mediaKey, mediaKeyTimestamp: d.mediaKeyTimestamp,
    type: d.type || message.type, mimetype: d.mimetype, filename: d.filename || null,
  };
  if (!mediaArgs.directPath || !mediaArgs.mediaKey) throw new Error("event media metadata incomplete");
  return await client.pupPage.evaluate(async (args) => {
    const managerModule = window.require("WAWebDownloadManager");
    const manager = managerModule.downloadManager || managerModule;
    const mockQpl = { addAnnotations() { return this; }, addPoint() { return this; } };
    const decrypted = await manager.downloadAndMaybeDecrypt({
      directPath: args.directPath, encFilehash: args.encFilehash, filehash: args.filehash,
      mediaKey: args.mediaKey, mediaKeyTimestamp: args.mediaKeyTimestamp, type: args.type,
      signal: new AbortController().signal, downloadQpl: mockQpl,
    });
    const data = await window.WWebJS.arrayBufferToBase64Async(decrypted);
    return { data, mimetype: args.mimetype || "application/octet-stream", filename: args.filename || null };
  }, mediaArgs);
}

async function getInboundMedia(message) {
  try {
    const media = await message.downloadMedia();
    if (media?.data) return media;
    throw new Error("downloadMedia returned no data");
  } catch (primaryError) {
    console.warn("Standard downloadMedia failed; using event-data fallback:", primaryError?.message || String(primaryError));
    const media = await downloadMediaFromEventData(message);
    if (!media?.data) throw new Error("event-data fallback returned no data");
    console.log("Event-data media fallback succeeded");
    return media;
  }
}

async function postJson(url, payload) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response;
}

client.on("message", async (message) => {
  try {
    if (message.fromMe) return;
    const ALLOWED_DIRECT_ID = process.env.ALLOWED_DIRECT_ID || "263311610368253@lid";
    const ALLOWED_GROUP_ID = process.env.ALLOWED_GROUP_ID;
    const isGroup = message.from.endsWith("@g.us");
    if (isGroup) {
      if (!ALLOWED_GROUP_ID) { console.log("GROUP DETECTED:", message.from); return; }
      if (message.from !== ALLOWED_GROUP_ID) return;
    } else if (message.from !== ALLOWED_DIRECT_ID) return;

    const incomingText = (message.body || "").trim();
    const command = incomingText.toLowerCase();
    const pending = loadPending();

    if (!message.hasMedia && pending && /^(approve|approved|post|publish)(\s|$)/i.test(command)) {
      console.log("Approval received for pending social draft");
      await postJson(PUBLISH_WEBHOOK_URL, {
        action: "approve",
        chatId: message.from,
        caption: pending.caption,
        imageUrl: pending.imageUrl,
        mediaType: pending.mediaType || "image/jpeg",
        originalContext: pending.originalContext || "",
        draftCreatedAt: pending.createdAt || null,
      });
      return;
    }

    if (!message.hasMedia && pending && /^(edit|change|revise|rewrite)(:|\s|$)/i.test(command)) {
      const editInstruction = incomingText.replace(/^(edit|change|revise|rewrite)\s*:?\s*/i, "").trim();
      if (!editInstruction) {
        await client.sendMessage(message.from, "Send the change after EDIT, for example: EDIT: remove the model name");
        return;
      }
      console.log("Edit received for pending social draft");
      const editPayload = {
        from: message.from,
        phone: message.from.replace("@c.us", ""),
        text: `EDIT REQUEST: ${editInstruction}\nCURRENT DRAFT: ${pending.caption}\nORIGINAL CONTEXT: ${pending.originalContext || ""}`,
        messageId: repairSerializedMessageId(message) || "",
        timestamp: message.timestamp,
        type: "image",
        hasMedia: true,
        mediaType: pending.mediaType || "image/jpeg",
        mediaFilename: pending.mediaFilename || "approved-source.jpg",
        mediaData: pending.mediaData || null,
        mediaUrl: pending.imageUrl || null,
        media: { mimetype: pending.mediaType || "image/jpeg", filename: pending.mediaFilename || "approved-source.jpg", data: pending.mediaData || "", url: pending.imageUrl || null },
      };
      if (!process.env.MAKE_WEBHOOK_URL) throw new Error("MAKE_WEBHOOK_URL is not configured");
      await postJson(process.env.MAKE_WEBHOOK_URL, editPayload);
      return;
    }

    const repairedId = repairSerializedMessageId(message);
    const payload = {
      from: message.from, phone: message.from.replace("@c.us", ""), text: message.body || "",
      messageId: repairedId || "", timestamp: message.timestamp, type: message.type,
      hasMedia: message.hasMedia, mediaType: null, mediaFilename: null, mediaData: null, mediaUrl: null, media: null,
    };

    if (message.hasMedia) {
      try {
        const media = await getInboundMedia(message);
        const extensions = { "image/jpeg":"jpg", "image/png":"png", "image/webp":"webp", "image/gif":"gif", "video/mp4":"mp4", "video/quicktime":"mov" };
        const extension = extensions[media.mimetype] || "bin";
        const generatedFilename = `whatsapp-${message.type || "media"}-${message.timestamp}-${Date.now()}.${extension}`;
        const finalFilename = path.basename(media.filename || generatedFilename).replace(/[^a-zA-Z0-9._-]/g, "_");
        const mediaFilePath = path.join(MEDIA_DIR, finalFilename);
        fs.writeFileSync(mediaFilePath, Buffer.from(media.data || "", "base64"));
        const publicBaseUrl = process.env.PUBLIC_BASE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);
        if (publicBaseUrl) payload.mediaUrl = `${publicBaseUrl.replace(/\/$/, "")}/media/${encodeURIComponent(finalFilename)}`;
        payload.mediaType = media.mimetype || "";
        payload.mediaFilename = finalFilename;
        payload.mediaData = media.data || "";
        payload.media = { mimetype: media.mimetype || "", filename: finalFilename, data: media.data || "", url: payload.mediaUrl };
        console.log("Media downloaded:", media.mimetype, finalFilename);
        console.log("Public media URL:", payload.mediaUrl);
      } catch (mediaError) {
        payload.media = { error: "downloadMedia failed", details: mediaError?.message || String(mediaError) };
        console.error("Media download failed after fallback:", mediaError?.message || mediaError);
      }
    }

    console.log("Incoming WhatsApp message:", {
      from: payload.from, text: payload.text, messageId: payload.messageId, type: payload.type,
      hasMedia: payload.hasMedia, mediaType: payload.mediaType, mediaFilename: payload.mediaFilename,
      mediaDataPresent: Boolean(payload.mediaData), mediaUrl: payload.mediaUrl,
    });
    if (!process.env.MAKE_WEBHOOK_URL) return console.error("MAKE_WEBHOOK_URL is not configured");
    const response = await fetch(process.env.MAKE_WEBHOOK_URL, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    if (!response.ok) return console.error("Make webhook failed:", response.status, await response.text());
    console.log("Message forwarded to Make successfully");
  } catch (error) { console.error("Error forwarding WhatsApp message to Make:", error); }
});

client.on("auth_failure", message => console.error("Authentication failed:", message));
client.on("disconnected", reason => console.log("WhatsApp client disconnected:", reason));

app.post("/send", async (req, res) => {
  try {
    const { phone, chatId, text, imageUrl, mediaUrl, mediaType, mediaFilename, mediaData, originalContext, saveDraft, sendImage } = req.body;
    if (!text) return res.status(400).send({ error: "Text is required" });
    if (!client.info) return res.status(503).send({ error: "WhatsApp session not ready", ready: false });
    let targetChatId;
    if (chatId) targetChatId = chatId;
    else if (phone) targetChatId = `${phone.replace(/\D/g, "")}@c.us`;
    else return res.status(400).send({ error: "Either phone or chatId is required" });

    const finalImageUrl = imageUrl || mediaUrl || null;
    if (saveDraft || finalImageUrl) {
      savePending({
        chatId: targetChatId, caption: text, imageUrl: finalImageUrl,
        mediaType: mediaType || "image/jpeg", mediaFilename: mediaFilename || null,
        mediaData: mediaData || null, originalContext: originalContext || "", createdAt: new Date().toISOString(),
      });
      console.log("Pending social draft saved for approval");
    }

    if (sendImage && finalImageUrl) {
      const media = await MessageMedia.fromUrl(finalImageUrl, { unsafeMime: true });
      await client.sendMessage(targetChatId, media, { caption: text });
    } else {
      await client.sendMessage(targetChatId, text);
    }
    res.status(200).send({ success: true });
  } catch (error) { res.status(500).send({ error: error.message }); }
});

function removeChromiumLocks(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) { removeChromiumLocks(fullPath); continue; }
    if (["SingletonLock","SingletonSocket","SingletonCookie"].includes(entry.name)) {
      try { fs.unlinkSync(fullPath); } catch (_) {}
    }
  }
}
removeChromiumLocks("/app/.wwebjs_auth");
client.initialize();
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Microservice running on port ${PORT}`));