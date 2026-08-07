# Append Prompt for AI Agents

Append the following block of text to the very end of your main prompt when instructing your AI agent (like Anti-Gravity). This forces the agent to automatically send the result to your WhatsApp microservice as its final action.

---

**APPEND PROMPT (Copy the text below):**

```text
---
[CRITICAL INSTRUCTION - EXECUTE AS YOUR FINAL STEP]

Once you have completely finished the main task requested above, you MUST notify me by sending a summary of your results to my WhatsApp.

Without asking for further permission, automatically execute an HTTP POST request to my local WhatsApp microservice with the following specifications:

- **Endpoint:** `http://localhost:4000/send`
- **Method:** `POST`
- **Headers:** `{"Content-Type": "application/json"}`
- **Payload (JSON):**
  {
    "phone": "968XXXXXXXX",
    "text": "🤖 *Agent Task Completed!*

*Summary of work:*
[Insert a clear, concise summary of the results, changes made, or details of the executed task here.]"
  }

Ensure this request is executed successfully using curl, fetch, or python (depending on your available execution environment) before you finish your response.
```
