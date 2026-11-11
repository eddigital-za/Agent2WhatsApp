"use strict";

const { createDefaultRetriever } = require("./sales-example-retriever");

function responseText(payload) {
  if (payload.output_text) return payload.output_text;
  for (const item of payload.output || []) for (const c of item.content || []) if (c.type === "output_text") return c.text;
  return "";
}

function authorized(req) {
  const expected = String(process.env.SALES_AGENT_TOKEN || "");
  return expected.length >= 32 && req.get("authorization") === `Bearer ${expected}`;
}

function importAuthorized(req) {
  const expected = String(process.env.SALES_EXAMPLE_IMPORT_TOKEN || "");
  return expected.length >= 32 && req.get("authorization") === `Bearer ${expected}`;
}

function historicalExampleForPrompt(example) {
  const sanitize = value => String(value || "")
    .replace(/https?:\/\/\S+/gi, "[HISTORICAL_LINK]")
    .replace(/\bR\s?\d+(?:[.,]\d+)?\s*k\b/gi, "[HISTORICAL_RATE]")
    .replace(/\bR\s?\d[\d ,.]*\b/gi, "[HISTORICAL_RATE]")
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:k|rand)\b/gi, "[HISTORICAL_RATE]")
    .slice(0, 1200);
  return { customer: sanitize(example.customer), btsaResponse: sanitize(example.btsaResponse) };
}

function normalizeReply(value) {
  return String(value || "")
    .replace(/\[[^\]]+\]\((https?:\/\/[^)]+)\)/g, "$1")
    .replace(/[—–]/g, " - ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function withBookingLink(value, requested, link) {
  const reply = normalizeReply(value);
  if (!reply || !requested || !link || reply.includes(link)) return reply;
  return reply + "\n\n" + link;
}

