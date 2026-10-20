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
  `);

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
    if (!ready() || message.fromMe || !lead) return false;
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

  return { onCustomer, onApproval, ready };
}

module.exports = { installSalesAgent };

