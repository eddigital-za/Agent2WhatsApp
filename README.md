# Agent2WhatsApp 🚀

A scalable, end-to-end pipeline that allows _any_ AI agent to send messages directly to your WhatsApp using Make (Integromat) and a custom Node.js WhatsApp Session microservice.

This project bypasses the official Meta WhatsApp Cloud API restrictions and per-conversation fees by utilizing a session-based approach via QR code.

## 🌟 Features

- **Universal Compatibility:** Works seamlessly with any AI Agent (Node.js, Python, LangChain, Flowise, etc.) that can send a basic HTTP POST request.
- **No Meta API Fees:** Utilizes `whatsapp-web.js` to run a local WhatsApp session, bypassing Meta's template constraints and pricing.
- **Token-Optimized:** Offloads formatting and routing logic to the middleware (Make), keeping your LLM payload lightweight to save API costs.
- **Centralized Hub:** Use a single Make Webhook to receive messages from multiple agents and route them dynamically based on the payload.

## 🏗️ Architecture Overview

```text
[ Any AI Agent ] ──(POST JSON)──► [ Make Webhook ] ──(HTTP POST)──► [ Node.js API ] ──(WhatsApp Web API)──► [ Your WhatsApp ]
🚀 Installation & Setup1. Deploy the Node.js MicroserviceThis microservice acts as your WhatsApp client and exposes an endpoint for Make.com to communicate with.  Bash# Clone the repository
git clone [https://github.com/yourusername/Agent2WhatsApp.git](https://github.com/yourusername/Agent2WhatsApp.git)
cd Agent2WhatsApp

# Install the required dependencies
npm install express whatsapp-web.js qrcode-terminal cors
Run the server locally or on your VPS:Bashnode index.js
Note: Upon the first run, a QR code will appear in your terminal. Scan it with your WhatsApp mobile app (Linked Devices) to authenticate the session.  2. Configure Make (Integromat) MiddlewareMake.com acts as the universal router for all your agents.  Custom Webhook: Create a new Custom Webhook in Make to generate your Universal Receiver URL.  HTTP Request: Add an HTTP module connected to the webhook to forward the data to your Node.js microservice[cite: 2]:URL: http://YOUR_SERVER_IP:3000/send[cite: 2]Method: POST[cite: 2]Body type: Raw -> JSON (application/json)[cite: 2]Payload Mapping:JSON{
  "phone": "{{1.target_phone}}",
  "text": "*Agent:* {{1.agent_name}}\n\n*Result:*\n{{1.result}}"
}
3. The Universal Agent Payload (Client Side)Configure your AI Agent to hit your Make Webhook with the following JSON structure when it finishes a task[cite: 2]:JSON{
  "target_phone": "968XXXXXXXX",
  "agent_name": "Research Agent",
  "result": "The final processed output goes here."
}
Example fetch request:JavaScriptawait fetch('[https://hook.make.com/YOUR_WEBHOOK_ID](https://hook.make.com/YOUR_WEBHOOK_ID)', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        target_phone: '968XXXXXXXX',
        agent_name: 'Agent2WhatsApp',
        result: 'Process completed successfully.'
    })
});
🛠️ Production DeploymentFor 24/7 uptime, deploy the Node.js microservice to a VPS (DigitalOcean, AWS, etc.) using PM2[cite: 2]:Bashnpm install -g pm2
pm2 start index.js --name "whatsapp-api"
pm2 save
📄 LicenseThis project is open-source and available under the MIT License.
```
