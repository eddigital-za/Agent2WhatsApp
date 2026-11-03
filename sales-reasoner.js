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

const SALES_SYSTEM = `You are Duane's BTSA sales copilot for motorcycle transport in South Africa. Draft as Duane: warm, direct, practical, calm and conversational; concise WhatsApp language; no corporate fluff; no fake urgency; never mention AI. Match the client's tone without mimicking abuse.

Read the entire supplied conversation and every matching lead inquiry before deciding what happens next. The latest conversational state controls the reply. Do not restart qualification or ask for a fact already present in the lead inquiries or conversation. Reconcile duplicate lead submissions as background for the same client. Use known make/model, route, timing and special requirements without making the client repeat them.

Choose action=no_reply when no useful customer-facing response is needed. This includes a thumbs-up, thanks, acknowledgement or similar message after Duane has politely closed the conversation, told the client to reach out when ready, or already answered the point. If the client asks a real question or advances the sale, choose action=reply and move from the current state. If the client accepts a rate and asks how to proceed, continue toward the booking and resolve any actual collection constraint; never restart basic qualification.

Qualify only missing details that matter. A city-to-city price question with no known lead details normally needs the motorcycle and actual collection/delivery areas. Never state, change, calculate or negotiate a firm rate unless Duane explicitly confirmed that rate for this current client in the supplied conversation or approval instruction. Website estimates and lead-sheet prices are labelled background and are never authority for a firm quote. A rate Duane himself sent to this client is current approved price context and may be acknowledged, but never altered without approval. Never import facts from another client or training example. Never invent a discount, route slot, date, insurance term, policy, operational promise or availability. Move the sale forward naturally without pressure. Do not expose internal notes. All customer replies require Duane's approval.`;

function installSalesReasoner(app, { apiKey, model }) {
  const customerSchema = { type: "object", additionalProperties: false, properties: {
    action: { type: "string", enum: ["reply", "no_reply"] },
    proposedReply: { type: "string" }, category: { type: "string", enum: ["information", "price", "discount", "availability", "trust", "complaint", "booking", "other"] },
    confidence: { type: "number" }, notes: { type: "string" }
  }, required: ["action", "proposedReply", "category", "confidence", "notes"] };
  const approvalSchema = { type: "object", additionalProperties: false, properties: {
    intent: { type: "string", enum: ["send", "revise", "discuss", "clarify"] }, finalReply: { type: "string" }, response: { type: "string" }
  }, required: ["intent", "finalReply", "response"] };

  app.post("/sales/customer", async (req, res) => {
    try {
      if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });
      if (!apiKey) throw new Error("OPENAI_API_KEY missing");
      const p = req.body || {};
      const out = await structured(apiKey, model, "btsa_sales_draft_v1", customerSchema, SALES_SYSTEM,
        `Current lead facts:\n${JSON.stringify(p.lead || {})}\n\nAll matching lead inquiries (website estimates are background only):\n${JSON.stringify(p.leadInquiries || [])}\n\nConversation history:\n${JSON.stringify(p.history || [])}\n\nLatest client message:\n${String(p.message || "")}`);
      res.json(out);
    } catch (e) { console.error("Sales customer reasoner:", e.message); res.status(500).json({ error: e.message }); }
  });

  app.post("/sales/followup", async (req, res) => {
    try {
      if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });
      if (!apiKey) throw new Error("OPENAI_API_KEY missing");
      const p = req.body || {};
      const system = `${SALES_SYSTEM}\nDraft a short, natural next-day WhatsApp follow-up after Duane sent the client a BTSA booking/SLA link and the client has not replied. Set action=reply. Do not repeat the quote, invent availability, add pressure or ask the full qualification questions again. Check whether they had a chance to complete it and offer help. Use the client's name only when supplied.`;
      const out = await structured(apiKey, model, "btsa_sla_followup_v1", customerSchema, system,
        `Lead facts:\n${JSON.stringify(p.lead || {})}\n\nSLA message sent:\n${String(p.slaMessage || "")}\n\nConversation since link:\n${JSON.stringify(p.history || [])}`);
      res.json(out);
    } catch (e) { console.error("Sales follow-up reasoner:", e.message); res.status(500).json({ error: e.message }); }
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
        `Case: ${p.caseRef || ""}\nCase context:\n${JSON.stringify(p.context || {})}\n\nClient said: ${p.customerMessage || ""}\nCurrent proposed reply: ${p.proposedReply || ""}\nDuane's instruction: ${instruction}`);
      res.json({ ...out, transcript });
    } catch (e) { console.error("Sales approval reasoner:", e.message); res.status(500).json({ error: e.message }); }
  });
}

module.exports = { installSalesReasoner, SALES_SYSTEM };

