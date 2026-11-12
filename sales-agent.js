"use strict";

function installSalesAgent({ db, customerClient, approvalClient, approvalGroupId, reasonerUrl, token, normalizePhone, localPhone, logEvent }) {
  const approvalGroup = () => typeof approvalGroupId === "function" ? approvalGroupId() : approvalGroupId;
  db.exec(`
    CREATE TABLE IF NOT EXISTS sales_inbound_claims(message_id TEXT PRIMARY KEY, claimed_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sales_messages(
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, phone TEXT NOT NULL,
      direction TEXT NOT NULL, body TEXT NOT NULL, message_id TEXT UNIQUE
    );
    CREATE INDEX IF NOT EXISTS idx_sales_messages_phone ON sales_messages(phone, created_at);
    CREATE TABLE IF NOT EXISTS sales_approvals(
      id INTEGER PRIMARY KEY AUTOINCREMENT, case_ref TEXT UNIQUE NOT NULL, lead_id INTEGER,
      phone TEXT NOT NULL, customer_text TEXT NOT NULL, proposed_reply TEXT NOT NULL,
      group_message_id TEXT, state TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL,
      decided_at TEXT, decision_text TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sales_approvals_state ON sales_approvals(state, created_at);
    CREATE TABLE IF NOT EXISTS sales_approval_cards(
      message_id TEXT PRIMARY KEY,
      stanza TEXT NOT NULL,
      approval_id INTEGER NOT NULL,
      shown_draft TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sales_approval_cards_stanza ON sales_approval_cards(stanza);
    CREATE TABLE IF NOT EXISTS sales_owner_preferences(
      rule_key TEXT PRIMARY KEY,
      instruction TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sales_conversation_queue(
      phone TEXT PRIMARY KEY,
      lead_id INTEGER,
      first_message_at TEXT NOT NULL,
      last_message_at TEXT NOT NULL,
      due_at TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sales_conversation_queue_due ON sales_conversation_queue(state, due_at);
    CREATE TABLE IF NOT EXISTS sales_sla_followups(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      source_message_id TEXT UNIQUE NOT NULL,
      sla_message TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      due_at TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sales_sla_followups_due ON sales_sla_followups(state, due_at);
    CREATE TABLE IF NOT EXISTS sales_order_confirmations(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sla_ref TEXT UNIQUE NOT NULL,
      phone TEXT NOT NULL,
      client_name TEXT,
      message_text TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      message_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sales_order_confirmations_state ON sales_order_confirmations(state, created_at);
    CREATE TABLE IF NOT EXISTS sales_lead_sequence(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      phone TEXT NOT NULL,
      stage TEXT NOT NULL,
      due_at TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(lead_id, stage)
    );
    CREATE INDEX IF NOT EXISTS idx_sales_lead_sequence_due ON sales_lead_sequence(state, due_at);
  `);

  const approvalColumns = db.prepare("PRAGMA table_info(sales_approvals)").all().map(row => row.name);
  if (!approvalColumns.includes("followup_id")) db.exec("ALTER TABLE sales_approvals ADD COLUMN followup_id INTEGER");
  if (!approvalColumns.includes("context_json")) db.exec("ALTER TABLE sales_approvals ADD COLUMN context_json TEXT");
  if (!approvalColumns.includes("sequence_id")) db.exec("ALTER TABLE sales_approvals ADD COLUMN sequence_id INTEGER");
  if (!approvalColumns.includes("instruction_history_json")) db.exec("ALTER TABLE sales_approvals ADD COLUMN instruction_history_json TEXT");
  const confirmationColumns = db.prepare("PRAGMA table_info(sales_order_confirmations)").all().map(row => row.name);
  if (!confirmationColumns.includes("booking_key")) db.exec("ALTER TABLE sales_order_confirmations ADD COLUMN booking_key TEXT");
  if (!confirmationColumns.includes("duplicate_of_sla_ref")) db.exec("ALTER TABLE sales_order_confirmations ADD COLUMN duplicate_of_sla_ref TEXT");

  const now = () => new Date().toISOString();
  const sessionStarted = Date.now();
  const caseRef = () => `SA-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  const ready = () => Boolean(process.env.SALES_ENABLED === "true" && approvalGroup() && reasonerUrl && token && customerClient?.info && approvalClient?.info);
  const conversationReady = () => ready() && process.env.SALES_CONVERSATION_ENABLED === "true";
  function cohortStart() {
    const value = Date.parse(String(process.env.SALES_LEAD_COHORT_START || ""));
    return Number.isFinite(value) ? value : null;
  }
  function eligibleLead(lead) {
    if (process.env.SALES_TEST_MODE !== "false") return Boolean(conversationReady() && lead);
    const start = cohortStart();
    const received = Date.parse(String(lead?.received_at || ""));
    return Boolean(conversationReady() && start !== null && Number.isFinite(received) && received >= start);
  }
  function isNoReplyInstruction(value) {
    const text = String(value || "").toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, " ").trim();
    return /\b(?:do not|don't|dont|no)\s+(?:send|reply|respond)\b/.test(text)
      || /\b(?:leave|ignore|skip)\s+(?:it|this|that|him|her|them|the (?:message|client|customer))\b/.test(text)
      || /\b(?:no response|no reply|say nothing)\b/.test(text);
  }
  function explicitlyAuthorizesSend(value) {
    const text = String(value || "").toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, " ").trim();
    if (!text || isNoReplyInstruction(text)) return false;
    return /\b(?:send(?: it| that| this| the reply| the message)?|go ahead|yes,? send|reply(?: with| saying| to)?|respond(?: with| saying| to)?|tell (?:him|her|them|the client|the customer)|say (?:that|this|to him|to her|to them)|let (?:him|her|them|the client|the customer) know|confirm (?:that|with|to))\b/.test(text);
  }
  function hasPlaceholderLink(value) {
    const text = String(value || "");
    return /https?:\/\/(?:www\.)?(?:yourwebsite\.com|example\.(?:com|org))\b/i.test(text)
      || /\[(?:link|booking link|sla link|insert[^\]]*link)\]/i.test(text);
  }
  const ownerPreferenceRules = [
    ["style.no-em-dash", /\b(?:do not|don't|dont|never)\s+use\s+(?:em|emb)\s*dash/i, "Do not use em dashes. Use normal punctuation and short WhatsApp paragraphs."],
    ["tone.acknowledge", /\b(?:note of understanding|i completely understand|sales 101)\b/i, "After the greeting, acknowledge what the client actually said. Use natural understanding instead of empty small talk such as 'hope you're well'."],
    ["sales.assumptive-close", /\bassumptive(?:ly)?\s+clos/i, "When the facts and an approved rate are sufficient, use an assumptive close with one clear next step instead of asking whether the client wants to proceed."],
    ["quote.benefits", /\bdoor[- ]to[- ]door\b[\s\S]*\binsurance\b|\binsurance\b[\s\S]*\bdoor[- ]to[- ]door\b/i, "After stating an approved rate, reinforce that it includes hassle-free door-to-door delivery and full comprehensive insurance for the bike and declared extras."],
    ["schedule.windows", /\b(?:exact dates?|exact times?|don't confirm dates|do not confirm dates|transport industry is unpredictable|first come first serve)\b/i, "Do not promise exact collection or delivery dates or times unless Duane explicitly approves them. Commit to a realistic window or deadline and allow routing flexibility."],
    ["transport.open", /\b(?:open van|open trailer|closed vehicles?|enclosed)\b/i, "Standard BTSA transport is on an open van and trailer, not an enclosed vehicle. Reassure clients that this is safe when they ask."],
    ["context.use-approved-quote", /\b(?:already quoted|already gave you|including price|confirmed rate|correct rate)\b/i, "Use the latest rate Duane approved for the current case. Never revert to a website estimate or an older draft price."],
  ];
  function ownerPreferences() {
    return db.prepare("SELECT instruction FROM sales_owner_preferences ORDER BY updated_at, rule_key").all().map(row => row.instruction);
  }
  function learnOwnerPreferences(instruction) {
    const text = String(instruction || "");
    for (const [key, pattern, rule] of ownerPreferenceRules) {
      if (!pattern.test(text)) continue;
      db.prepare(`INSERT INTO sales_owner_preferences(rule_key,instruction,updated_at) VALUES(?,?,?)
        ON CONFLICT(rule_key) DO UPDATE SET instruction=excluded.instruction,updated_at=excluded.updated_at`)
        .run(key, rule, now());
    }
    return ownerPreferences();
  }
  function saveReusableLesson(lesson, approvalWords) {
    const rule = typeof lesson === "string" ? lesson.replace(/\s+/g, " ").trim() : "";
    if (!rule || rule.length > 220 || /\d|https?:|@/.test(rule) || !approvalWords || isNoReplyInstruction(approvalWords)) return;
    db.prepare(`INSERT INTO sales_owner_preferences(rule_key,instruction,updated_at) VALUES(?,?,?)
      ON CONFLICT(rule_key) DO UPDATE SET updated_at=excluded.updated_at`)
      .run("coaching:" + rule.toLowerCase(), rule, now());
    db.exec(`DELETE FROM sales_owner_preferences WHERE rule_key LIKE 'coaching:%' AND rule_key NOT IN
      (SELECT rule_key FROM sales_owner_preferences WHERE rule_key LIKE 'coaching:%' ORDER BY updated_at DESC, rule_key DESC LIMIT 12)`);
  }
  function instructionHistory(row) {
    try {
      const parsed = JSON.parse(String(row?.instruction_history_json || "[]"));
      return Array.isArray(parsed) ? parsed.filter(Boolean).slice(-20) : [];
    } catch (_) { return []; }
  }
  function appendInstruction(row, value) {
    const text = String(value || "").trim();
    const items = instructionHistory(row);
    if (text && items.at(-1) !== text) items.push(text);
    const history = items.slice(-20);
    db.prepare("UPDATE sales_approvals SET instruction_history_json=? WHERE id=?").run(JSON.stringify(history), row.id);
    return history;
  }
  function honoursQuotedRate(text) {
    return /\b(?:honou?r|keep|stick to|stand by)\s+(?:the\s+)?(?:original|quoted|quoter|quater|motorcycle|two[- ]wheel(?:er)?)\s+(?:rate|price|quote)\b/i.test(text);
  }
  function priceFromInstruction(value) {
    const text = String(value || "");
    const values = [];
    const add = (raw, k) => {
      let normalized = String(raw || "").replace(/\s/g, "");
      let amount;
      if (k) amount = Number(normalized.replace(",", ".")) * 1000;
      else if (/^\d{1,3},\d{3}$/.test(normalized)) amount = Number(normalized.replace(",", ""));
      else amount = Number(normalized.replace(/,/g, ""));
      if (Number.isFinite(amount) && amount >= 100 && amount <= 100000) values.push(Math.round(amount));
    };
    for (const match of text.matchAll(/\bR\s*(\d[\d.,]*)\s*(k)?\b/gi)) add(match[1], match[2]);
    if (!values.length) {
      const match = text.match(/\b(?:rate|price)\D{0,20}(\d[\d.,]*)\s*(k)?\b/i);
      if (match) add(match[1], match[2]);
    }
    const unique = [...new Set(values)];
    if (unique.length > 1 && honoursQuotedRate(text)) {
      // A named price that Duane explicitly honours is the offer. The quad range is a comparison.
      const reference = [...text.matchAll(/\b(R\s*\d[\d,.]*(?:\s*k\b)?)\s+(?:is|was)\s+the\s+(?:(?:rate|price|quote)\s+for\s+(?:a\s+)?(?:two[- ]wheel(?:er)?|motorcycle)|(?:original|quoted|motorcycle)\s+(?:rate|price|quote))\b/gi)];
      if (reference.length === 1) return priceFromInstruction(reference[0][1]);
    }
    return unique.length === 1 ? unique[0] : unique.length ? 0 : null;
  }
  function generatedBookingLink(context, instructions) {
    const values = Array.isArray(instructions) ? instructions : [instructions];
    if (values.some(value => /\b(?:do not|don't|dont|no)\s+(?:include|add|send|use)?\s*(?:a\s+)?(?:booking|sla|quote)?\s*link\b/i.test(String(value || "")))) return "";
    let price = null;
    for (let i = values.length - 1; i >= 0 && price === null; i--) {
      const text = String(values[i] || "");
      price = priceFromInstruction(text);
      if (/\b(?:don't|dont|do not|not approved|hold off|wrong rate|price is wrong|ignore the (?:rate|quote)|can we|could we|what if)\b/i.test(text)
          && (price !== null || /\b(?:rate|price|quote)\b/i.test(text))) return "";
    }
    const lead = context?.lead || {};
    const pickup = String(lead.pickup || "").trim();
    const dropoff = String(lead.dropoff || "").trim();
    if (!price || !pickup || !dropoff) return "";
    const route = `${pickup} to ${dropoff}`;
    return `https://biketransport.co.za/booking-form/?ts=${Math.floor(Date.now() / 1000)}&route=${encodeURIComponent(route)}&price=${price}`;
  }
  function requestsBookingLink(value) {
    const text = String(value || "");
    return /\b(?:booking|sla)\s+(?:link|form)\b/i.test(text) &&
      /\b(?:close|add|include|generate|use|send|give|provide|put|create|need|with)\b/i.test(text) &&
      !/\b(?:don['’]?t|do not|no|without|omit|remove|leave out)\b[^.!?]{0,45}\b(?:booking|sla)\s+(?:link|form)\b/i.test(text);
  }
  function bookingClose(draft, link) {
    const text = String(draft || "").replace(/https?:\/\/(?:www\.)?biketransport\.co\.za\/(?:booking-form|timestamp)\/?[^\s]*/gi, "").trim();
    const body = text.split(/\n{2,}/).map(paragraph =>
      paragraph.split(/(?<=[.!?])\s+/).filter(sentence =>
        !(/\b(?:access (?:details|constraints)|specific dates|collection dates|preferred dates|dates (?:you|for collection))\b/i.test(sentence) &&
        /\?|\b(?:let me know|share|tell me|please confirm)\b/i.test(sentence)))
      .join(" ").trim()).filter(Boolean).join("\n\n");
    const action = /\b(?:complete|fill (?:in|out))\b[^.!?]*\b(?:booking|form)\b/i.test(body) ? "" : "\n\nPlease complete the booking form below and I’ll take it from there.";
    return body ? body + action + "\n\n" + link : "";
  }
  function priorBookingInstructions(lead, phone) {
    if (!lead?.id || !lead.pickup || !lead.dropoff) return {};
    const row = db.prepare(`SELECT instruction_history_json,context_json,decided_at,created_at FROM sales_approvals
      WHERE lead_id=? AND phone=? AND state='sent' AND followup_id IS NULL AND sequence_id IS NULL AND instruction_history_json IS NOT NULL
      ORDER BY id DESC LIMIT 1`).get(lead.id, phone);
    if (!row) return {};
    try {
      const previousContext = JSON.parse(row.context_json || "{}");
      const previous = previousContext.lead;
      if (previous?.pickup !== lead.pickup || previous?.dropoff !== lead.dropoff ||
          previous?.bike_make !== lead.bike_make || previous?.bike_model !== lead.bike_model) return {};
      const current = instructionHistory(row);
      const recordedAt = Date.parse(row.decided_at || row.created_at);
      const quotedHere = current.some(text => priceFromInstruction(text) !== null);
      const quotedAt = quotedHere ? recordedAt : previousContext.bookingQuotedAt;
      if (!Number.isFinite(quotedAt) || Date.now() - quotedAt >= 24 * 3600000) return {};
      return { instructions: [...(previousContext.bookingInstructions || []), ...current].slice(-20), quotedAt };
    } catch (_) { return {}; }
  }
  function supersedePreCohortApprovals() {
    const start = cohortStart();
    if (start === null) return;
    db.prepare("UPDATE sales_approvals SET state='superseded',decided_at=?,decision_text='Outside website sales cohort' WHERE state='pending' AND followup_id IS NULL AND created_at<?")
      .run(now(), new Date(start).toISOString());
  }
  function claim(message, kind) {
    const id = message.id?._serialized;
    if (!id || String(id).startsWith("true_")) return false;
    const timestamp = Number(message.timestamp) * 1000;
    if (!Number.isFinite(timestamp) || timestamp < sessionStarted - 5000 || timestamp > Date.now() + 60000) return false;
    return db.prepare("INSERT OR IGNORE INTO sales_inbound_claims(message_id,claimed_at) VALUES(?,?)").run(kind + ":" + id, now()).changes === 1;
  }
  function remember(phone, direction, body, messageId, createdAt = now()) {
    return db.prepare("INSERT OR IGNORE INTO sales_messages(created_at,phone,direction,body,message_id) VALUES(?,?,?,?,?)")
      .run(createdAt, phone, direction, String(body || ""), messageId || null).changes === 1;
  }
  function history(phone) {
    return db.prepare("SELECT direction,body,created_at FROM sales_messages WHERE phone=? ORDER BY created_at DESC,id DESC LIMIT 40")
      .all(phone).reverse();
  }
  async function hydrateWhatsAppHistory(message, phone) {
    if (typeof message?.getChat !== "function") return;
    try {
      const chat = await message.getChat();
      const messages = await chat?.fetchMessages?.({ limit: 40 });
      for (const item of messages || []) {
        const body = String(item.body || item._data?.body || item._data?.caption || "").trim();
        const id = String(item.id?._serialized || "");
        if (!body || !id) continue;
        const timestamp = Number(item.timestamp) * 1000;
        const createdAt = Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : now();
        remember(phone, item.fromMe ? "duane" : "customer", body, id, createdAt);
      }
    } catch (error) {
      console.warn("Sales WhatsApp history unavailable; using stored history:", error.message);
    }
  }
  function leadContext(phone, fallback) {
    let rows = [];
    try { rows = db.prepare("SELECT * FROM leads WHERE phone=? ORDER BY submitted_at DESC,id DESC LIMIT 10").all(phone); }
    catch (_) { rows = []; }
    const inquiries = (rows.length ? rows : fallback ? [fallback] : []).map(row => ({
      id: row.id,
      submitted_at: row.submitted_at || "",
      name: row.name || "",
      phone,
      pickup: row.pickup || "",
      dropoff: row.dropoff || "",
      bike_type: row.bike_type || "",
      bike_make: row.bike_make || "",
      bike_model: row.bike_model || "",
      urgency: row.urgency || "",
      website_estimate: row.estimated_price || "",
      price_status: "unconfirmed website estimate; not authority for a firm quote",
    }));
    return { current: inquiries[0] || { id: fallback?.id || null, phone }, inquiries };
  }
  function followupHistory(phone, sentAt) {
    return db.prepare("SELECT direction,body,created_at FROM sales_messages WHERE phone=? AND created_at>=? ORDER BY id DESC LIMIT 16")
      .all(phone, sentAt).reverse();
  }
  async function reason(route, payload) {
    const r = await fetch(reasonerUrl.replace(/\/$/, "") + route, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(90000)
    });
    if (!r.ok) throw new Error(`Sales reasoner ${r.status}: ${await r.text()}`);
    return r.json();
  }
  async function group(text) {
    const sent = await approvalClient.sendMessage(approvalGroup(), text);
    return sent?.id?._serialized || null;
  }
  async function caseCard(row, text, shownDraft = null) {
    const id = await group(text);
    if (id) db.prepare("INSERT OR IGNORE INTO sales_approval_cards(message_id,stanza,approval_id,shown_draft) VALUES(?,?,?,?)")
      .run(id, id.split("_").pop(), row.id, shownDraft);
    return id;
  }
  async function findPending(message) {
    let quotedId = "", quotedText = "";
    if (message.hasQuotedMsg) {
      try {
        const quote = await message.getQuotedMessage();
        quotedId = quote?.id?._serialized || "";
        quotedText = String(quote?.body || "").trim();
      } catch (_) {}
    }
    const quotedRef = quotedText.match(/^(?:Understood\. Revised reply for |Current draft for |I haven['’]t sent anything for |I[’']m not certain you meant to send anything for )?\*?(SA-[A-Z0-9-]+)\b/)?.[1];
    const typedRef = String(message.body || "").match(/^\s*(SA-[A-Z0-9-]+)\b/)?.[1];
    let linked;
    if (quotedId) {
      const stanza = quotedId.split("_").pop();
      linked = db.prepare("SELECT approval_id AS id,shown_draft FROM sales_approval_cards WHERE message_id=?").get(quotedId);
      if (!linked) {
        const matches = db.prepare(`SELECT DISTINCT approval_id AS id,shown_draft FROM sales_approval_cards WHERE stanza=?
          UNION SELECT id,NULL FROM sales_approvals WHERE group_message_id=? OR substr(group_message_id, -length(?)-1)='_' || ?
          LIMIT 3`).all(stanza, quotedId, stanza, stanza);
        // Initial cards also have a legacy ID on the approval row.
        const ids = new Set(matches.map(m => m.id));
        if (ids.size > 1 || new Set(matches.filter(m => m.shown_draft !== null).map(m => m.shown_draft)).size > 1) return null;
        linked = matches.find(m => m.shown_draft !== null) || matches[0];
      }
    }
    const latest = "NOT EXISTS (SELECT 1 FROM sales_approvals newer WHERE newer.phone=sales_approvals.phone AND newer.id>sales_approvals.id)";
    const fromId = linked && db.prepare(`SELECT * FROM sales_approvals WHERE id=? AND ${latest}`).get(linked.id);
    if (linked && !fromId) return null;
    if (quotedRef && typedRef && quotedRef !== typedRef) return null;
    if (fromId && [quotedRef, typedRef].some(ref => ref && ref !== fromId.case_ref)) return null;
    const ref = quotedRef || typedRef;
    if (fromId || ref) {
      const row = fromId || db.prepare(`SELECT * FROM sales_approvals WHERE case_ref=? AND ${latest}`).get(ref);
      if (row?.state === "pending") return { ...row, shownDraft: linked?.shown_draft };
      if (row?.state === "delivery_unknown" && quotedText.startsWith(`*${row.case_ref} `) && !row.followup_id && !row.sequence_id) return row;
      return null;
    }
    if (message.hasQuotedMsg) return null;
    const rows = db.prepare(`SELECT * FROM sales_approvals WHERE state='pending' AND ${latest} ORDER BY id DESC LIMIT 2`).all();
    return rows.length === 1 ? rows[0] : null;
  }

  async function onCustomer(message, lead, phone) {
    if (message.fromMe) return false;
    const cancelled = db.prepare("SELECT id FROM sales_sla_followups WHERE phone=? AND state IN ('pending','processing','approval_sending','approval_unknown','approval_requested')").all(phone);
    if (cancelled.length) {
      db.prepare("UPDATE sales_sla_followups SET state='cancelled_reply',updated_at=? WHERE phone=? AND state IN ('pending','processing','approval_sending','approval_unknown','approval_requested')").run(now(), phone);
      for (const row of cancelled) db.prepare("UPDATE sales_approvals SET state='superseded',decided_at=?,decision_text='Client replied after SLA link' WHERE followup_id=? AND state='pending'").run(now(), row.id);
      logEvent({ leadId: lead?.id || null, phone, type: "sla_followup_cancelled_reply", key: `sla-cancel-${message.id?._serialized || now()}`, details: { count: cancelled.length } });
    }
    const sequenceRows = db.prepare("SELECT id FROM sales_lead_sequence WHERE phone=? AND state IN ('pending','processing','approval_sending','approval_unknown','approval_requested')").all(phone);
    if (sequenceRows.length) {
      db.prepare("UPDATE sales_lead_sequence SET state='cancelled_reply',updated_at=? WHERE phone=? AND state IN ('pending','processing','approval_sending','approval_unknown','approval_requested')").run(now(), phone);
      for (const row of sequenceRows) db.prepare("UPDATE sales_approvals SET state='superseded',decided_at=?,decision_text='Client replied' WHERE sequence_id=? AND state='pending'").run(now(), row.id);
    }
    if (!eligibleLead(lead)) return false;
    supersedePreCohortApprovals();
    const testPhones = String(process.env.SALES_TEST_PHONES || "").split(",").filter(Boolean).map(normalizePhone);
    if (process.env.SALES_TEST_MODE !== "false" && !testPhones.includes(normalizePhone(phone))) return false;
    if (!claim(message, "customer")) return false;
    const text = String(message.body || "").trim();
    if (!text || message.hasMedia) {
      await group(`I received ${message.hasMedia ? "a media message" : "an empty message"} from ${lead?.name || `…${phone.slice(-4)}`}. I haven't replied. Please handle this one manually.`);
      return;
    }
    const repeated = db.prepare("SELECT 1 FROM sales_messages WHERE phone=? AND direction='customer' AND body=? AND created_at>=? LIMIT 1")
      .get(phone, text, new Date(Date.now() - 2 * 60000).toISOString());
    if (repeated) {
      logEvent({ leadId: lead.id, phone, type: "sales_duplicate_inbound_suppressed", key: `sales-duplicate-${message.id?._serialized || now()}`, details: { text } });
      return true;
    }
    const receivedAt = now();
    remember(phone, "customer", text, message.id?._serialized, receivedAt);
    await hydrateWhatsAppHistory(message, phone);
    const debounceSeconds = Math.max(0, Number(process.env.SALES_REPLY_DEBOUNCE_SECONDS ?? 20));
    const dueAt = new Date(Date.parse(receivedAt) + debounceSeconds * 1000).toISOString();
    db.prepare(`INSERT INTO sales_conversation_queue(phone,lead_id,first_message_at,last_message_at,due_at,state,updated_at)
      VALUES(?,?,?,?,?,'pending',?)
      ON CONFLICT(phone) DO UPDATE SET
        lead_id=excluded.lead_id,
        first_message_at=CASE WHEN sales_conversation_queue.state IN ('pending','processing') THEN sales_conversation_queue.first_message_at ELSE excluded.first_message_at END,
        last_message_at=excluded.last_message_at,
        due_at=excluded.due_at,
        state='pending',
        attempts=CASE WHEN sales_conversation_queue.state IN ('pending','processing') THEN sales_conversation_queue.attempts ELSE 0 END,
        updated_at=excluded.updated_at`)
      .run(phone, lead?.id || null, receivedAt, receivedAt, dueAt, receivedAt);
    logEvent({ leadId: lead?.id || null, phone, type: "sales_conversation_queued", key: `sales-queued-${message.id?._serialized || receivedAt}`, details: { dueAt } });
    return true;
  }

  async function processInboundConversations() {
    if (!conversationReady()) return 0;
    const rows = db.prepare("SELECT * FROM sales_conversation_queue WHERE state='pending' AND due_at<=? ORDER BY due_at ASC LIMIT 5").all(now());
    let processed = 0;
    for (const queued of rows) {
      const locked = db.prepare("UPDATE sales_conversation_queue SET state='processing',attempts=attempts+1,updated_at=? WHERE phone=? AND state='pending' AND due_at=?")
        .run(now(), queued.phone, queued.due_at);
      if (locked.changes !== 1) continue;
      try {
        const lead = queued.lead_id
          ? db.prepare("SELECT * FROM leads WHERE id=?").get(queued.lead_id)
          : db.prepare("SELECT * FROM leads WHERE phone=? ORDER BY submitted_at DESC,id DESC LIMIT 1").get(queued.phone);
        if (!eligibleLead(lead)) {
          db.prepare("UPDATE sales_conversation_queue SET state='ignored',updated_at=? WHERE phone=? AND state='processing' AND last_message_at=?")
            .run(now(), queued.phone, queued.last_message_at);
          continue;
        }
        const newMessages = db.prepare(`SELECT body,created_at FROM sales_messages
          WHERE phone=? AND direction='customer' AND created_at>=? AND created_at<=?
          ORDER BY created_at ASC,id ASC`).all(queued.phone, queued.first_message_at, queued.last_message_at);
        const customerText = newMessages.map(row => row.body).filter(Boolean).join("\n");
        if (!customerText) throw new Error("Queued conversation has no customer text");
        const context = process.env.SALES_TEST_MODE === "false"
          ? leadContext(queued.phone, lead)
          : { current: { id: lead.id, phone: queued.phone, context_status: "isolated test enquiry; saved form details intentionally excluded" }, inquiries: [] };
        const conversation = history(queued.phone);
        const booking = priorBookingInstructions(context.current, queued.phone);
        const bookingInstructions = booking.instructions || [];
        const generatedLink = generatedBookingLink({ lead: context.current }, bookingInstructions);
        const out = await reason("/sales/customer", {
          lead: context.current,
          leadInquiries: context.inquiries,
          message: customerText,
          newMessages,
          history: conversation,
          ownerPreferences: ownerPreferences(),
          generatedBookingLink: generatedLink || undefined,
        });
        const active = db.prepare("SELECT state,last_message_at FROM sales_conversation_queue WHERE phone=?").get(queued.phone);
        if (!active || active.state !== "processing" || active.last_message_at !== queued.last_message_at) continue;
        if (out.action === "no_reply") {
          db.prepare("UPDATE sales_conversation_queue SET state='completed',updated_at=? WHERE phone=? AND state='processing' AND last_message_at=?")
            .run(now(), queued.phone, queued.last_message_at);
          logEvent({ leadId: lead.id, phone: queued.phone, type: "sales_no_reply", key: `sales-no-reply-${queued.last_message_at}`, details: { category: out.category, notes: out.notes } });
          processed++;
          continue;
        }
        if (out.action !== "reply" && out.action !== "owner_input") throw new Error("Reasoner returned an unsupported sales action");
        if (out.action === "reply" && !String(out.proposedReply || "").trim()) throw new Error("Reasoner returned no proposed reply");
        if (out.action === "owner_input" && !String(out.ownerQuestion || "").trim()) throw new Error("Reasoner returned no owner question");
        const ref = caseRef();
        db.prepare("UPDATE sales_approvals SET state='superseded',decided_at=?,decision_text='Newer client turn' WHERE phone=? AND state='pending'")
          .run(now(), queued.phone);
        const contextJson = JSON.stringify({ lead: context.current, leadInquiries: context.inquiries, history: conversation, newMessages, salesMove: out.salesMove, bookingInstructions, bookingQuotedAt: booking.quotedAt });
        const result = db.prepare("INSERT INTO sales_approvals(case_ref,lead_id,phone,customer_text,proposed_reply,context_json,created_at) VALUES(?,?,?,?,?,?,?)")
          .run(ref, lead.id, queued.phone, customerText, String(out.proposedReply || ""), contextJson, now());
        const bike = [context.current.bike_make, context.current.bike_model].filter(Boolean).join(" ");
        const route = [context.current.pickup, context.current.dropoff].filter(Boolean).join(" → ");
        const label = `${context.current.name || `Lead …${queued.phone.slice(-4)}`}${bike ? ` | ${bike}` : ""}${route ? `\n${route}` : ""}`;
        const move = String(out.salesMove || "answer").replace(/_/g, " ");
        const recommendation = out.action === "owner_input"
          ? `*I need from you:*\n${out.ownerQuestion}`
          : `*My suggested reply:*\n${out.proposedReply}`;
        const card = `*${ref} — ${label}*\n\n*Client (${newMessages.length} message${newMessages.length === 1 ? "" : "s"}):*\n${customerText}\n\n*Sales move:* ${move}\n\n${recommendation}\n\nReply naturally or send a voice note. I will wait for your approval before sending anything.`;
        let groupId;
        try { groupId = await caseCard({id: Number(result.lastInsertRowid)}, card, out.proposedReply || null); }
        catch (error) {
          db.prepare("UPDATE sales_approvals SET state='delivery_unknown',decided_at=?,decision_text='Approval card delivery unknown' WHERE id=? AND state='pending'")
            .run(now(), Number(result.lastInsertRowid));
          db.prepare("UPDATE sales_conversation_queue SET state='approval_unknown',updated_at=? WHERE phone=? AND state='processing' AND last_message_at=?")
            .run(now(), queued.phone, queued.last_message_at);
          throw error;
        }
        db.prepare("UPDATE sales_approvals SET group_message_id=? WHERE id=?").run(groupId, Number(result.lastInsertRowid));
        db.prepare("UPDATE sales_conversation_queue SET state='completed',updated_at=? WHERE phone=? AND state='processing' AND last_message_at=?")
          .run(now(), queued.phone, queued.last_message_at);
        logEvent({ leadId: lead.id, phone: queued.phone, type: "sales_approval_requested", key: `sales-request-${ref}`, details: { ref, action: out.action, salesMove: out.salesMove, category: out.category, confidence: out.confidence, messageCount: newMessages.length } });
        processed++;
      } catch (error) {
        const current = db.prepare("SELECT state,attempts FROM sales_conversation_queue WHERE phone=?").get(queued.phone);
        if (current?.state === "processing") {
          const state = current.attempts >= 3 ? "failed" : "pending";
          const retryAt = new Date(Date.now() + 60000).toISOString();
          db.prepare("UPDATE sales_conversation_queue SET state=?,due_at=?,updated_at=? WHERE phone=? AND state='processing'")
            .run(state, retryAt, now(), queued.phone);
        }
        console.error("Sales conversation processing failed:", error.message);
      }
    }
    return processed;
  }

  async function onOutgoing(message, phone) {
    if (!message?.fromMe || !/^\d{9,15}$/.test(String(phone || ""))) return false;
    const body = String(message.body || message._data?.body || message._data?.caption || "").trim();
    const messageId = String(message.id?._serialized || "");
    if (!body || !messageId) return false;
    const timestamp = Number(message.timestamp) * 1000;
    const sentAt = Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : now();
    const normalized = localPhone(phone);
    const recorded = remember(normalized, "duane", body, messageId, sentAt);
    if (!/https?:\/\/(?:www\.)?biketransport\.co\.za\/(?:timestamp|booking-form)\/?[^\s]*/i.test(body)) return recorded;
    const followupHours = Math.max(1, Number(process.env.SALES_SLA_FOLLOWUP_HOURS || 24));
    const dueAt = new Date(Date.parse(sentAt) + followupHours * 3600000).toISOString();
    if (db.prepare("SELECT 1 FROM sales_sla_followups WHERE source_message_id=?").get(messageId)) return false;
    const older = db.prepare("SELECT id FROM sales_sla_followups WHERE phone=? AND state IN ('pending','processing','approval_sending','approval_unknown','approval_requested')").all(normalized);
    db.prepare("UPDATE sales_sla_followups SET state='superseded',updated_at=? WHERE phone=? AND state IN ('pending','processing','approval_sending','approval_unknown','approval_requested')").run(now(), normalized);
    for (const row of older) db.prepare("UPDATE sales_approvals SET state='superseded',decided_at=?,decision_text='Newer SLA link sent' WHERE followup_id=? AND state='pending'").run(now(), row.id);
    const sequenceRows = db.prepare("SELECT id FROM sales_lead_sequence WHERE phone=? AND state IN ('pending','processing','approval_sending','approval_unknown','approval_requested')").all(normalized);
    db.prepare("UPDATE sales_lead_sequence SET state='cancelled_sla',updated_at=? WHERE phone=? AND state IN ('pending','processing','approval_sending','approval_unknown','approval_requested')").run(now(), normalized);
    for (const row of sequenceRows) db.prepare("UPDATE sales_approvals SET state='superseded',decided_at=?,decision_text='SLA link sent' WHERE sequence_id=? AND state='pending'").run(now(), row.id);
    const result = db.prepare("INSERT INTO sales_sla_followups(phone,source_message_id,sla_message,sent_at,due_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run(normalized, messageId, body, sentAt, dueAt, now(), now());
    if (result.changes !== 1) return false;
    logEvent({ phone: normalized, type: "sla_followup_scheduled", key: `sla-scheduled-${messageId}`, details: { dueAt } });
    console.log("SLA follow-up scheduled", { phone: normalized.slice(-4), dueAt });
    return true;
  }

  async function processDueFollowups() {
    if (!ready()) return 0;
    const rows = db.prepare("SELECT * FROM sales_sla_followups WHERE state='pending' AND due_at<=? ORDER BY due_at ASC LIMIT 5").all(now());
    let processed = 0;
    for (const row of rows) {
      const locked = db.prepare("UPDATE sales_sla_followups SET state='processing',updated_at=? WHERE id=? AND state='pending'").run(now(), row.id);
      if (locked.changes !== 1) continue;
      try {
        const lead = db.prepare("SELECT * FROM leads WHERE phone=? ORDER BY submitted_at DESC LIMIT 1").get(row.phone);
        const out = await reason("/sales/followup", {
          lead: lead ? { name: lead.name || "", phone: row.phone } : { phone: row.phone },
          slaMessage: row.sla_message,
          sentAt: row.sent_at,
          history: followupHistory(row.phone, row.sent_at),
        });
        if (!out.proposedReply) throw new Error("Reasoner returned no SLA follow-up reply");
        const ref = caseRef();
        db.prepare("UPDATE sales_approvals SET state='superseded' WHERE phone=? AND state='pending'").run(row.phone);
        const result = db.prepare("INSERT INTO sales_approvals(case_ref,lead_id,phone,customer_text,proposed_reply,followup_id,created_at) VALUES(?,?,?,?,?,?,?)")
          .run(ref, lead?.id || null, row.phone, "No reply since SLA/booking link", out.proposedReply, row.id, now());
        const card = `*${ref} — SLA follow-up due — ${lead?.name || `Lead …${row.phone.slice(-4)}`}*\n\nYou sent the booking/SLA link yesterday and the client has not replied.\n\n*My suggested follow-up:*\n${out.proposedReply}\n\nReply naturally or send a voice note. I will wait for your approval before sending.`;
        db.prepare("UPDATE sales_sla_followups SET state='approval_sending',updated_at=? WHERE id=? AND state='processing'").run(now(), row.id);
        let groupId;
        try { groupId = await caseCard({id: Number(result.lastInsertRowid)}, card, out.proposedReply || null); }
        catch (error) {
          db.prepare("UPDATE sales_sla_followups SET state='approval_unknown',updated_at=? WHERE id=? AND state='approval_sending'").run(now(), row.id);
          throw error;
        }
        db.prepare("UPDATE sales_approvals SET group_message_id=? WHERE id=?").run(groupId, Number(result.lastInsertRowid));
        db.prepare("UPDATE sales_sla_followups SET state='approval_requested',updated_at=? WHERE id=? AND state='approval_sending'").run(now(), row.id);
        logEvent({ leadId: lead?.id || null, phone: row.phone, type: "sla_followup_approval_requested", key: `sla-followup-${row.source_message_id}`, details: { ref } });
        processed++;
      } catch (error) {
        db.prepare("UPDATE sales_sla_followups SET state='pending',updated_at=? WHERE id=? AND state='processing'").run(now(), row.id);
        console.error("SLA follow-up processing failed:", error.message);
      }
    }
    return processed;
  }

  async function processLeadSequence() {
    if (!conversationReady()) return 0;
    const start = cohortStart();
    if (start === null) return 0;
    supersedePreCohortApprovals();
    const day3Hours = Math.max(48, Number(process.env.SALES_DAY3_HOURS || 72));
    const day7Hours = Math.max(day3Hours + 24, Number(process.env.SALES_DAY7_HOURS || 168));
    const leads = db.prepare(`SELECT l.* FROM leads l
      WHERE l.received_at>=? AND l.first_touch_sent_at IS NOT NULL AND l.followup_sent_at IS NOT NULL
        AND l.replied_at IS NULL AND l.duplicate_suppressed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM leads r WHERE r.phone=l.phone AND r.replied_at IS NOT NULL AND r.replied_at>=l.first_touch_sent_at)
      ORDER BY l.first_touch_sent_at ASC LIMIT 20`).all(new Date(start).toISOString());
    let processed = 0;
    for (const lead of leads) {
      const firstTouchAt = Date.parse(lead.first_touch_sent_at);
      if (!Number.isFinite(firstTouchAt)) continue;
      const manualAfterFollowup = db.prepare("SELECT 1 FROM sales_messages WHERE phone=? AND direction='duane' AND created_at>? LIMIT 1")
        .get(lead.phone, new Date(Date.parse(lead.followup_sent_at) + 2 * 60000).toISOString());
      if (manualAfterFollowup) continue;
      const day3 = db.prepare("SELECT * FROM sales_lead_sequence WHERE lead_id=? AND stage='day3'").get(lead.id);
      const day7 = db.prepare("SELECT * FROM sales_lead_sequence WHERE lead_id=? AND stage='day7'").get(lead.id);
      let stage = "";
      let dueAt = "";
      if (!day3 && Date.now() >= firstTouchAt + day3Hours * 3600000) {
        stage = "day3";
        dueAt = new Date(firstTouchAt + day3Hours * 3600000).toISOString();
      } else if (day3?.state === "sent" && !day7 && Date.now() >= firstTouchAt + day7Hours * 3600000) {
        stage = "day7";
        dueAt = new Date(firstTouchAt + day7Hours * 3600000).toISOString();
      }
      if (!stage) continue;
      const activeApproval = db.prepare("SELECT 1 FROM sales_approvals WHERE phone=? AND state='pending' LIMIT 1").get(lead.phone);
      if (activeApproval) continue;
      const created = db.prepare("INSERT OR IGNORE INTO sales_lead_sequence(lead_id,phone,stage,due_at,created_at,updated_at) VALUES(?,?,?,?,?,?)")
        .run(lead.id, lead.phone, stage, dueAt, now(), now());
      if (created.changes !== 1) continue;
      const sequence = db.prepare("SELECT * FROM sales_lead_sequence WHERE lead_id=? AND stage=?").get(lead.id, stage);
      const locked = db.prepare("UPDATE sales_lead_sequence SET state='processing',updated_at=? WHERE id=? AND state='pending'").run(now(), sequence.id);
      if (locked.changes !== 1) continue;
      try {
        const context = leadContext(lead.phone, lead);
        const conversation = history(lead.phone);
        const out = await reason("/sales/sequence", {
          stage,
          lead: context.current,
          leadInquiries: context.inquiries,
          history: conversation,
          firstTouchSentAt: lead.first_touch_sent_at,
          followupSentAt: lead.followup_sent_at,
        });
        if (!out.proposedReply) throw new Error("Reasoner returned no lead-sequence reply");
        const ref = caseRef();
        const contextJson = JSON.stringify({ lead: context.current, leadInquiries: context.inquiries, history: conversation, stage });
        const result = db.prepare("INSERT INTO sales_approvals(case_ref,lead_id,phone,customer_text,proposed_reply,context_json,sequence_id,created_at) VALUES(?,?,?,?,?,?,?,?)")
          .run(ref, lead.id, lead.phone, stage === "day3" ? "No reply after first touch and 24-hour follow-up" : "No reply after Day 3 check-in", out.proposedReply, contextJson, sequence.id, now());
        const title = stage === "day3" ? "Day 3 website-lead check-in" : "Day 7 website-lead close";
        const bike = [lead.bike_make, lead.bike_model].filter(Boolean).join(" ");
        const card = `*${ref} — ${title} — ${lead.name || `Lead …${lead.phone.slice(-4)}`}*\n${bike ? `${bike}\n` : ""}${[lead.pickup, lead.dropoff].filter(Boolean).join(" → ")}\n\n*My suggested follow-up:*\n${out.proposedReply}\n\nReply naturally or send a voice note. I will wait for your approval before sending.`;
        db.prepare("UPDATE sales_lead_sequence SET state='approval_sending',updated_at=? WHERE id=? AND state='processing'").run(now(), sequence.id);
        let groupId;
        try { groupId = await caseCard({id: Number(result.lastInsertRowid)}, card, out.proposedReply || null); }
        catch (error) {
          db.prepare("UPDATE sales_lead_sequence SET state='approval_unknown',updated_at=? WHERE id=? AND state='approval_sending'").run(now(), sequence.id);
          throw error;
        }
        db.prepare("UPDATE sales_approvals SET group_message_id=? WHERE id=?").run(groupId, Number(result.lastInsertRowid));
        db.prepare("UPDATE sales_lead_sequence SET state='approval_requested',updated_at=? WHERE id=? AND state='approval_sending'").run(now(), sequence.id);
        logEvent({ leadId: lead.id, phone: lead.phone, type: "sales_sequence_approval_requested", key: `sales-sequence-${lead.id}-${stage}`, details: { ref, stage } });
        processed++;
      } catch (error) {
        db.prepare("UPDATE sales_lead_sequence SET state='pending',updated_at=? WHERE id=? AND state='processing'").run(now(), sequence.id);
        console.error("Sales lead sequence processing failed:", error.message);
      }
    }
    return processed;
  }

  function orderConfirmationText(name) {
    const greeting = name ? `Thanks ${name}, I’ve received your booking form 🙌` : "Thanks, I’ve received your booking form 🙌";
    return `${greeting}\n\nYour invoice, including the banking details, will be generated automatically and sent to you by email. Payment is due upfront or at collection. Payment secures your slot and locks in the quoted rate.\n\nI’ll confirm the collection and delivery arrangements with you here on WhatsApp. If I need anything else, I’ll reach out here. If you have any questions, ask me anytime.\n\nThanks, Duane`;
  }

  function onOrderConfirmed({ slaRef, phone, name, bike, route, odometer, value }) {
    const ref = String(slaRef || "").trim().toUpperCase();
    const normalized = localPhone(phone);
    if (!/^SLA-\d+$/.test(ref)) throw new Error("Valid SLA reference required");
    if (!/^\d{9}$/.test(normalized)) throw new Error("Valid South African customer phone required");
    const clientName = String(name || "").trim().slice(0, 120);
    const message = orderConfirmationText(clientName);
    const stamp = now();
    const identityPart = value => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const numericIdentityPart = value => String(value || "").replace(/\D/g, "");
    const identity = [identityPart(bike), identityPart(route), numericIdentityPart(odometer), numericIdentityPart(value)];
    const bookingKey = identity.some(Boolean) ? identity.join("|") : "";
    const cutoff = new Date(Date.now() - 86400000).toISOString();
    const recent = bookingKey
      ? db.prepare("SELECT sla_ref FROM sales_order_confirmations WHERE phone=? AND booking_key=? AND created_at>=? AND state IN ('pending','sending','sent','send_unknown','suppressed_duplicate') ORDER BY id LIMIT 1").get(normalized, bookingKey, cutoff)
      : db.prepare("SELECT sla_ref FROM sales_order_confirmations WHERE phone=? AND created_at>=? AND state IN ('pending','sending','sent','send_unknown','suppressed_duplicate') ORDER BY id LIMIT 1").get(normalized, cutoff);
    const state = recent ? "suppressed_duplicate" : "pending";
    const result = db.prepare("INSERT OR IGNORE INTO sales_order_confirmations(sla_ref,phone,client_name,message_text,state,booking_key,duplicate_of_sla_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(ref, normalized, clientName, message, state, bookingKey || null, recent?.sla_ref || null, stamp, stamp);
    if (result.changes !== 1) {
      return { accepted: true, deduplicated: true, confirmation: db.prepare("SELECT sla_ref,state,updated_at FROM sales_order_confirmations WHERE sla_ref=?").get(ref) };
    }
    const followups = db.prepare("SELECT id FROM sales_sla_followups WHERE phone=? AND state IN ('pending','processing','approval_sending','approval_unknown','approval_requested')").all(normalized);
    db.prepare("UPDATE sales_sla_followups SET state='cancelled_order',updated_at=? WHERE phone=? AND state IN ('pending','processing','approval_sending','approval_unknown','approval_requested')").run(stamp, normalized);
    for (const row of followups) {
      db.prepare("UPDATE sales_approvals SET state='superseded',decided_at=?,decision_text='SLA submitted successfully' WHERE followup_id=? AND state='pending'").run(stamp, row.id);
    }
    const sequenceRows = db.prepare("SELECT id FROM sales_lead_sequence WHERE phone=? AND state IN ('pending','processing','approval_sending','approval_unknown','approval_requested')").all(normalized);
    db.prepare("UPDATE sales_lead_sequence SET state='cancelled_order',updated_at=? WHERE phone=? AND state IN ('pending','processing','approval_sending','approval_unknown','approval_requested')").run(stamp, normalized);
    for (const row of sequenceRows) db.prepare("UPDATE sales_approvals SET state='superseded',decided_at=?,decision_text='SLA submitted successfully' WHERE sequence_id=? AND state='pending'").run(stamp, row.id);
    if (recent) {
      logEvent({ phone: normalized, type: "sales_order_confirmation_duplicate_suppressed", key: `sales-order-thanks-suppressed-${ref}`, details: { slaRef: ref, duplicateOf: recent.sla_ref, bookingKey: bookingKey || null } });
      return { accepted: true, deduplicated: true, confirmation: { sla_ref: ref, state, duplicate_of_sla_ref: recent.sla_ref, updated_at: stamp } };
    }
    logEvent({ phone: normalized, type: "sales_order_confirmed", key: `sales-order-${ref}`, details: { slaRef: ref, cancelledFollowups: followups.length } });
    return { accepted: true, deduplicated: false, confirmation: { sla_ref: ref, state: "pending", updated_at: stamp } };
  }

  async function processOrderConfirmations() {
    if (!customerClient?.info) return 0;
    const rows = db.prepare("SELECT * FROM sales_order_confirmations WHERE state='pending' ORDER BY id LIMIT 5").all();
    let processed = 0;
    for (const row of rows) {
      const locked = db.prepare("UPDATE sales_order_confirmations SET state='sending',updated_at=? WHERE id=? AND state='pending'").run(now(), row.id);
      if (locked.changes !== 1) continue;
      try {
        const sent = await customerClient.sendMessage(`${normalizePhone(row.phone)}@c.us`, row.message_text);
        db.prepare("UPDATE sales_order_confirmations SET state='sent',updated_at=?,message_id=? WHERE id=? AND state='sending'")
          .run(now(), sent?.id?._serialized || null, row.id);
        remember(row.phone, "agent", row.message_text, sent?.id?._serialized);
        logEvent({ phone: row.phone, type: "sales_order_thank_you_sent", key: `sales-order-thanks-${row.sla_ref}`, details: { slaRef: row.sla_ref } });
        processed++;
      } catch (error) {
        db.prepare("UPDATE sales_order_confirmations SET state='send_unknown',updated_at=? WHERE id=? AND state='sending'").run(now(), row.id);
        console.error("Order confirmation send outcome unknown; automatic retry blocked:", row.sla_ref, error.message);
      }
    }
    return processed;
  }

  async function onApproval(message) {
    if (!ready() || message._viaSharedBridge !== true || message.from !== approvalGroup() || message.fromMe) return false;
    const owner = String(customerClient.info?.wid?.user || "");
    const author = String(message._approvalAuthorPhone || "");
    const authorId = String(message.author || "");
    const ownerId = String(customerClient.info?.wid?._serialized || "");
    const trustedOwnerIds = String(process.env.SALES_APPROVER_IDS || "").split(",").map(x => x.trim()).filter(Boolean);
    let isOwner = Boolean(authorId && ((ownerId && authorId === ownerId) || trustedOwnerIds.includes(authorId)));
    if (!isOwner && /^\d{9,15}$/.test(owner) && author) isOwner = normalizePhone(author) === normalizePhone(owner);
    if (!isOwner && authorId.endsWith("@lid") && customerClient.getContactLidAndPhone) {
      try {
        const mappings = await customerClient.getContactLidAndPhone([authorId]);
        const pn = String(mappings?.[0]?.pn || "").replace(/@(c\.us|s\.whatsapp\.net)$/, "");
        isOwner = Boolean(pn && normalizePhone(pn) === normalizePhone(owner));
      } catch (_) {}
    }
    if (!isOwner) { console.log("Sales approval ignored: owner identity not verified"); return false; }
    if (!claim(message, "approval")) return false;
    supersedePreCohortApprovals();
    const row = await findPending(message);
    if (!row) {
      console.log("Sales approval ignored: no unambiguous active case");
      if (message.hasQuotedMsg || /^\s*SA-[A-Z0-9-]+\b/.test(String(message.body || ""))) {
        await group("I couldn't match that reply to a current sales card. Please reply to the latest card or start your reply with its SA reference. Nothing was sent to the client.");
      }
      return true;
    }
    if (row.followup_id) {
      const followup = db.prepare("SELECT state FROM sales_sla_followups WHERE id=?").get(row.followup_id);
      if (!followup || followup.state !== "approval_requested") {
        db.prepare("UPDATE sales_approvals SET state='superseded',decided_at=?,decision_text='SLA follow-up no longer active' WHERE id=? AND state='pending'").run(now(), row.id);
        console.log("Sales approval ignored: SLA follow-up is no longer active");
        return true;
      }
    }
    if (row.sequence_id) {
      const sequence = db.prepare("SELECT state FROM sales_lead_sequence WHERE id=?").get(row.sequence_id);
      if (!sequence || sequence.state !== "approval_requested") {
        db.prepare("UPDATE sales_approvals SET state='superseded',decided_at=?,decision_text='Lead sequence no longer active' WHERE id=? AND state='pending'").run(now(), row.id);
        console.log("Sales approval ignored: lead sequence is no longer active");
        return true;
      }
    }
    let audio = null;
    if (message.hasMedia) {
      const m = await message.downloadMedia();
      if (m?.data) audio = { data: m.data, mimetype: m.mimetype || "audio/ogg", filename: m.filename || "approval.ogg" };
    }
    const instruction = String(message.body || "").trim();
    const asksToSeeDraft = /\b(?:show|see|view|repeat|resend)\b.{0,20}\b(?:draft|reply|message)\b|\bwhat(?:'s| is) the (?:draft|reply|message)\b/i.test(instruction);
    if (asksToSeeDraft && row.proposed_reply) {
      await caseCard(row, `Current draft for *${row.case_ref}*:\n\n${row.proposed_reply}\n\nIf that is right, just say “send it”.`, row.proposed_reply);
      return true;
    }
    if (isNoReplyInstruction(instruction)) {
      db.prepare("UPDATE sales_approvals SET state='cancelled',decided_at=?,decision_text=? WHERE id=? AND state IN ('pending','delivery_unknown')")
        .run(now(), instruction, row.id);
      if (row.followup_id) db.prepare("UPDATE sales_sla_followups SET state='cancelled_owner',updated_at=? WHERE id=? AND state='approval_requested'").run(now(), row.followup_id);
      if (row.sequence_id) db.prepare("UPDATE sales_lead_sequence SET state='cancelled_owner',updated_at=? WHERE id=? AND state='approval_requested'").run(now(), row.sequence_id);
      await group(`Understood. I won't reply to ${row.case_ref}.`);
      logEvent({ leadId: row.lead_id, phone: row.phone, type: "sales_reply_cancelled", key: `sales-cancelled-${row.case_ref}`, details: { ref: row.case_ref } });
      return true;
    }
    const preferences = learnOwnerPreferences(instruction);
    const priorInstructions = instructionHistory(row);
    const baseContext = row.context_json ? JSON.parse(row.context_json) : {};
    const inheritedBooking = Date.now() - baseContext.bookingQuotedAt < 24 * 3600000 ? baseContext.bookingInstructions : [];
    const bookingLink = generatedBookingLink(baseContext, [...(inheritedBooking || []), ...priorInstructions, instruction]);
    const forceBookingClose = !row.followup_id && !row.sequence_id &&
      (requestsBookingLink(instruction) || /\bassumptive\s+clos/i.test(instruction) ||
        (honoursQuotedRate(instruction) && /\b(?:have|got) (?:space|availability|a slot)\b/i.test(instruction))) && Boolean(bookingLink);
    if (!row.followup_id && !row.sequence_id && requestsBookingLink(instruction) && !bookingLink) {
      appendInstruction(row, instruction);
      const lead = baseContext.lead || {};
      const missing = lead.pickup && lead.dropoff ? "one final customer rate" : "the exact collection and delivery route";
      await caseCard(row, `I haven’t sent anything for ${row.case_ref}. I need ${missing} to prepare the booking link.`);
      return true;
    }
    const out = await reason("/sales/approval", {
      caseRef: row.case_ref, customerMessage: row.customer_text, proposedReply: row.proposed_reply,
      instruction, audio, context: {
        ...baseContext,
        ownerPreferences: preferences,
        ownerInstructionHistory: priorInstructions,
        generatedBookingLink: bookingLink || undefined,
        ownerAnswerHandling: forceBookingClose ? "Return a revised draft. This case is past qualification. Preserve the exact normal price range as a comparison, the separately honoured final price and the owner-confirmed availability when supplied. Close directly with the supplied booking form. Do not ask for dates, access details, or whether they want to proceed. Do not send." : !row.proposed_reply ? "The card asked Duane for missing facts. When his response supplies those facts or gives wording directions, use them to draft the next customer reply and return intent=revise with finalReply populated. Do not send; ask for a separate approval." : undefined
      }
    });
    const approvalWords = [instruction, out.transcript].filter(Boolean).join("\n");
    appendInstruction(row, approvalWords);
    if (out.transcript) learnOwnerPreferences(out.transcript);
    if (out.intent !== "send" && out.intent !== "cancel") saveReusableLesson(out.reusableLesson, approvalWords);
    if (row.state === "delivery_unknown") {
      // Reconcile the observed card, but require a separate send instruction.
      const recovered = db.prepare("UPDATE sales_approvals SET state='pending' WHERE id=? AND state='delivery_unknown'").run(row.id);
      if (recovered.changes !== 1) return true;
      if (out.intent === "send") out.intent = "revise";
    }
    if (!row.proposed_reply && out.intent === "send") out.intent = "revise";
    if (forceBookingClose && out.intent !== "cancel" && out.finalReply) {
      out.finalReply = bookingClose(out.finalReply, bookingLink);
      out.intent = "revise";
    }
    const sendAuthorized = explicitlyAuthorizesSend(approvalWords);
    if (out.intent === "send" && sendAuthorized && row.shownDraft != null && row.shownDraft !== row.proposed_reply) {
      await caseCard(row, `Current draft for *${row.case_ref}*:\n\n${row.proposed_reply}\n\nThe card you replied to was older. Nothing was sent. Reply to this draft with “send it” to approve it.`, row.proposed_reply);
      return true;
    }
    if (out.intent === "send" && /^(?:SA-[A-Z0-9-]+\s+)?(?:send it|go ahead|yes,? send)[.!]?$/i.test(approvalWords.trim())) {
      out.finalReply = row.proposed_reply;
    }
    if (out.finalReply && hasPlaceholderLink(out.finalReply)) {
      await caseCard(row, `I haven't sent anything for ${row.case_ref}. The draft contains a placeholder link. Send me the real BTSA booking link, or tell me to leave the link out.`);
      return true;
    }
    if (out.intent === "send" && !sendAuthorized && out.finalReply && out.finalReply.trim() !== row.proposed_reply.trim()) {
      // The model sometimes labels wording feedback as "send". Preserve the revision,
      // but keep the separate explicit-send gate closed.
      out.intent = "revise";
    }
    if (out.intent === "cancel" || isNoReplyInstruction(approvalWords)) {
      db.prepare("UPDATE sales_approvals SET state='cancelled',decided_at=?,decision_text=? WHERE id=? AND state='pending'")
        .run(now(), approvalWords || "No reply", row.id);
      if (row.followup_id) db.prepare("UPDATE sales_sla_followups SET state='cancelled_owner',updated_at=? WHERE id=? AND state='approval_requested'").run(now(), row.followup_id);
      if (row.sequence_id) db.prepare("UPDATE sales_lead_sequence SET state='cancelled_owner',updated_at=? WHERE id=? AND state='approval_requested'").run(now(), row.sequence_id);
      await group(`Understood. I won't reply to ${row.case_ref}.`);
      logEvent({ leadId: row.lead_id, phone: row.phone, type: "sales_reply_cancelled", key: `sales-cancelled-${row.case_ref}`, details: { ref: row.case_ref } });
    } else if (out.intent === "send" && out.finalReply && sendAuthorized) {
      // Atomic send-once lock; uncertain sends stay locked for manual reconciliation.
      const locked = db.prepare("UPDATE sales_approvals SET state='sending',decided_at=? WHERE id=? AND state='pending' AND proposed_reply=? AND NOT EXISTS (SELECT 1 FROM sales_approvals newer WHERE newer.phone=sales_approvals.phone AND newer.id>sales_approvals.id)").run(now(), row.id, row.proposed_reply);
      if (locked.changes !== 1) return true;
      const sent = await customerClient.sendMessage(`${normalizePhone(row.phone)}@c.us`, out.finalReply);
      remember(row.phone, "agent", out.finalReply, sent?.id?._serialized);
      db.prepare("UPDATE sales_approvals SET state='sent',decided_at=?,decision_text=? WHERE id=?").run(now(), instruction || out.transcript || "voice approval", row.id);
      if (row.followup_id) db.prepare("UPDATE sales_sla_followups SET state='sent',updated_at=? WHERE id=? AND state='approval_requested'").run(now(), row.followup_id);
      if (row.sequence_id) db.prepare("UPDATE sales_lead_sequence SET state='sent',updated_at=? WHERE id=? AND state='approval_requested'").run(now(), row.sequence_id);
      await group(`Sent to ${row.case_ref}:\n\n${out.finalReply}`);
      logEvent({ leadId: row.lead_id, phone: row.phone, type: "sales_reply_sent", key: `sales-sent-${row.case_ref}`, details: { ref: row.case_ref } });
    } else if (out.intent === "send") {
      await caseCard(row, `I haven't sent anything for ${row.case_ref}. I need a clear instruction such as “send it” before any client message can leave.`);
    } else if (out.intent === "revise" && out.finalReply) {
      db.prepare("UPDATE sales_approvals SET proposed_reply=?,decision_text=? WHERE id=?").run(out.finalReply, instruction || out.transcript || "voice revision", row.id);
      await caseCard(row, `Understood. Revised reply for *${row.case_ref}*:\n\n${out.finalReply}\n\nIf that is right, just say “send it”.`, out.finalReply);
    } else {
      await caseCard(row, `*${row.case_ref}*\n${out.response || "Tell me what you want changed, or say “send it” when ready."}`);
    }
    return true;
  }

  return { onCustomer, onOutgoing, onApproval, onOrderConfirmed, processInboundConversations, processDueFollowups, processLeadSequence, processOrderConfirmations, ready, conversationReady };
}

module.exports = { installSalesAgent };

