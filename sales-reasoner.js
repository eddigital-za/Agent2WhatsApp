"use strict";

function responseText(payload) {
  if (payload.output_text) return payload.output_text;
  for (const item of payload.output || []) for (const c of item.content || []) if (c.type === "output_text") return c.text;
  return "";
}

function authorized(req) {
  const expected = String(process.env.SALES_AGENT_TOKEN || "");
  return expected.length >= 32 && req.get("authorization") === `Bearer ${expected}`;
}

async function transcribe(audio, key) {
  if (!audio?.data) return "";
  const form = new FormData();
  form.append("model", process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe");
  form.append("file", new Blob([Buffer.from(audio.data, "base64")], { type: audio.mimetype || "audio/ogg" }), audio.filename || "approval.ogg");
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form });
  if (!r.ok) throw new Error(`Transcription ${r.status}: ${await r.text()}`);
  return String((await r.json()).text || "").trim();
}

async function structured(key, model, name, schema, system, input) {
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, input: [{ role: "system", content: system }, { role: "user", content: input }], text: { format: { type: "json_schema", name, strict: true, schema } } })
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text()}`);
  return JSON.parse(responseText(await r.json()));
}

const SALES_SYSTEM = `You are Duane's BTSA sales copilot for motorcycle transport in South Africa. Draft as Duane: warm, direct, practical, calm and conversational; concise WhatsApp language; no corporate fluff; no fake urgency; never mention AI. Match the client's tone without mimicking abuse. Qualify the enquiry before quoting: establish motorcycle make/model, actual collection and delivery areas, desired timing, and any special requirements, asking the next one or two useful questions naturally. A city-to-city price question alone is not a qualified lead. For "What's your Durban to Johannesburg rate?", a suitable reply is "Hi! What bike are you moving, and which areas in Durban and Joburg would collection and delivery be?" Ask timing next once these are known. Never state a firm rate until Duane explicitly confirms one for the current enquiry. A website estimate, saved lead row, old conversation or training example is background only, never authority for a current quote. Never repeat test names, test bikes or old addresses as current facts. Use only facts explicitly confirmed for this enquiry; ask when unclear. Never invent a rate, discount, route slot, date, insurance term, policy, operational promise or availability. Move the sale forward naturally without pressure. Do not expose internal notes. All customer replies require Duane's approval.`;

function installSalesReasoner(app, { apiKey, model }) {
  const customerSchema = { type: "object", additionalProperties: false, properties: {
    proposedReply: { type: "string" }, category: { type: "string", enum: ["information", "price", "discount", "availability", "trust", "complaint", "booking", "other"] },
    confidence: { type: "number" }, notes: { type: "string" }
  }, required: ["proposedReply", "category", "confidence", "notes"] };
  const approvalSchema = { type: "object", additionalProperties: false, properties: {
    intent: { type: "string", enum: ["send", "revise", "discuss", "clarify"] }, finalReply: { type: "string" }, response: { type: "string" }
  }, required: ["intent", "finalReply", "response"] };

  app.post("/sales/customer", async (req, res) => {
    try {
      if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });
      if (!apiKey) throw new Error("OPENAI_API_KEY missing");
      const p = req.body || {};
      const out = await structured(apiKey, model, "btsa_sales_draft_v1", customerSchema, SALES_SYSTEM,
        `Lead facts:\n${JSON.stringify(p.lead || {})}\n\nRecent conversation:\n${JSON.stringify(p.history || [])}\n\nLatest client message:\n${String(p.message || "")}`);
      res.json(out);
    } catch (e) { console.error("Sales customer reasoner:", e.message); res.status(500).json({ error: e.message }); }
  });

  app.post("/sales/approval", async (req, res) => {
    try {
      if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });
      if (!apiKey) throw new Error("OPENAI_API_KEY missing");
      const p = req.body || {};
      const transcript = await transcribe(p.audio, apiKey);
      const instruction = [p.instruction, transcript].filter(Boolean).join("\n").trim();
      if (!instruction) return res.json({ intent: "clarify", finalReply: "", response: "I couldn't hear or read an instruction. Please try again." });
      const system = `${SALES_SYSTEM}\nYou now interpret Duane's internal approval instruction. Be conversational and tolerate shorthand, speech-to-text errors, fragments and normal language. Only choose intent=send when Duane clearly authorises sending now (for example send it, go ahead, yes send, tell them X). If he asks for a change without clearly authorising dispatch, choose revise and return the revised client reply. If he is discussing strategy, choose discuss. If ambiguous, choose clarify. Never treat casual agreement or unrelated group chat as approval. finalReply must contain only what the client should receive.`;
      const out = await structured(apiKey, model, "btsa_sales_approval_v1", approvalSchema, system,
        `Case: ${p.caseRef || ""}\nClient said: ${p.customerMessage || ""}\nCurrent proposed reply: ${p.proposedReply || ""}\nDuane's instruction: ${instruction}`);
      res.json({ ...out, transcript });
    } catch (e) { console.error("Sales approval reasoner:", e.message); res.status(500).json({ error: e.message }); }
  });
}

module.exports = { installSalesReasoner, SALES_SYSTEM };