function isNoReplyInstruction(value) {
  const text = String(value || "").toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, " ").trim();
  return /\b(?:do not|don't|dont|not to|never|no)\s+(?:send|reply|respond)\b/.test(text)
    || /\b(?:leave|ignore|skip)\s+(?:it|this|that|him|her|them|the (?:message|client|customer))\b/.test(text)
    || /\b(?:no response|no reply|say nothing)\b/.test(text);
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

const SALES_PLAYBOOK = `BTSA sales playbook:
- Treat the conversation, not an individual message, as the unit of work. Consecutive client messages are one turn. Resolve every ask with one coherent next move.
- First establish what is moving, exact collection and delivery areas, timing in both directions when it is a return trip, and any real access or handover constraint. Use lead-sheet facts and conversation facts before asking anything.
- Ask only the smallest useful question that advances the sale. Never ask the client to repeat a bike, route, date or constraint already supplied.
- When the facts are sufficient, move toward a decision or the booking/SLA step. Do not end with generic filler such as "let me know if you have questions" when a clearer next step exists.
- If the client asks for a price, discount, date, route slot or operational commitment that Duane has not approved, do not send a holding reply. Ask Duane one precise internal question using action=owner_input. Include all legs, dates and constraints he must decide.
- A short acknowledgement after the conversation has been closed normally needs no reply. A real question or buying signal does.
- Never say "I'll get back to you", "hang tight", "I'll check", or "I'll confirm soon" merely to produce a response. Either qualify, answer from verified facts, move to booking, ask Duane for a specific decision, or do not reply.
- Write in Duane's first person: I, me, I'll, ask me. Keep it concise, natural and commercially useful.
- When the client has supplied enough information and Duane has approved the rate, use an assumptive close. Give the next step directly instead of asking "are you ready to proceed?" or ending with passive "let me know" filler.
- Infer the buyer’s actual barrier before drafting: price comparison, risk, timing, handover, or readiness. Pick the move Duane used in the closest examples. Borrow his rhythm and phrasing where it fits; skip generic empathy, stock sales copy and repeated offers to confirm the rate.
- For a price objection, acknowledge it, check the comparison where useful, and explain the value that matters to this buyer. Explore legitimate trade-offs such as flexibility on a scheduled route before asking Duane about a concession. If both the normal rate and lower rate are verified for this job, lead with the real normal rate, then explain the actual concession and give a clear next step. Never make up a higher anchor or a discount.
- Use real urgency only when supported by a confirmed slot, deadline, or quote expiry. Never invent scarcity, a route run, or someone else waiting for space.
- When the client signals readiness, assume the sale and make the next action easy. Use the booking link if one is supplied; if a handover constraint remains, address that specific constraint rather than starting the sale over. If an approved rate is already known, don't ask Duane to confirm it again.
- When useful, reinforce door-to-door delivery and verified insurance cover. Don't promise extras are covered without checking that they have been declared and approved.
- If a real BTSA booking link is supplied, make booking the easy next step using "please complete the booking form below". Put the raw URL on its own line. Never invent a domain, timestamp or placeholder link.
- Do not promise exact collection or delivery dates or times unless Duane explicitly approves them. Use a realistic window, allow routing flexibility and commit to the client's actual deadline where approved.
- Standard BTSA transport is on an open van and trailer, not an enclosed vehicle. If asked, reassure the client naturally.
- Start by acknowledging what the client actually said. Avoid empty small talk such as "hope you're well". Use short WhatsApp paragraphs and never use em dashes.
- Duane's approval instructions are binding. Preserve every non-conflicting fact and correction through later revisions, especially approved prices, routes, timing limits, inclusions and closing direction. Never revert to a website estimate or an older draft.`;

const EXAMPLE_RULES = `Historical BTSA examples:
- Use the retrieved examples to understand Duane's tone, sales judgement, objection handling and closing style.
- They are historical evidence, not templates. Never copy them blindly or expose their source IDs.
- Never reuse an example's customer facts, route, price, availability, collection date, delivery date, insurance statement or operational promise.
- Current lead facts, the current conversation and Duane's current approvals always override an example.
- If an example conflicts with the current playbook or known facts, ignore it.`;

const SALES_SYSTEM = `You are Duane's BTSA sales copilot for motorcycle transport in South Africa. Draft as Duane: warm, direct, practical, calm and conversational; concise WhatsApp language; no corporate fluff; no fake urgency; never mention AI. Match the client's tone without mimicking abuse.

${SALES_PLAYBOOK}

${EXAMPLE_RULES}

Read the entire supplied conversation and every matching lead inquiry before deciding what happens next. The latest conversational state controls the reply. Do not restart qualification or ask for a fact already present in the lead inquiries or conversation. Reconcile duplicate lead submissions as background for the same client. Use known make/model, route, timing and special requirements without making the client repeat them.

Choose action=no_reply when no useful customer-facing response is needed. This includes a thumbs-up, thanks, acknowledgement or similar message after Duane has politely closed the conversation, told the client to reach out when ready, or already answered the point. If the client asks a real question or advances the sale, choose action=reply and move from the current state. If the client accepts a rate and asks how to proceed, continue toward the booking and resolve any actual collection constraint; never restart basic qualification. Choose action=owner_input when the useful next move depends on an unapproved price, discount, availability, schedule or operational commitment. ownerQuestion is internal for Duane and must be one precise decision request, not client-facing filler.

Qualify only missing details that matter. A city-to-city price question with no known lead details normally needs the motorcycle and actual collection/delivery areas. Never state, change, calculate or negotiate a firm rate unless Duane explicitly confirmed that rate for this current client in the supplied conversation or approval instruction. Website estimates and lead-sheet prices are labelled background and are never authority for a firm quote. A rate Duane himself sent to this client is current approved price context and may be acknowledged, but never altered without approval. Never import facts from another client or training example. Never invent a discount, route slot, date, insurance term, policy, operational promise or availability. Move the sale forward naturally without pressure. Do not expose internal notes. All customer replies require Duane's approval.`;

function installSalesReasoner(app, { apiKey, model, exampleRetriever = createDefaultRetriever() }) {
  const customerSchema = { type: "object", additionalProperties: false, properties: {
    action: { type: "string", enum: ["reply", "no_reply", "owner_input"] },
    salesMove: { type: "string", enum: ["qualify", "answer", "close", "hold"] },
    proposedReply: { type: "string" }, category: { type: "string", enum: ["information", "price", "discount", "availability", "trust", "complaint", "booking", "other"] },
    ownerQuestion: { type: "string" }, confidence: { type: "number" }, notes: { type: "string" }
  }, required: ["action", "salesMove", "proposedReply", "category", "ownerQuestion", "confidence", "notes"] };
  const approvalSchema = { type: "object", additionalProperties: false, properties: {
    intent: { type: "string", enum: ["send", "cancel", "revise", "discuss", "clarify"] }, finalReply: { type: "string" }, response: { type: "string" },
    bookingNext: { type: "boolean" }, reusableLesson: { type: "string" },
  }, required: ["intent", "finalReply", "response", "bookingNext", "reusableLesson"] };

  app.post("/sales/customer", async (req, res) => {
    try {
      if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });
      if (!apiKey) throw new Error("OPENAI_API_KEY missing");
      const p = req.body || {};
      const historicalExamples = exampleRetriever.retrieve(String(p.message || ""), 4).map(historicalExampleForPrompt);
      const schema = { ...customerSchema, properties: { ...customerSchema.properties, bookingNext: { type: "boolean" } }, required: [...customerSchema.required, "bookingNext"] };
      const out = await structured(apiKey, model, "btsa_sales_draft_v1", schema,
        `${SALES_SYSTEM} Set bookingNext=true only for a reply whose next action is completing the supplied booking form. If a link is supplied and the buyer is ready, do not ask the owner to generate it. Introduce the form in the draft; the exact link will be inserted if omitted.`,
        `Current lead facts:\n${JSON.stringify(p.lead || {})}\n\nAll matching lead inquiries (website estimates are background only):\n${JSON.stringify(p.leadInquiries || [])}\n\nOwner preferences learned from Duane:\n${JSON.stringify(p.ownerPreferences || [])}\n\nApproved booking link (when supplied):\n${String(p.generatedBookingLink || "")}\n\nConversation history:\n${JSON.stringify(p.history || [])}\n\nNew client messages in this turn (handle together):\n${JSON.stringify(p.newMessages || [])}\n\nCombined client turn:\n${String(p.message || "")}\n\nRetrieved historical examples (tone and sales logic only; never copy historical facts):\n${JSON.stringify(historicalExamples)}`);
      res.json({ ...out, proposedReply: withBookingLink(out.proposedReply, out.action === "reply" && out.bookingNext, p.generatedBookingLink) });
    } catch (e) { console.error("Sales customer reasoner:", e.message); res.status(500).json({ error: e.message }); }
  });

  app.post("/sales/examples/import", async (req, res) => {
    try {
      if (!importAuthorized(req)) return res.status(401).json({ error: "Unauthorized" });
      const encoded = String(req.body?.dataBase64 || "");
      if (!encoded) return res.status(400).json({ error: "dataBase64 is required" });
      const jsonl = Buffer.from(encoded, "base64").toString("utf8");
      const count = exampleRetriever.replace(jsonl);
      res.json({ ok: true, exampleCount: count });
    } catch (e) { console.error("Sales example import:", e.message); res.status(400).json({ error: e.message }); }
  });

  app.post("/sales/followup", async (req, res) => {
    try {
      if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });
      if (!apiKey) throw new Error("OPENAI_API_KEY missing");
      const p = req.body || {};
      const system = `${SALES_SYSTEM}\nDraft a short, natural next-day WhatsApp follow-up after Duane sent the client a BTSA booking/SLA link and the client has not replied. Set action=reply, salesMove=close and ownerQuestion="". Do not repeat the quote, invent availability, add pressure or ask the full qualification questions again. Check whether they had a chance to complete it and offer help. Use the client's name only when supplied.`;
      const out = await structured(apiKey, model, "btsa_sla_followup_v1", customerSchema, system,
        `Lead facts:\n${JSON.stringify(p.lead || {})}\n\nSLA message sent:\n${String(p.slaMessage || "")}\n\nConversation since link:\n${JSON.stringify(p.history || [])}`);
      res.json({ ...out, proposedReply: normalizeReply(out.proposedReply) });
    } catch (e) { console.error("Sales follow-up reasoner:", e.message); res.status(500).json({ error: e.message }); }
  });

  app.post("/sales/sequence", async (req, res) => {
    try {
      if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });
      if (!apiKey) throw new Error("OPENAI_API_KEY missing");
      const p = req.body || {};
      const stage = p.stage === "day7" ? "day7" : "day3";
      const stageInstruction = stage === "day3"
        ? "Draft a soft Day 3 check-in after the website first touch and 24-hour follow-up received no reply. Ask whether they are still looking to move the known motorcycle and, when useful, what dates they are working with. Do not repeat every known detail, quote, pressure, or claim availability."
        : "Draft the final Day 7 close after the website first touch, 24-hour follow-up and approved Day 3 check-in received no reply. Politely close the follow-up loop, leave the door open for them to contact Duane when ready, and do not ask another qualification question or create urgency.";
      const system = `${SALES_SYSTEM}\n${stageInstruction}\nSet action=reply, salesMove=close and ownerQuestion="". This is a draft for Sales Approvals and must not be treated as permission to send.`;
      const out = await structured(apiKey, model, `btsa_${stage}_lead_sequence_v1`, customerSchema, system,
        `Current lead facts:\n${JSON.stringify(p.lead || {})}\n\nAll matching website inquiries:\n${JSON.stringify(p.leadInquiries || [])}\n\nConversation history:\n${JSON.stringify(p.history || [])}\n\nFirst touch sent: ${p.firstTouchSentAt || ""}\n24-hour follow-up sent: ${p.followupSentAt || ""}`);
      res.json({ ...out, proposedReply: normalizeReply(out.proposedReply) });
    } catch (e) { console.error("Sales sequence reasoner:", e.message); res.status(500).json({ error: e.message }); }
  });

  app.post("/sales/approval", async (req, res) => {
    try {
      if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });
      if (!apiKey) throw new Error("OPENAI_API_KEY missing");
      const p = req.body || {};
      const transcript = await transcribe(p.audio, apiKey);
      const instruction = [p.instruction, transcript].filter(Boolean).join("\n").trim();
      if (!instruction) return res.json({ intent: "clarify", finalReply: "", response: "I couldn't hear or read an instruction. Please try again." });
      if (isNoReplyInstruction(instruction)) return res.json({ intent: "cancel", finalReply: "", response: "Understood. I won't reply.", transcript });
      const historicalExamples = exampleRetriever.retrieve(String(p.customerMessage || ""), 4).map(historicalExampleForPrompt);
      const system = `${SALES_SYSTEM}\nYou now interpret Duane's internal approval instruction. Be conversational and tolerate shorthand, speech-to-text errors, fragments and normal language. Choose intent=cancel whenever Duane says not to reply, send or respond. Only choose intent=send when Duane clearly authorises sending now (for example send it, go ahead, yes send, tell them X). If he asks for a change without clearly authorising dispatch, choose revise and return the revised client reply. If he is discussing strategy, choose discuss. If ambiguous, choose clarify. Never treat casual agreement or unrelated group chat as approval. finalReply must contain only what the client should receive.\n\nThe previous owner instructions are cumulative and binding. The latest instruction overrides an earlier instruction only when they directly conflict. Preserve approved prices, route facts, timing limits, service inclusions and closing direction through every revision. Duane's approved price and correction override any website estimate and the old proposed draft. Write one complete coherent client reply, not a fragment or a patch. If a generated booking link is supplied, use that exact raw URL when the sales move calls for booking. Never invent or alter a booking link. Set bookingNext=true only if the draft actually moves the client to the supplied booking form. The link will be inserted if omitted.\n\nSet reusableLesson to one short condition-and-action rule only when Duane's latest instruction teaches a clear, reusable sales or writing tactic. Derive it only from that instruction, never from the client, history, draft or examples. Exclude all names, contact details, prices, dates, routes, promises, business facts and one-off instructions. Return an empty string for routine approval, client-specific corrections, and uncertain lessons.`;
      const out = await structured(apiKey, model, "btsa_sales_approval_v1", approvalSchema, system,
        `Case: ${p.caseRef || ""}\nCase context:\n${JSON.stringify(p.context || {})}\n\nOwner preferences learned from Duane:\n${JSON.stringify(p.context?.ownerPreferences || [])}\n\nPrevious owner instructions (cumulative):\n${JSON.stringify(p.context?.ownerInstructionHistory || [])}\n\nGenerated booking link, if approved facts are sufficient:\n${String(p.context?.generatedBookingLink || "")}\n\nClient said: ${p.customerMessage || ""}\nCurrent proposed reply: ${p.proposedReply || ""}\nDuane's latest instruction: ${instruction}\n\nRetrieved historical examples (tone and sales logic only; never copy historical facts):\n${JSON.stringify(historicalExamples)}`);
      res.json({ ...out, finalReply: withBookingLink(out.finalReply, out.bookingNext, p.context?.generatedBookingLink), transcript });
    } catch (e) { console.error("Sales approval reasoner:", e.message); res.status(500).json({ error: e.message }); }
  });
  return { get exampleCount() { return exampleRetriever.examples?.length || 0; } };
}

module.exports = { installSalesReasoner, SALES_SYSTEM, SALES_PLAYBOOK, EXAMPLE_RULES };

