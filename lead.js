const express = require("express");
const { Client, LocalAuth } = require("whatsapp-web.js");

const app = express();
app.use(express.json({ limit: "2mb" }));

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: "/app/.wwebjs_auth" }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

let latestQr = null;

app.get("/health", (req, res) => {
  res.json({ ok: true, whatsappReady: Boolean(client.info) });
});

app.get("/qr", (req, res) => {
  if (!latestQr) {
    return res.send("<html><body style='font-family:Arial;text-align:center;padding:40px'><h2>Waiting for WhatsApp QR...</h2><p>If already linked, the session may simply be starting.</p></body></html>");
  }
  res.send(`<!DOCTYPE html><html><head><title>WhatsApp QR</title><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script></head><body style="font-family:Arial;text-align:center;padding:40px"><h2>Link BTSA Lead Follow-up Agent</h2><p>WhatsApp → Linked Devices → Link a Device</p><div id="qrcode"></div><script>new QRCode(document.getElementById("qrcode"),{text:${JSON.stringify(latestQr)},width:320,height:320});</script></body></html>`);
});

client.on("qr", qr => {
  latestQr = qr;
  console.log("New WhatsApp QR generated. Open /qr to scan it.");
});

client.on("authenticated", () => {
  latestQr = null;
  console.log("WhatsApp authenticated.");
});

client.on("ready", () => console.log("BTSA Lead Follow-up WhatsApp is ready."));
client.on("auth_failure", message => console.error("Authentication failed:", message));
client.on("disconnected", reason => console.log("WhatsApp disconnected:", reason));

async function postToMake(payload) {
  if (!process.env.MAKE_WEBHOOK_URL) {
    console.error("MAKE_WEBHOOK_URL is not configured");
    return;
  }

  const response = await fetch(process.env.MAKE_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Make webhook failed: HTTP ${response.status} ${await response.text()}`);
  }
}

client.on("message", async message => {
  try {
    if (message.fromMe) return;
    if (message.from.endsWith("@g.us")) return;

    let phone = "";
    try {
      const contact = await message.getContact();
      phone = contact?.number || "";
    } catch (_) {}

    if (!phone && message.from.endsWith("@c.us")) {
      phone = message.from.replace("@c.us", "");
    }

    const payload = {
      event: "inbound_message",
      chatId: message.from,
      phone,
      text: message.body || "",
      messageId: message.id?._serialized || "",
      timestamp: message.timestamp,
      type: message.type,
      hasMedia: Boolean(message.hasMedia),
    };

    console.log("Inbound client WhatsApp message:", {
      phone: payload.phone,
      chatId: payload.chatId,
      type: payload.type,
      hasMedia: payload.hasMedia,
    });

    await postToMake(payload);
    console.log("Inbound message forwarded to Make.");
  } catch (error) {
    console.error("Inbound forwarding error:", error.message || error);
  }
});

app.post("/send", async (req, res) => {
  try {
    const { phone, chatId, text } = req.body || {};

    if (!text) return res.status(400).json({ error: "Text is required" });
    if (!client.info) return res.status(503).json({ error: "WhatsApp session not ready", ready: false });

    let targetChatId = chatId;
    if (!targetChatId && phone) {
      const digits = String(phone).replace(/\D/g, "");
      if (!digits) return res.status(400).json({ error: "Valid phone or chatId is required" });
      targetChatId = `${digits}@c.us`;
    }

    if (!targetChatId) return res.status(400).json({ error: "Either phone or chatId is required" });

    const result = await client.sendMessage(targetChatId, text);
    res.json({ success: true, messageId: result?.id?._serialized || null, chatId: targetChatId });
  } catch (error) {
    console.error("Send error:", error.message || error);
    res.status(500).json({ error: error.message || String(error) });
  }
});

function removeChromiumLocks(dir) {
  const fs = require("fs");
  const path = require("path");
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      removeChromiumLocks(fullPath);
      continue;
    }
    if (["SingletonLock", "SingletonSocket", "SingletonCookie"].includes(entry.name)) {
      try { fs.unlinkSync(fullPath); } catch (_) {}
    }
  }
}

removeChromiumLocks("/app/.wwebjs_auth");
client.initialize();

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`BTSA Lead Follow-up service listening on ${PORT}`));
