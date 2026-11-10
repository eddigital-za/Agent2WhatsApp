"use strict";

const fs = require("node:fs");
const path = require("node:path");

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "could",
  "do", "for", "from", "had", "has", "have", "he", "her", "him", "his", "how", "i",
  "if", "in", "is", "it", "me", "my", "of", "on", "or", "our", "please", "she", "so",
  "that", "the", "their", "them", "then", "there", "they", "this", "to", "us", "was",
  "we", "were", "what", "when", "where", "which", "who", "will", "with", "would", "you", "your"
]);

const INTENTS = {
  price: /\b(price|rate|quote|quoted|cost|expensive|cheap|cheaper|discount|budget|afford|shopping around)\b/i,
  timing: /\b(when|date|day|week|month|soon|urgent|asap|collect|collection|deliver|delivery|available|availability)\b/i,
  booking: /\b(book|booking|proceed|go ahead|move forward|form|sla|payment|pay|invoice|secure|slot)\b/i,
  trust: /\b(insured|insurance|cover|safe|damage|review|reliable|trust|strap|trailer|truck)\b/i,
  decline: /\b(sorted|came right|not interested|no longer|another company|someone else|leave it|thanks anyway)\b/i,
};

function clean(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\[[A-Z_]+(?::[^\]]+)?\]/g, " ")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(value) {
  return clean(value).split(/\s+/).filter(token => token.length > 1 && !STOP_WORDS.has(token));
}

function intents(value) {
  return Object.entries(INTENTS).filter(([, pattern]) => pattern.test(String(value || ""))).map(([name]) => name);
}

class SalesExampleRetriever {
  constructor(filePath) {
    this.filePath = filePath;
    this.examples = [];
    this.documentFrequency = new Map();
    if (!filePath || !fs.existsSync(filePath)) return;
    this.load(fs.readFileSync(filePath, "utf8"));
  }

  load(jsonl) {
    const examples = [];
    const documentFrequency = new Map();
    for (const line of String(jsonl || "").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const item = JSON.parse(line);
      const customerTokens = tokens(item.customer);
      if (!customerTokens.length || !item.sales_response) continue;
      const tokenSet = new Set(customerTokens);
      for (const token of tokenSet) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
      examples.push({
        conversationId: String(item.conversation_id || ""),
        customer: String(item.customer || "").trim(),
        salesResponse: String(item.sales_response || "").trim(),
        tokens: customerTokens,
        tokenSet,
        intents: intents(item.customer),
      });
    }
    this.examples = examples;
    this.documentFrequency = documentFrequency;
    return this.examples.length;
  }

  replace(jsonl) {
    const previousExamples = this.examples;
    const previousFrequency = this.documentFrequency;
    const tempPath = `${this.filePath || ""}.tmp`;
    try {
      const count = this.load(jsonl);
      if (count < 100) throw new Error("Historical sales library must contain at least 100 usable examples");
      if (!this.filePath) throw new Error("Historical sales library path is not configured");
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(tempPath, String(jsonl), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tempPath, this.filePath);
      return count;
    } catch (error) {
      this.examples = previousExamples;
      this.documentFrequency = previousFrequency;
      if (tempPath && fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
      throw error;
    }
  }

  retrieve(query, limit = 3) {
    const queryTokens = [...new Set(tokens(query))];
    if (!queryTokens.length || !this.examples.length) return [];
    const queryIntents = new Set(intents(query));
    const total = this.examples.length;

    const ranked = this.examples.map(example => {
      let score = 0;
      for (const token of queryTokens) {
        if (!example.tokenSet.has(token)) continue;
        const df = this.documentFrequency.get(token) || 1;
        score += Math.log(1 + total / df);
      }
      const sharedIntent = example.intents.filter(intent => queryIntents.has(intent)).length;
      score += sharedIntent * 4;
      if (clean(example.customer).includes(clean(query)) || clean(query).includes(clean(example.customer))) score += 6;
      score /= 1 + Math.max(0, example.tokens.length - 35) / 80;
      return { example, score };
    }).filter(row => row.score >= 3).sort((a, b) => b.score - a.score);

    const selected = [];
    const conversations = new Set();
    for (const row of ranked) {
      if (conversations.has(row.example.conversationId)) continue;
      conversations.add(row.example.conversationId);
      selected.push({
        sourceConversationId: row.example.conversationId,
        customer: row.example.customer,
        btsaResponse: row.example.salesResponse,
        matchedIntents: row.example.intents,
      });
      if (selected.length >= limit) break;
    }
    return selected;
  }
}

function createDefaultRetriever() {
  const filePath = process.env.SALES_EXAMPLE_PATH
    || path.join(process.env.DATA_DIR || "/app/data", "btsa-sales-history.jsonl");
  return new SalesExampleRetriever(filePath);
}

module.exports = { SalesExampleRetriever, createDefaultRetriever };
