# Agent2WhatsApp 🚀

A scalable, end-to-end open-source pipeline that allows _any_ AI agent to send messages directly to your WhatsApp using a custom Node.js WhatsApp Session microservice.

This project bypasses the official Meta WhatsApp Cloud API restrictions and per-conversation fees by utilizing a session-based approach via QR code.

## 🌟 Why This Project?

AI Agents (built with Python, LangChain, Flowise, custom GPTs, etc.) often need a way to notify users when long-running tasks are completed. Relying on Meta's official API requires pre-approved templates and incurs costs. **Agent2WhatsApp** solves this by turning your local machine or VPS into a WhatsApp web client that can dynamically receive JSON payloads from any agent and forward them to your personal WhatsApp number.

## ✨ Features

- **Universal Compatibility:** Works seamlessly with any AI Agent that can send a basic HTTP POST request.
- **No Meta API Fees:** Utilizes `whatsapp-web.js` to run a local WhatsApp session, bypassing Meta's template constraints and pricing.
- **Token-Optimized:** Offloads formatting and routing logic to the middleware, keeping your LLM payload lightweight to save API costs.
- **Persistent Sessions:** Uses `LocalAuth` to store your WhatsApp session locally, meaning you only scan the QR code once.
- **CORS Enabled:** Cross-origin resource sharing is enabled out-of-the-box for smooth integrations.

## 🛠️ Requirements & Tech Stack

- **Node.js:** Core runtime environment (Requires >= 18.0.0).
- **Express:** Handles incoming HTTP POST requests on port `4000`.
- **WhatsApp-Web.js:** Powers the WhatsApp Web client simulation.
- **Google Chrome:** The microservice explicitly relies on a local installation of Google Chrome located at `C:\Program Files\Google\Chrome\Application\chrome.exe` (configurable in `index.js`) to bypass Puppeteer download issues.

## 🚀 Installation & Setup

### 1. Clone the Repository

```bash
git clone [https://github.com/mokrosi/Agent2WhatsApp.git](https://github.com/mokrosi/Agent2WhatsApp.git)
cd Agent2WhatsApp
2. Install DependenciesBash# If you encounter Puppeteer errors, skip the internal browser download:
$env:PUPPETEER_SKIP_DOWNLOAD="true"

# Install Node.js packages
npm install
3. Boot the MicroserviceYou have two ways to start the server:Option A: Using the TerminalBashnpm start
Option B: One-Click Run Script (Windows)
Simply double-click the run.exe (or run.bat) file included in the project directory. This script executes node .\index.js automatically and boots up the server on port 4000.  4. Authenticate WhatsAppOpen the WhatsApp app on your phone.Navigate to Linked Devices > Link a Device.Scan the terminal QR code.Once successfully connected, you will see WhatsApp Session is Ready and Connected! in your console.🧠 The "Append Prompt" Trick (For AI Agents)If you are using an autonomous agent (like Anti-Gravity, Cursor, or AutoGPT), you can force it to notify you automatically upon task completion using the Append Prompt method.Simply copy the instruction block below and paste it at the very end of your main prompt.Copy this into your prompt:Plaintext---
[CRITICAL INSTRUCTION - EXECUTE AS YOUR FINAL STEP]

Once you have completely finished the main task requested above, you MUST notify me by sending a summary of your results to my WhatsApp.

Without asking for further permission, automatically execute an HTTP POST request to my local WhatsApp microservice with the following specifications:

- **Endpoint:** `http://localhost:4000/send`
- **Method:** `POST`
- **Headers:** `{"Content-Type": "application/json"}`
- **Payload (JSON):**
  {
    "phone": "968XXXXXXXX",
    "text": "🤖 *Agent Task Completed!*\n\n*Summary of work:*\n[Insert a clear, concise summary of the results, changes made, or details of the executed task here.]"
  }

Ensure this request is executed successfully using curl, fetch, or python before you finish your response.
🐍 Python Agents SetupIf your AI agent is built using Python, you will need the requests library to send the payload to the microservice.  Install the required Python dependencies:Bashpip install -r requirements.txt
(This installs requests>=2.31.0 as defined in the project files)  Python Agent Example:Pythonimport requests

def notify_whatsapp(summary):
    payload = {
        "phone": "968XXXXXXXX",
        "text": f"🤖 *Agent Task Completed!*\n\n{summary}"
    }
    requests.post("http://localhost:4000/send", json=payload)
📡 Production DeploymentTo ensure your WhatsApp session runs 24/7 without terminal interruptions, use PM2:Bashnpm install -g pm2
pm2 start index.js --name "whatsapp-agent-api"
pm2 save
📄 LicenseThis project is open-source and available under the MIT License.
```
