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
  `);

  const approvalColumns = db.prepare("PRAGMA table_info(sales_approvals)").all().map(row => row.name);
  if (!approvalColumns.includes("followup_id")) db.exec("ALTER TABLE sales_approvals ADD COLUMN followup_id INTEGER");

  const now = () => new Date().toISOString();
  const sessionStarted = Date.now();
  const caseRef = () => `SA-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  const ready = () => Boolean(process.env.SALES_ENABLED === "true" && approvalGroup() && reasonerUrl && token && customerClient?.info && approvalClient?.info);
  function claim(message, kind) {
    const id = message.id?._serialized;
    if (!id || String(id).startsWith("true_")) return false;
    const timestamp = Number(message.timestamp) * 1000;
    if (!Number.isFinite(timestamp) || timestamp < sessionStarted - 5000 || timestamp > Date.now() + 60000) return false;
    return db.prepare("INSERT OR IGNORE INTO sales_inbound_claims(message_id,claimed_at) VALUES(?,?)").run(kind + ":" + id, now()).changes === 1;
  }
  function remember(phone, direction, body, messageId) {
    db.prepare("INSERT OR IGNORE INTO sales_messages(created_at,phone,direction,body,message_id) VALUES(?,?,?,?,?)")
      .run(now(), phone, direction, String(body || ""), messageId || null);
  }
  function history(phone) {
    return db.prepare("SELECT direction,body,created_at FROM sales_messages WHERE phone=? AND created_at>=? ORDER BY id DESC LIMIT 16").all(phone, new Date(Date.now() - 30 * 60000).toISOString()).reverse();
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
  function pendingForApproval(message) {
    const quoted = message?.hasQuotedMsg ? null : null;
    return quoted;
  }
  async function findPending(message) {
    let quotedId = "";
    let quotedText = "";
    if (message.hasQuotedMsg) {
      try { const q = await message.getQuotedMessage(); quotedId = q?.id?._serialized || ""; quotedText = q?.body || ""; } catch (_) {}
    }
    let row = quotedId ? db.prepare("SELECT * FROM sales_approvals WHERE group_message_id=? AND state='pending'").get(quotedId) : null;
    if (!row && quotedText) {
      const m = quotedText.match(/\b(SA-[A-Z0-9-]+)\b/); if (m) row = db.prepare("SELECT * FROM sales_approvals WHERE case_ref=? AND state='pending'").get(m[1]);
    }
    if (!row && !quotedId && !quotedText) {
      const rows = db.prepare("SELECT a.* FROM sales_approvals a WHERE a.state='pending' AND NOT EXISTS (SELECT 1 FROM sales_approvals newer WHERE newer.phone=a.phone AND newer.id>a.id) ORDER BY a.id DESC LIMIT 2").all();
      if (rows.length === 1) row = rows[0];
    }
    return row;
  }

  async function onCustomer(message, lead, phone) {
    if (message.fromMe) return false;
    const cancelled = db.prepare("SELECT id FROM sales_sla_followups WHERE phone=? AND state IN ('pending','processing','approval_sending','approval_unknown','approval_requested')").all(phone);
    if (cancelled.length) {
      db.prepare("UPDATE sales_sla_followups SET state='cancelled_reply',updated_at=? WHERE phone=? AND state IN ('pending','processing','approval_sending','approval_unknown','approval_requested')").run(now(), phone);
      for (const row of cancelled) db.prepare("UPDATE sales_approvals SET state='superseded',decided_at=?,decision_text='Client replied after SLA link' WHERE followup_id=? AND state='pending'").run(now(), row.id);
      logEvent({ leadId: lead?.id || null, phone, type: "sla_followup_cancelled_reply", key: `sla-cancel-${message.id?._serialized || now()}`, details: { count: cancelled.length } });
    }
    if (!ready() || !lead) return false;
    const testPhones = String(process.env.SALES_TEST_PHONES || "").split(",").filter(Boolean).map(normalizePhone);
    if (process.env.SALES_TEST_MODE !== "false" && !testPhones.includes(normalizePhone(phone))) return false;
    if (!claim(message, "customer")) return false;
    const text = String(message.body || "").trim();
    if (!text || message.hasMedia) {
      await group(`I received ${message.hasMedia ? "a media message" : "an empty message"} from ${lead?.name || `…${phone.slice(-4)}`}. I haven't replied. Please handle this one manually.`);
      return;
    }
    remember(phone, "customer", text, message.id?._serialized);
    const recentForm = process.env.SALES_TEST_MODE === "false" && Date.parse(lead.first_touch_sent_at || "") >= Date.now() - 60 * 60000;
    const facts = recentForm ? { ...lead, estimated_price: undefined, website_estimate: lead.estimated_price || "", price_status: "unconfirmed website estimate, not a current quote" } : { id: lead.id, phone, context_status: "fresh enquiry; previous form details are unconfirmed" };
    const out = await reason("/sales/customer", { lead: facts, message: text, history: history(phone) });
    if (!out.proposedReply) throw new Error("Reasoner returned no proposed reply");
    const ref = caseRef();
    db.prepare("UPDATE sales_approvals SET state='superseded' WHERE phone=? AND state='pending'").run(phone);
    const result = db.prepare("INSERT INTO sales_approvals(case_ref,lead_id,phone,customer_text,proposed_reply,created_at) VALUES(?,?,?,?,?,?)")
      .run(ref, lead?.id || null, phone, text, out.proposedReply, now());
    const label = recentForm ? `${lead.name || `Lead …${phone.slice(-4)}`}\nForm context: ${[lead.pickup, lead.dropoff].filter(Boolean).join(" → ")}` : `Lead …${phone.slice(-4)}\nFresh enquiry — previous form details not confirmed`;
    const prompt = `*${ref} — ${label}*\n\n*Client:* ${text}\n\n*My suggested reply:*\n${out.proposedReply}\n\nReply naturally or send a voice note. I will wait for your approval before sending.`;
    const groupId = await group(prompt);
    db.prepare("UPDATE sales_approvals SET group_message_id=? WHERE id=?").run(groupId, Number(result.lastInsertRowid));
    logEvent({ leadId: lead?.id || null, phone, type: "sales_approval_requested", key: `sales-request-${ref}`, details: { ref, category: out.category, confidence: out.confidence } });
  }

  async function onOutgoing(message, phone) {
    if (!message?.fromMe || !/^\d{9,15}$/.test(String(phone || ""))) return false;
    const body = String(message.body || message._data?.body || message._data?.caption || "").trim();
    if (!/https?:\/\/(?:www\.)?biketransport\.co\.za\/(?:timestamp|booking-form)\/?[^\s]*/i.test(body)) return false;
    const messageId = String(message.id?._serialized || "");
    if (!messageId) return false;
    const timestamp = Number(message.timestamp) * 1000;
    const sentAt = Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : now();
    const followupHours = Math.max(1, Number(process.env.SALES_SLA_FOLLOWUP_HOURS || 24));
    const dueAt = new Date(Date.parse(sentAt) + followupHours * 3600000).toISOString();
    const normalized = localPhone(phone);
    if (db.prepare("SELECT 1 FROM sales_sla_followups WHERE source_message_id=?").get(messageId)) return false;
    const older = db.prepare("SELECT id FROM sales_sla_followups WHERE phone=? AND state IN ('pending','processing','approval_sending','approval_unknown','approval_requested')").all(normalized);
    db.prepare("UPDATE sales_sla_followups SET state='superseded',updated_at=? WHERE phone=? AND state IN ('pending','processing','approval_sending','approval_unknown','approval_requested')").run(now(), normalized);
    for (const row of older) db.prepare("UPDATE sales_approvals SET state='superseded',decided_at=?,decision_text='Newer SLA link sent' WHERE followup_id=? AND state='pending'").run(now(), row.id);
    const result = db.prepare("INSERT INTO sales_sla_followups(phone,source_message_id,sla_message,sent_at,due_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run(normalized, messageId, body, sentAt, dueAt, now(), now());
    if (result.changes !== 1) return false;
    remember(normalized, "duane", body, messageId);
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
        try { groupId = await group(card); }
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

  function orderConfirmationText(name) {
    const greeting = name ? `Thanks ${name}, I’ve received your booking form 🙌` : "Thanks, I’ve received your booking form 🙌";
    return `${greeting}\n\nYour invoice, including the banking details, will be generated automatically and sent to you by email. Payment is due upfront or at collection. Payment secures your slot and locks in the quoted rate.\n\nI’ll confirm the collection and delivery arrangements with you here on WhatsApp. If I need anything else, I’ll reach out here. If you have any questions, ask me anytime.\n\nThanks, Duane`;
  }

  function onOrderConfirmed({ slaRef, phone, name }) {
    const ref = String(slaRef || "").trim().toUpperCase();
    const normalized = localPhone(phone);
    if (!/^SLA-\d+$/.test(ref)) throw new Error("Valid SLA reference required");
    if (!/^\d{9}$/.test(normalized)) throw new Error("Valid South African customer phone required");
    const clientName = String(name || "").trim().slice(0, 120);
    const message = orderConfirmationText(clientName);
    const stamp = now();
    const result = db.prepare("INSERT OR IGNORE INTO sales_order_confirmations(sla_ref,phone,client_name,message_text,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run(ref, normalized, clientName, message, stamp, stamp);
    if (result.changes !== 1) {
      return { accepted: true, deduplicated: true, confirmation: db.prepare("SELECT sla_ref,state,updated_at FROM sales_order_confirmations WHERE sla_ref=?").get(ref) };
    }
    const followups = db.prepare("SELECT id FROM sales_sla_followups WHERE phone=? AND state IN ('pending','processing','approval_sending','approval_unknown','approval_requested')").all(normalized);
    db.prepare("UPDATE sales_sla_followups SET state='cancelled_order',updated_at=? WHERE phone=? AND state IN ('pending','processing','approval_sending','approval_unknown','approval_requested')").run(stamp, normalized);
    for (const row of followups) {
      db.prepare("UPDATE sales_approvals SET state='superseded',decided_at=?,decision_text='SLA submitted successfully' WHERE followup_id=? AND state='pending'").run(stamp, row.id);
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
    const row = await findPending(message);
    if (!row) {
      console.log("Sales approval ignored: no unambiguous active case");
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
    let audio = null;
    if (message.hasMedia) {
      const m = await message.downloadMedia();
      if (m?.data) audio = { data: m.data, mimetype: m.mimetype || "audio/ogg", filename: m.filename || "approval.ogg" };
    }
    const instruction = String(message.body || "").trim();
    const out = await reason("/sales/approval", {
      caseRef: row.case_ref, customerMessage: row.customer_text, proposedReply: row.proposed_reply,
      instruction, audio
    });
    if (out.intent === "send" && out.finalReply) {
      // Atomic send-once lock; uncertain sends stay locked for manual reconciliation.
      const locked = db.prepare("UPDATE sales_approvals SET state='sending',decided_at=? WHERE id=? AND state='pending'").run(now(), row.id);
      if (locked.changes !== 1) return true;
      const sent = await customerClient.sendMessage(`${normalizePhone(row.phone)}@c.us`, out.finalReply);
      remember(row.phone, "agent", out.finalReply, sent?.id?._serialized);
      db.prepare("UPDATE sales_approvals SET state='sent',decided_at=?,decision_text=? WHERE id=?").run(now(), instruction || out.transcript || "voice approval", row.id);
      if (row.followup_id) db.prepare("UPDATE sales_sla_followups SET state='sent',updated_at=? WHERE id=? AND state='approval_requested'").run(now(), row.followup_id);
      await group(`Sent to ${row.case_ref}:\n\n${out.finalReply}`);
      logEvent({ leadId: row.lead_id, phone: row.phone, type: "sales_reply_sent", key: `sales-sent-${row.case_ref}`, details: { ref: row.case_ref } });
    } else if (out.intent === "revise" && out.finalReply) {
      db.prepare("UPDATE sales_approvals SET proposed_reply=?,decision_text=? WHERE id=?").run(out.finalReply, instruction || out.transcript || "voice revision", row.id);
      await group(`Understood. Revised reply for *${row.case_ref}*:\n\n${out.finalReply}\n\nIf that is right, just say “send it”.`);
    } else {
      await group(out.response || `I’m not certain you meant to send anything for ${row.case_ref}. Tell me what you want changed, or say “send it” when ready.`);
    }
    return true;
  }

  return { onCustomer, onOutgoing, onApproval, onOrderConfirmed, processDueFollowups, processOrderConfirmations, ready };
}

module.exports = { installSalesAgent };

