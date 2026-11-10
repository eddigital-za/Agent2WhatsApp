"use strict";

function serialized(value) {
  return value?._serialized || value || "";
}

async function resolveWhatsAppRecipient(client, phone, normalizePhone) {
  const number = normalizePhone(phone);
  if (!number) throw new Error("Valid phone required");
  const phoneId = `${number}@c.us`;

  if (typeof client.getContactLidAndPhone === "function") {
    const mappings = await client.getContactLidAndPhone([phoneId]);
    const mapping = Array.isArray(mappings) ? mappings[0] : mappings?.[phoneId] || mappings;
    const lid = serialized(mapping?.lid);
    if (lid.endsWith("@lid")) return lid;
  }

  if (typeof client.getNumberId === "function") {
    const registered = await client.getNumberId(number);
    const registeredId = serialized(registered);
    if (!registeredId) throw new Error("Phone is not registered on WhatsApp");
    if (registeredId.endsWith("@lid")) return registeredId;
    throw new Error("WhatsApp LID is unavailable for this recipient");
  }

  return phoneId;
}

async function findExactOutboundReceipts(client, chatId, text, sinceMs) {
  if (!client.pupPage?.evaluate) return [];
  return client.pupPage.evaluate(async ({ chatId, text, since }) => {
    const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
    return (chat?.msgs?.getModelsArray() || [])
      .filter(message => message.id?.fromMe === true && message.type === "chat" && message.body === text && message.t >= since)
      .map(message => message.id._serialized || message.id.$1 || message.id.id)
      .filter(Boolean);
  }, { chatId, text, since: Math.floor(sinceMs / 1000) });
}

module.exports = { resolveWhatsAppRecipient, findExactOutboundReceipts };
