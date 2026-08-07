# Universal Agent to WhatsApp Integration (Agent2WhatsApp)

**Objective:** Build a scalable, end-to-end pipeline that allows _any_ AI agent to send messages directly to your WhatsApp using Make (Integromat) and a custom Node.js WhatsApp Session microservice.

---

## Architecture Overview

```text
[ Any AI Agent ] ──(POST JSON)──► [ Make Webhook ] ──(HTTP POST)──► [ Node.js API ] ──(WhatsApp Web API)──► [ Your WhatsApp ]
```

---

## Phase 1: Building the Node.js WhatsApp Microservice

This phase sets up the custom server that holds your WhatsApp session. It utilizes `whatsapp-web.js` to bypass Meta's official API constraints.

### 1. Project Setup

Initialize the project and install the required dependencies:

```bash
mkdir agent2whatsapp-api && cd agent2whatsapp-api
npm init -y
npm install express whatsapp-web.js qrcode-terminal cors
```

### 2. Microservice Code (`index.js`)

Create an Express server to handle the WhatsApp session and expose a `/send` endpoint.

```javascript
const express = require("express");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

// Initialize WhatsApp Client with LocalAuth to persist the session
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { args: ["--no-sandbox", "--disable-setuid-sandbox"] },
});

client.on("qr", (qr) => {
  console.log("Scan this QR code with your WhatsApp (Linked Devices):");
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  console.log("WhatsApp Session is Ready and Connected!");
});

app.post("/send", async (req, res) => {
  try {
    const { phone, text } = req.body;
    if (!phone || !text)
      return res.status(400).send({ error: "Phone and text are required" });

    // Format phone number for WhatsApp ID
    // e.g., 968XXXXXXXX becomes 968XXXXXXXX@c.us
    const chatId = `${phone.replace(/\D/g, "")}@c.us`;
    await client.sendMessage(chatId, text);

    res
      .status(200)
      .send({ success: true, message: "Message sent successfully" });
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

client.initialize();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Microservice running on port ${PORT}`));
```

### 3. Run and Authenticate

Run `node index.js` in your terminal. Scan the generated QR code using your WhatsApp (Linked Devices). The session auth data is now saved locally in a `.wwebjs_auth` folder.

---

## Phase 2: Make (Integromat) Configuration

Make acts as the universal router for all your agents.

### 1. Create a Custom Webhook

- Add a **Webhooks -> Custom Webhook** module.
- Click "Add", name it "Universal Agent Receiver", and copy the generated URL.

### 2. Set Up the HTTP Request Module

- Add an **HTTP -> Make a request** module and connect it to the Webhook.
- **URL:** `http://YOUR_SERVER_IP:3000/send` _(Note: If testing locally, use a tool like Ngrok to expose your port 3000 to the internet)._
- **Method:** `POST`
- **Body type:** `Raw` -> `JSON (application/json)`
- **Request content:** Map the variables from the webhook.
  ```json
  {
    "phone": "{{1.target_phone}}",
    "text": "*Agent:* {{1.agent_name}}\n\n*Result:*\n{{1.result}}"
  }
  ```

---

## Phase 3: Universal Agent Setup (The Client Side)

Configure any agent to hit your Make Webhook. Because Make acts as the central hub, the agent code remains incredibly lightweight.

### Standard JSON Payload Protocol

Instruct your agent or write your agent's final output script to send this exact JSON payload to the Make Webhook URL:

```json
{
  "target_phone": "968XXXXXXXX",
  "agent_name": "Data Analysis Agent",
  "result": "The final processed output goes here."
}
```

_Example implementation inside your Agent's code:_

```javascript
await fetch("https://hook.make.com/YOUR_WEBHOOK_ID", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    target_phone: "968XXXXXXXX",
    agent_name: "DeepSeek Flash Agent",
    result: finalAgentOutput, // The extracted output from your LLM
  }),
});
```

---

## Phase 4: Production Deployment

To ensure the WhatsApp session runs 24/7 without terminal interruptions.

1. Deploy the `agent2whatsapp-api` code to a VPS (e.g., DigitalOcean, Contabo, AWS).
2. Install PM2 globally: `npm install -g pm2`
3. Start the Node.js process: `pm2 start index.js --name "whatsapp-api"`
4. Save the PM2 process list so it restarts on server reboot: `pm2 save`
