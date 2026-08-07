const express = require("express");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const cors = require("cors");

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
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

// Log the QR code to the terminal so it can be scanned from the WhatsApp app
client.on("qr", (qr) => {
  console.log("Scan this QR code with your WhatsApp mobile app (Linked Devices):");
  qrcode.generate(qr, { small: true });
});

// Log when the WhatsApp client is ready
client.on("ready", () => {
  console.log("WhatsApp Session is Ready and Connected!");
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

// Start the WhatsApp client and the Express server
client.initialize();

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Microservice running on port ${PORT}`);
});
