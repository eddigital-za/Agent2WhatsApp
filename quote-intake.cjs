// Call routeQuoteRequest before the existing direct-message agent dispatch.
async function routeQuoteRequest(message, env = process.env, request = fetch, isOperator) {
  if (!env.QUOTE_INTAKE_URL || !env.QUOTE_INTAKE_TOKEN || !/^27\d{9}$/.test(env.QUOTE_OPERATOR_PHONE) ||
      message.fromMe || !/^\d+@(lid|c\.us)$/.test(message.from)) return false;
  const body = String(message.body || '');
  const command = /^\/?quote(?:\s|:|$)/i.test(body.trim());
  const enquiry = /\b(?:collect(?:ing|ion)?|pick(?:ing)?\s+up)\b[\s\S]*\b(?:deliver(?:ing|y)?|drop(?:ping)?\s+off)\b/i.test(body);
  const pastedEnquiry = /\b(how much|transport|delivery|collect|pickup|bike|motorcycle|cost)\b/i.test(body) && /\bfrom\s+[^\n]+?\s+to\s+\S/i.test(body);
  const likelyQuote = command || enquiry || pastedEnquiry ||
    (message.isForwarded && /\bfrom\b.+\bto\b|→/is.test(body));
  const audio = message.hasMedia && ['audio', 'ptt'].includes(message.type);
  if (!likelyQuote && (env.QUOTE_LANGUAGE_INTAKE !== 'true' || !(body.trim() || audio))) return false;
  const phoneId = env.QUOTE_OPERATOR_PHONE + "@c.us";
  try {
    if (message.from !== phoneId && !(await isOperator(message.from, phoneId))) return false;
  } catch {
    return false;
  }
  const forward = async () => {
    const key = message.id;
    const id = key?._serialized || key?.$1 || (key?.id ? `${message.from}:${key.id}` : null);
    if (!id) {
      console.warn('Quote request ignored: message ID unavailable');
      return false;
    }
    console.info('Verified WhatsApp quote request received');
    const quoted = message.hasQuotedMsg && !body.replace(/^\s*\/?quote\s*:?\s*/i, '')
      ? await message.getQuotedMessage() : null;
    const content = quoted || message;
    const event = {
      id, text: String(content.body || ''),
      allowIgnore: !command && env.QUOTE_LANGUAGE_INTAKE === 'true',
      useFallback: Boolean(likelyQuote)
    };
    if (content.hasMedia && ['audio', 'ptt'].includes(content.type)) {
      const media = await content.downloadMedia();
      if (media?.data && media.data.length <= 4 * 1024 * 1024) {
        event.audio = { data: media.data, mime: media.mimetype };
      }
    }
    const response = await request(new URL('/intake/whatsapp', env.QUOTE_INTAKE_URL), {
      method: 'POST',
      signal: AbortSignal.timeout(likelyQuote ? 180000 : 30000),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.QUOTE_INTAKE_TOKEN },
      body: JSON.stringify(event)
    });
    if (!response.ok) {
      console.warn('Private quote intake returned status', response.status);
      return false;
    }
    const status = await response.json();
    if (status.ignored) return false;
    console.info('WhatsApp quote request processed');
    return true;
  };
  const dispatch = forward().catch(() => {
    console.warn('Private quote intake unavailable');
    return false;
  });
  if (command || env.QUOTE_LANGUAGE_INTAKE !== 'true') {
    void dispatch;
    return true;
  }
  return dispatch;
}

module.exports = { routeQuoteRequest };
