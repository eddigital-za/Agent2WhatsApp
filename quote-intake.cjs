// Call routeQuoteRequest before the existing direct-message agent dispatch.
function routeQuoteRequest(message, env = process.env, request = fetch, resolveRecipient) {
  if (!env.QUOTE_INTAKE_URL || !env.QUOTE_INTAKE_TOKEN || !/^27\d{9}$/.test(env.QUOTE_OPERATOR_PHONE) ||
      message.fromMe || !/^\d+@(lid|c\.us)$/.test(message.from)) return false;
  const body = String(message.body || '');
  const command = /^\/?quote(?:\s|:|$)/i.test(body.trim());
  const enquiry = /\b(?:collect(?:ing|ion)?|pick(?:ing)?\s+up)\b[\s\S]*\b(?:deliver(?:ing|y)?|drop(?:ping)?\s+off)\b/i.test(body);
  if (!command && !enquiry) return false;
  const id = message.id?._serialized;
  if (!id) return true;
  void (async () => {
    const phoneId = env.QUOTE_OPERATOR_PHONE + "@c.us";
    if (message.from !== phoneId) {
      if (!message.from.endsWith("@lid") || message.from !== await resolveRecipient(phoneId)) return;
    }
    const quoted = message.hasQuotedMsg && !body.replace(/^\s*\/?quote\s*:?\s*/i, '')
      ? await message.getQuotedMessage() : null;
    const content = quoted || message;
    const event = { id, text: String(content.body || '') };
    if (content.hasMedia && ['audio', 'ptt'].includes(content.type)) {
      const media = await content.downloadMedia();
      if (media?.data && media.data.length <= 4 * 1024 * 1024) {
        event.audio = { data: media.data, mime: media.mimetype };
      }
    }
    const response = await request(new URL('/intake/whatsapp', env.QUOTE_INTAKE_URL), {
      method: 'POST',
      signal: AbortSignal.timeout(180000),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.QUOTE_INTAKE_TOKEN },
      body: JSON.stringify(event)
    });
    if (!response.ok) console.warn('Private quote intake returned status', response.status);
  })().catch(() => console.warn('Private quote intake unavailable'));
  return true;
}

module.exports = { routeQuoteRequest };
