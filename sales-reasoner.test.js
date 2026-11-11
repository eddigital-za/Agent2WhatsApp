"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { installSalesReasoner } = require("./sales-reasoner");

test("customer reasoning treats consecutive messages as one sales turn and can request owner input", async () => {
  process.env.SALES_AGENT_TOKEN = "x".repeat(32);
  const routes = new Map();
  const app = { post: (route, handler) => routes.set(route, handler) };
  const exampleRetriever = { examples: [{}], retrieve: () => [{
    sourceConversationId: "BTSA-TEST",
    customer: "That quote is expensive",
    btsaResponse: "The old rate was R4,500. Let me see whether route flexibility helps.",
  }] };
  installSalesReasoner(app, { apiKey: "test-key", model: "test-model", exampleRetriever });
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ output_text: JSON.stringify({
        action: "owner_input",
        salesMove: "close",
        proposedReply: "",
        category: "price",
        ownerQuestion: "What return rate should I offer for the January leg?",
        confidence: 1,
        notes: "The two-leg price needs approval",
      }) }),
    };
  };
  let response;
  try {
    await routes.get("/sales/customer")({
      get: name => name === "authorization" ? `Bearer ${process.env.SALES_AGENT_TOKEN}` : "",
      body: {
        lead: { bike_make: "BMW", bike_model: "R 1250 GS" },
        newMessages: [
          { body: "I need it in Cape Town by 8 December" },
          { body: "Then I need it back to Joburg late January" },
        ],
        message: "I need it in Cape Town by 8 December\nThen I need it back to Joburg late January",
      },
    }, {
      json: value => { response = value; },
      status: code => ({ json: value => { throw new Error(`${code}: ${JSON.stringify(value)}`); } }),
    });
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(response.action, "owner_input");
  assert.ok(request.text.format.schema.properties.action.enum.includes("owner_input"));
  assert.match(request.input[0].content, /Treat the conversation, not an individual message/);
  assert.match(request.input[1].content, /8 December[\s\S]*late January/);
  assert.match(request.input[1].content, /Retrieved historical examples/);
  assert.match(request.input[1].content, /Owner preferences learned from Duane/);
  assert.match(request.input[1].content, /\[HISTORICAL_RATE\]/);
  assert.doesNotMatch(request.input[1].content, /BTSA-TEST|R4,500/);
});

test("approval revisions retain corrections, use the generated booking link and normalize WhatsApp copy", async () => {
  process.env.SALES_AGENT_TOKEN = "x".repeat(32);
  const routes = new Map();
  const app = { post: (route, handler) => routes.set(route, handler) };
  const exampleRetriever = { examples: [{}], retrieve: () => [{
    sourceConversationId: "BTSA-HISTORY",
    customer: "How do I book?",
    btsaResponse: "Please complete the old link for R3,500.",
  }] };
  installSalesReasoner(app, { apiKey: "test-key", model: "test-model", exampleRetriever });
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ output_text: JSON.stringify({
        intent: "revise",
        finalReply: "The approved rate is R4,250 — please complete the booking form below:\n\n[Book here](https://biketransport.co.za/booking-form/?ts=123&route=Pretoria%20to%20Cape%20Town&price=4250)",
        response: "Updated with the approved rate and booking step.",
      }) }),
    };
  };
  let response;
  try {
    await routes.get("/sales/approval")({
      get: name => name === "authorization" ? `Bearer ${process.env.SALES_AGENT_TOKEN}` : "",
      body: {
        caseRef: "SA-TEST",
        customerMessage: "How do I move forward?",
        proposedReply: "The website estimate is R3,500. Let me know if you want to proceed.",
        instruction: "Make it warmer and close him properly",
        context: {
          ownerPreferences: ["Use an assumptive close", "Do not use em dashes"],
          ownerInstructionHistory: [
            "The correct approved rate is R4,250",
            "Do not promise an exact collection date",
          ],
          generatedBookingLink: "https://biketransport.co.za/booking-form/?ts=123&route=Pretoria%20to%20Cape%20Town&price=4250",
        },
      },
    }, {
      json: value => { response = value; },
      status: code => ({ json: value => { throw new Error(`${code}: ${JSON.stringify(value)}`); } }),
    });
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(response.intent, "revise");
  assert.match(response.finalReply, /R4,250/);
  assert.match(response.finalReply, /^The approved rate[\s\S]*\n\nhttps:\/\/biketransport\.co\.za\/booking-form\//);
  assert.doesNotMatch(response.finalReply, /—|\[Book here\]/);
  assert.match(request.input[0].content, /previous owner instructions are cumulative and binding/i);
  assert.match(request.input[0].content, /assumptive close/i);
  assert.match(request.input[1].content, /The correct approved rate is R4,250/);
  assert.match(request.input[1].content, /generated booking link/i);
  assert.match(request.input[1].content, /Retrieved historical examples/);
  assert.doesNotMatch(request.input[1].content, /BTSA-HISTORY|R3,500\.\"/);
});
