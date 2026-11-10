"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SalesExampleRetriever } = require("./sales-example-retriever");

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "btsa-sales-examples-"));
  const file = path.join(directory, "examples.jsonl");
  fs.writeFileSync(file, [
    { conversation_id: "PRICE-1", customer: "Your quote is expensive and I am shopping around", sales_response: "No stress. Let me check whether your timing gives me a better routing option." },
    { conversation_id: "BOOK-1", customer: "I am happy. How do I go ahead and book?", sales_response: "Awesome, thank you. Complete the booking form and I will take it from there." },
    { conversation_id: "TRUST-1", customer: "Is my bike insured during transport?", sales_response: "Yes, the bike is covered in transit using the current approved policy terms." },
  ].map(item => JSON.stringify(item)).join("\n"));
  return { directory, file };
}

test("retrieves relevant historical sales conversations without duplicate sources", () => {
  const { directory, file } = fixture();
  try {
    const retriever = new SalesExampleRetriever(file);
    const results = retriever.retrieve("Your quote is too expensive. I am shopping around for a cheaper transport rate.", 3);
    assert.ok(results.length > 0);
    assert.equal(new Set(results.map(item => item.sourceConversationId)).size, results.length);
    assert.equal(results[0].sourceConversationId, "PRICE-1");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("returns no examples for an empty conversational turn", () => {
  const { directory, file } = fixture();
  try {
    const retriever = new SalesExampleRetriever(file);
    assert.deepEqual(retriever.retrieve("", 3), []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("atomically replaces the private example library and rejects undersized imports", () => {
  const { directory, file } = fixture();
  try {
    const retriever = new SalesExampleRetriever(file);
    const replacement = Array.from({ length: 100 }, (_, index) => JSON.stringify({
      conversation_id: `CONV-${index}`,
      customer: `Customer asks about transport option ${index}`,
      sales_response: `Duane response ${index}`,
    })).join("\n");
    assert.equal(retriever.replace(replacement), 100);
    assert.equal(retriever.examples.length, 100);
    assert.equal(fs.readFileSync(file, "utf8"), replacement);
    assert.throws(() => retriever.replace(JSON.stringify({
      conversation_id: "TOO-SMALL", customer: "One example", sales_response: "One response",
    })), /at least 100/);
    assert.equal(retriever.examples.length, 100);
    assert.equal(fs.readFileSync(file, "utf8"), replacement);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
