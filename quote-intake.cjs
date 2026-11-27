// Call routeQuoteRequest before the existing direct-message agent dispatch.
function routeQuoteRequest(message, env = process.env, request = fetch) {
  if (!env.QUOTE_INTAKE_URL || !env.QUOTE_INTAKE_TOKEN || !env.QUOTE_OPERATOR_ID ||
      message.fromMe || !/^(\d+)@(lid|c\.us)$/.test(env.QUOTE_OPERATOR_ID)) return false;
  const direct = message.from === env.QUOTE_OPERATOR_ID;
  const privateGroup = env.QUOTE_GROUP_ID && message.from === env.QUOTE_GROUP_ID;
  if (!direct && !(privateGroup && message.author === env.QUOTE_OPERATOR_ID)) return false;
  const body = String(message.body || '');
  const command = /^\/?quote(?:\b|:)/i.test(body.trim());
  if (!command && !privateGroup) return false;
  const id = message.id?._serialized;
  if (!id) return true;
  void (async () => {
    const quoted = command && message.hasQuotedMsg && !body.replace(/^\s*\/?quote\s*:?\s*/i, '')
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
