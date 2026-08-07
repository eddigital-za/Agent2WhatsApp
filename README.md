# Agent2WhatsApp 🚀

**A free, open-source Node.js microservice that lets any AI agent send messages directly to your personal WhatsApp.**

It works by running a local, session-based WhatsApp Web client (via `whatsapp-web.js`), so it bypasses the official Meta WhatsApp Cloud API's per-conversation fees and template-approval requirements. You scan a QR code once; after that, any agent that can make an HTTP POST request can message you.

[![License: MIT](https://img.shields.io/badge/License-MIT-25D366.svg)](#-license)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-25D366.svg)](#%EF%B8%8F-requirements--tech-stack)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-25D366.svg)](#-contributing)

---

## Contents

- [Why this project?](#-why-this-project)
- [Features](#-features)
- [Requirements & tech stack](#%EF%B8%8F-requirements--tech-stack)
- [Installation & setup](#-installation--setup)
- [API reference](#-api-reference)
- [Connecting AI agents](#-connecting-ai-agents)
  - [The "Append Prompt" trick](#the-append-prompt-trick-for-autonomous-agents)
  - [Python agents](#python-agents)
- [Production deployment](#-production-deployment)
- [Troubleshooting](#-troubleshooting)
- [Security notes](#-security-notes)
- [FAQ](#-faq)
- [License](#-license)

---

## 🌟 Why this project?

AI agents built with Python, LangChain, Flowise, custom GPTs, and similar tools often need to notify a person when a long-running task finishes. Doing that through Meta's official WhatsApp Cloud API means pre-approved message templates and per-conversation costs.

**Agent2WhatsApp** solves this by turning your local machine or VPS into a WhatsApp Web client that accepts a JSON payload over HTTP and forwards it to your personal WhatsApp number — no templates, no per-message billing.

## ✨ Features

- **Universal compatibility** — works with any AI agent that can send a basic HTTP POST request.
- **No Meta API fees** — uses `whatsapp-web.js` to run a local WhatsApp session instead of the official Cloud API.
- **Token-optimized** — formatting and routing logic live in the middleware, keeping LLM payloads small and cheap.
- **Persistent sessions** — `LocalAuth` stores your WhatsApp session on disk, so you only scan the QR code once.
- **CORS enabled** — cross-origin requests work out of the box for easy integration with other tools.

## 🛠️ Requirements & tech stack

| Component           | Details                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Node.js**         | >= 18.0.0                                                                                                                                                                                        |
| **Express**         | Handles incoming HTTP POST requests on port `4000`                                                                                                                                               |
| **whatsapp-web.js** | Drives the WhatsApp Web client simulation                                                                                                                                                        |
| **Google Chrome**   | Required locally; the service points Puppeteer at `C:\Program Files\Google\Chrome\Application\chrome.exe` by default (configurable in `index.js`) to avoid Puppeteer's bundled-Chromium download |

> **Note:** the hardcoded Chrome path in `index.js` is Windows-specific. On macOS or Linux, update `puppeteer.executablePath` to your local Chrome/Chromium binary, or remove the option to let Puppeteer manage its own browser.

## 🚀 Installation & setup

### 1. Clone the repository

```bash
git clone https://github.com/mokrosi/Agent2WhatsApp.git
cd Agent2WhatsApp
```

### 2. Install dependencies

```bash
# If you hit Puppeteer download errors, skip its bundled Chromium first:
# PowerShell:
$env:PUPPETEER_SKIP_DOWNLOAD="true"
# macOS/Linux:
export PUPPETEER_SKIP_DOWNLOAD=true

npm install
```

### 3. Start the microservice

**Option A — terminal:**

```bash
npm start
```

**Option B — one-click script (Windows):**

Double-click `run.exe` (or `run.bat`) in the project directory. It runs `node .\index.js` and starts the server on port `4000`.

### 4. Authenticate WhatsApp

1. Open WhatsApp on your phone.
2. Go to **Settings → Linked Devices → Link a Device**.
3. Scan the QR code shown in your terminal.
4. On success, your console prints `WhatsApp Session is Ready and Connected!`.

## 📡 API reference

### `POST /send`

Sends a WhatsApp message to a given phone number through your authenticated session.

**Endpoint:** `http://localhost:4000/send`
**Headers:** `Content-Type: application/json`

**Request body:**

| Field   | Type   | Required | Description                                                                                                           |
| ------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `phone` | string | Yes      | Destination number with country code, digits only or with formatting (non-digits are stripped) — e.g. `"968XXXXXXXX"` |
| `text`  | string | Yes      | Message body. Supports WhatsApp's `*bold*`, `_italic_`, and `\n` line breaks                                          |

**Example request:**

```bash
curl -X POST http://localhost:4000/send \
  -H "Content-Type: application/json" \
  -d '{"phone": "968XXXXXXXX", "text": "🤖 Agent Task Completed!"}'
```

**Responses:**

| Status | Body                                                          | Meaning                                                          |
| ------ | ------------------------------------------------------------- | ---------------------------------------------------------------- |
| `200`  | `{ "success": true, "message": "Message sent successfully" }` | Message delivered to the session                                 |
| `400`  | `{ "error": "Phone and text are required" }`                  | Missing `phone` or `text` in the request body                    |
| `500`  | `{ "error": "<details>" }`                                    | The WhatsApp session failed to send (e.g. not yet authenticated) |

## 🔌 Connecting AI agents

Any agent capable of an HTTP POST with a JSON body can use this service — no SDK required.

### The "Append Prompt" trick (for autonomous agents)

If you're using an autonomous coding or task agent (Anti-Gravity, Cursor, AutoGPT, etc.), you can have it notify you automatically on completion by appending an instruction block to your prompt.

Paste this at the end of your main prompt:

```text
---
[CRITICAL INSTRUCTION - EXECUTE AS YOUR FINAL STEP]

Once you have completely finished the main task requested above, notify me by
sending a summary of your results to my WhatsApp.

Execute an HTTP POST request to my local WhatsApp microservice with the
following specifications:

- Endpoint: http://localhost:4000/send
- Method: POST
- Headers: {"Content-Type": "application/json"}
- Payload (JSON):
  {
    "phone": "968XXXXXXXX",
    "text": "🤖 *Agent Task Completed!*\n\n*Summary of work:*\n[Insert a clear, concise summary of the results, changes made, or details of the executed task here.]"
  }

Use curl, fetch, or Python's requests library to send this before finishing.
```

> **Use with care:** this pattern gives the agent standing permission to make an outbound network call without asking again. Only use it with agents and prompts you trust, and see [Security notes](#-security-notes) below.

### Python agents

Install the client dependency:

```bash
pip install -r requirements.txt   # installs requests>=2.31.0
```

Example:

```python
import requests

def notify_whatsapp(summary):
    payload = {
        "phone": "968XXXXXXXX",
        "text": f"🤖 *Agent Task Completed!*\n\n{summary}"
    }
    requests.post("http://localhost:4000/send", json=payload)
```

## 📦 Production deployment

To keep the WhatsApp session running 24/7 without terminal interruptions, use [PM2](https://pm2.keymetrics.io/):

```bash
npm install -g pm2
pm2 start index.js --name "whatsapp-agent-api"
pm2 save
```

Consider running behind a reverse proxy (nginx/Caddy) with authentication if the service is reachable outside `localhost` — see [Security notes](#-security-notes).

## 🩺 Troubleshooting

| Symptom                                                   | Likely cause                                             | Fix                                                                                                                           |
| --------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Puppeteer fails to download Chromium during `npm install` | Network-restricted environment                           | Set `PUPPETEER_SKIP_DOWNLOAD=true` before installing, and point `executablePath` at a local Chrome install                    |
| `Error: Failed to launch the browser process`             | `executablePath` in `index.js` doesn't match your OS     | Update the path to your platform's Chrome/Chromium binary                                                                     |
| QR code never appears or expires                          | Slow start or stale session lock                         | Delete the `.wwebjs_auth` folder and restart to force a fresh QR                                                              |
| `500` error on `/send`                                    | Session not yet authenticated, or number not on WhatsApp | Confirm the console shows `WhatsApp Session is Ready and Connected!` before sending, and verify the destination number format |
| Messages send but never arrive                            | Destination number missing country code                  | Always include the full international code, digits only (e.g. `968XXXXXXXX`, not `0XXXXXXXX`)                                 |

## 🔒 Security notes

This project intentionally trades some hardening for simplicity, since it's designed to run on `localhost` for a single user. Keep the following in mind:

- **No authentication on `/send` by default.** Anything that can reach port `4000` can send messages as you. Don't expose this port to the public internet without adding an API key check or putting it behind a reverse proxy with auth.
- **Autonomous agents get standing permission.** The "Append Prompt" trick lets an agent call `/send` without asking again each time. Only use it in prompts and environments you trust — a compromised or manipulated agent could send arbitrary messages from your number.
- **Session files are sensitive.** The `.wwebjs_auth` folder holds your authenticated WhatsApp session. Treat it like a credential: keep it out of version control and off shared machines.

## ❓ FAQ

**What is Agent2WhatsApp?**
A free, open-source Node.js microservice that exposes a single `/send` endpoint. Any AI agent can POST a phone number and text, and the service forwards it over a local WhatsApp Web session.

**Does it use the official WhatsApp Business API?**
No — it uses `whatsapp-web.js` to drive a session-based WhatsApp Web client authenticated by QR code, avoiding Meta's per-conversation fees and template approvals.

**Which AI agent frameworks does it support?**
Any framework or language that can send an HTTP POST with a JSON body: Python, LangChain, Flowise, custom GPT tool calls, and more.

**Is it free?**
Yes — 100% free and open source under the MIT License, with no per-message charges.

## 📄 License

This project is open source and available under the [MIT License](https://opensource.org/licenses/MIT).

---

Developed with passion by [Mohammed Al Kharusi](https://github.com/mokrosi)
