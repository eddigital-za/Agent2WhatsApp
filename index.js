const express = require("express");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

// Create the Express application
const app = express();

// Parse JSON request bodies
app.use(express.json());

// Allow cross-origin requests for easier integration
app.use(cors());

// Initialize the WhatsApp client with LocalAuth so the session is stored locally
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

let latestQr = null;

app.get("/qr", (req, res) => {
  if (!latestQr) {
    return res.send(`
      <html>
        <body style="font-family:Arial;text-align:center;padding:40px;">
          <h2>Waiting for WhatsApp QR...</h2>
          <p>Refresh this page in a few seconds.</p>
        </body>
      </html>
    `);
  }

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>WhatsApp QR</title>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
      </head>
      <body style="font-family:Arial;text-align:center;padding:40px;">
        <h2>Link WhatsApp</h2>
        <p>WhatsApp → Linked Devices → Link a Device</p>

        <div id="qrcode" style="display:inline-block;margin-top:20px;"></div>

        <script>
          new QRCode(document.getElementById("qrcode"), {
            text: ${JSON.stringify("${latestQr}")},
            width: 320,
            height: 320
          });
        </script>
      </body>
    </html>
  `.replace('"${latestQr}"', JSON.stringify(latestQr)));
});

// Log the QR code to the terminal so it can be scanned from the WhatsApp app
client.on("qr", (qr) => {
  latestQr = qr;
  console.log("New WhatsApp QR generated. Open /qr to scan it.");
});

// Log when the WhatsApp client is ready
client.on("ready", () => {
  console.log("WhatsApp Session is Ready and Connected!");
});

// Forward incoming WhatsApp messages to Make.com
client.on("message", async (message) => {
  try {
    // Ignore messages sent by this WhatsApp account itself
    if (message.fromMe) return;

    // Allowed direct controller
    const ALLOWED_DIRECT_ID =
      process.env.ALLOWED_DIRECT_ID || "263311610368253@lid";

    // Allowed BTSA Social group
    const ALLOWED_GROUP_ID = process.env.ALLOWED_GROUP_ID;

    // Check whether this is a group message
    const isGroup = message.from.endsWith("@g.us");

    if (isGroup) {
      // Until we know the BTSA Social group ID, log group IDs but DO NOT forward them
      if (!ALLOWED_GROUP_ID) {
        console.log("GROUP DETECTED:", message.from, message.body);
        return;
      }

      // Ignore every group except BTSA Social
      if (message.from !== ALLOWED_GROUP_ID) {
        return;
      }
    } else {
      // Ignore every direct message except yours
      if (message.from !== ALLOWED_DIRECT_ID) {
        return;
      }
    }

    const payload = {
      from: message.from,
      phone: message.from.replace("@c.us", ""),
      text: message.body || "",
      messageId: message.id?._serialized || "",
      timestamp: message.timestamp,
      type: message.type,
      hasMedia: message.hasMedia,
      media: null,
    };

    // Download attached media if present
    if (message.hasMedia) {
  try {
    // Work around current whatsapp-web.js @lid media bug where
// message.id._serialized may be missing on incoming media.
if (
  message.id &&
  !message.id._serialized &&
  message.id.fromMe !== undefined &&
  message.id.remote &&
  message.id.id
) {
  message.id._serialized =
    `${message.id.fromMe}_${message.id.remote}_${message.id.id}`;

  console.log(
    "Reconstructed WhatsApp message ID for media download:",
    message.id._serialized
  );
}
    const media = await message.downloadMedia();

    if (media) {
      payload.media = {
        mimetype: media.mimetype || "",
        filename: media.filename || "",
        data: media.data || "",
      };

      console.log(
        "Media downloaded:",
        media.mimetype,
        media.filename || "no filename"
      );
    } else {
      payload.media = {
        error: "downloadMedia returned no data",
      };

      console.error(
        "Message reported media, but downloadMedia returned nothing"
      );
    }
  } catch (mediaError) {
    payload.media = {
      error: "downloadMedia failed",
      details: mediaError?.message || String(mediaError),
    };

    console.error(
      "Media download failed:",
      mediaError?.message || mediaError
    );
  }
}

    console.log("Incoming WhatsApp message:", {
      from: payload.from,
      phone: payload.phone,
      text: payload.text,
      messageId: payload.messageId,
      timestamp: payload.timestamp,
      type: payload.type,
      hasMedia: payload.hasMedia,
      mediaType: payload.media?.mimetype || null,
      mediaFilename: payload.media?.filename || null,
    });

    if (!process.env.MAKE_WEBHOOK_URL) {
      console.error("MAKE_WEBHOOK_URL is not configured");
      return;
    }

    const response = await fetch(process.env.MAKE_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error(
        "Make webhook failed:",
        response.status,
        await response.text()
      );
      return;
    }

    console.log("Message forwarded to Make successfully");
  } catch (error) {
    console.error("Error forwarding WhatsApp message to Make:", error);
  }
});

// Handle connection errors and disconnections gracefully
client.on("auth_failure", (message) => {
  console.error("Authentication failed:", message);
});

client.on("disconnected", (reason) => {
  console.log("WhatsApp client disconnected:", reason);
});

// Send a message to a phone number via the WhatsApp session
app.post("/send", async (req, res) => {
  try {
    const { phone, text } = req.body;

    if (!phone || !text) {
      return res.status(400).send({ error: "Phone and text are required" });
    }

    // Normalize the phone number and format it for WhatsApp Web
    const chatId = `${phone.replace(/\D/g, "")}@c.us`;

    // Send the message using the active WhatsApp session
    await client.sendMessage(chatId, text);

    res.status(200).send({ success: true, message: "Message sent successfully" });
  } catch (error) {
    console.error("Error sending message:", error);
    res.status(500).send({ error: error.message });
  }
});

// Remove stale Chromium profile locks after Railway restarts
function removeChromiumLocks(dir) {
  if (!fs.existsSync(dir)) return;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      removeChromiumLocks(fullPath);
      continue;
    }

    if (
      entry.name === "SingletonLock" ||
      entry.name === "SingletonSocket" ||
      entry.name === "SingletonCookie"
    ) {
      try {
        fs.unlinkSync(fullPath);
        console.log(`Removed stale Chromium lock: ${fullPath}`);
      } catch (error) {
        console.error(`Could not remove lock ${fullPath}:`, error.message);
      }
    }
  }
}

removeChromiumLocks("/app/.wwebjs_auth");

// Start the WhatsApp client and the Express server
client.initialize();

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Microservice running on port ${PORT}`);
});
