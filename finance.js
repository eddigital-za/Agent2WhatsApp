const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '20mb' }));

const TZ = 'Africa/Johannesburg';
const TARGET = Number(process.env.MONTHLY_REVENUE_TARGET || 96000);
const SESSION_DIR = '/app/.wwebjs_auth';

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR, clientId: 'btsa-finance' }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

let latestQr = null;

function fmtMoney(v) {
  return `R${Math.round(Number(v || 0)).toLocaleString('en-ZA')}`;
}

function localDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const out = {};
  for (const p of parts) if (p.type !== 'literal') out[p.type] = p.value;
  return { year: Number(out.year), month: Number(out.month), day: Number(out.day) };
}

function localDateKey(date = new Date()) {
  const p = localDateParts(date);
  return `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`;
}

function parseTxnDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function startOfLocalDay(date = new Date()) {
  const p = localDateParts(date);
  return new Date(`${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}T00:00:00+02:00`);
}

function mondayStart(date = new Date()) {
  const d = startOfLocalDay(date);
  const weekday = Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).formatToParts(d).find(x => x.type === 'weekday')?.value === 'Sun' ? 0 : d.getDay());
  const localDay = Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d) === 'Sun' ? 0 : d.getDay());
  const diff = localDay === 0 ? 6 : localDay - 1;
  d.setDate(d.getDate() - diff);
  return d;
}

function daysBetweenLocal(from, to) {
  const a = startOfLocalDay(from).getTime();
  const b = startOfLocalDay(to).getTime();
  return Math.max(0, Math.floor((b - a) / 86400000));
}

function summarizeInvoices(invoices, now = new Date()) {
  const clean = invoices
    .map(x => ({
      id: x.Id || x.id,
      txnDate: parseTxnDate(x.TxnDate || x.txnDate),
      total: Number(x.TotalAmt ?? x.total ?? 0),
      balance: Number(x.Balance ?? x.balance ?? 0),
      privateNote: String(x.PrivateNote || x.privateNote || ''),
    }))
    .filter(x => x.txnDate && x.total >= 0 && !/voided/i.test(x.privateNote));

  const weekStart = mondayStart(now);
  const prevWeekStart = new Date(weekStart); prevWeekStart.setDate(prevWeekStart.getDate() - 7);
  const prevWeekEnd = new Date(weekStart);
  const p = localDateParts(now);
  const monthStart = new Date(`${p.year}-${String(p.month).padStart(2,'0')}-01T00:00:00+02:00`);

  const thisWeek = clean.filter(x => x.txnDate >= weekStart && x.txnDate <= now);
  const prevWeek = clean.filter(x => x.txnDate >= prevWeekStart && x.txnDate < prevWeekEnd);
  const mtd = clean.filter(x => x.txnDate >= monthStart && x.txnDate <= now);

  const sum = arr => arr.reduce((a,b) => a + b.total, 0);
  const thisWeekRevenue = sum(thisWeek);
  const prevWeekRevenue = sum(prevWeek);
  const mtdRevenue = sum(mtd);
  const thisWeekAvg = thisWeek.length ? thisWeekRevenue / thisWeek.length : 0;
  const prevWeekAvg = prevWeek.length ? prevWeekRevenue / prevWeek.length : 0;

  const outstanding = clean.filter(x => x.balance > 0);
  const buckets = {
    current: { count: 0, value: 0 },
    d2to7: { count: 0, value: 0 },
    d7to10: { count: 0, value: 0 },
    d10plus: { count: 0, value: 0 },
  };
  for (const x of outstanding) {
    const age = daysBetweenLocal(x.txnDate, now);
    const b = age <= 1 ? buckets.current : age <= 7 ? buckets.d2to7 : age <= 10 ? buckets.d7to10 : buckets.d10plus;
    b.count += 1;
    b.value += x.balance;
  }

  const totalOutstanding = outstanding.reduce((a,b) => a + b.balance, 0);
  const daysInMonth = new Date(p.year, p.month, 0).getDate();
  const requiredPace = TARGET * (p.day / daysInMonth);
  const targetPct = TARGET ? (mtdRevenue / TARGET) * 100 : 0;
  const weeklyChangePct = prevWeekRevenue ? ((thisWeekRevenue - prevWeekRevenue) / prevWeekRevenue) * 100 : null;
  const avgChangePct = prevWeekAvg ? ((thisWeekAvg - prevWeekAvg) / prevWeekAvg) * 100 : null;
  const mtdOutstanding = mtd.reduce((a,b) => a + Math.min(b.balance, b.total), 0);
  const unpaidPct = mtdRevenue ? (mtdOutstanding / mtdRevenue) * 100 : 0;

  const warnings = [];
  if (mtdRevenue < requiredPace) {
    const behind = requiredPace ? ((requiredPace - mtdRevenue) / requiredPace) * 100 : 0;
    warnings.push(`MTD revenue is ${behind.toFixed(0)}% behind required pace for the ${fmtMoney(TARGET)} target.`);
  }
  if (weeklyChangePct !== null && weeklyChangePct <= -10) {
    warnings.push(`Weekly sales dropped ${Math.abs(weeklyChangePct).toFixed(0)}% versus last week.`);
  }
  if (avgChangePct !== null && avgChangePct <= -10) {
    warnings.push(`Average invoice value fell from ${fmtMoney(prevWeekAvg)} to ${fmtMoney(thisWeekAvg)}.`);
  }
  if (mtdRevenue > 0 && mtdRevenue >= requiredPace && unpaidPct >= 20) {
    warnings.push(`Revenue is ahead of target pace, but ${unpaidPct.toFixed(0)}% of MTD invoiced revenue remains unpaid.`);
  }

  let summary;
  if (!warnings.length) summary = `Revenue is tracking without a material warning this week. Debtors remain the main item to watch if the older buckets grow.`;
  else if (warnings.some(w => w.startsWith('MTD revenue')) && warnings.some(w => w.startsWith('Weekly sales'))) summary = `Revenue is behind target pace and weekly sales have weakened versus last week. The immediate focus is sales volume while keeping overdue invoices from moving into the 10+ day bucket.`;
  else if (warnings.some(w => w.startsWith('MTD revenue'))) summary = `Revenue is behind the pace required to reach the monthly target. Weekly invoice value and debtor ageing should be watched closely to see whether the gap is widening or recovering.`;
  else summary = `Revenue is broadly on pace, but the warning flags above need attention. Priority should go to the largest movement rather than treating normal week-to-week noise as a problem.`;

  return {
    thisWeekRevenue, prevWeekRevenue, weeklyChangePct,
    mtdRevenue, targetPct, thisWeekCount: thisWeek.length,
    thisWeekAvg, prevWeekAvg, buckets, totalOutstanding, warnings, summary
  };
}

function renderReport(s) {
  const change = s.weeklyChangePct === null ? 'n/a' : `${s.weeklyChangePct >= 0 ? '+' : ''}${s.weeklyChangePct.toFixed(0)}%`;
  const lines = [
    '*BTSA Weekly Revenue Report*',
    '',
    '*Revenue Position*',
    `This week: ${fmtMoney(s.thisWeekRevenue)}`,
    `Month-to-date: ${fmtMoney(s.mtdRevenue)}`,
    `Monthly target: ${fmtMoney(TARGET)}`,
    `Target achieved: ${s.targetPct.toFixed(0)}%`,
    '',
    '*Revenue Trend*',
    `This week: ${fmtMoney(s.thisWeekRevenue)}`,
    `Previous week: ${fmtMoney(s.prevWeekRevenue)}`,
    `Change: ${change}`,
    `Invoices this week: ${s.thisWeekCount}`,
    `Average invoice value: ${fmtMoney(s.thisWeekAvg)}`,
    '',
    '*Outstanding Invoices / Debtors*',
    `Current / new: ${s.buckets.current.count} | ${fmtMoney(s.buckets.current.value)}`,
    `2–7 days: ${s.buckets.d2to7.count} | ${fmtMoney(s.buckets.d2to7.value)}`,
    `7–10 days: ${s.buckets.d7to10.count} | ${fmtMoney(s.buckets.d7to10.value)}`,
    `10+ days: ${s.buckets.d10plus.count} | ${fmtMoney(s.buckets.d10plus.value)}`,
    `Total outstanding: ${fmtMoney(s.totalOutstanding)}`,
  ];
  if (s.warnings.length) {
    lines.push('', '*Warnings*');
    s.warnings.forEach(w => lines.push(`• ${w}`));
  }
  lines.push('', '*Management Summary*', s.summary);
  return lines.join('\n');
}

app.get('/health', (req, res) => res.json({ ok: true, whatsappReady: Boolean(client.info), target: TARGET }));

app.get('/qr', (req, res) => {
  if (!latestQr) return res.send("<html><body style='font-family:Arial;text-align:center;padding:40px'><h2>Waiting for WhatsApp QR...</h2><p>If already linked, the Finance session may simply be starting.</p></body></html>");
  res.send(`<!DOCTYPE html><html><head><title>BTSA Finance WhatsApp</title><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script></head><body style="font-family:Arial;text-align:center;padding:40px"><h2>Link BTSA Finance Agent</h2><p>WhatsApp → Linked Devices → Link a Device</p><div id="qrcode"></div><script>new QRCode(document.getElementById('qrcode'),{text:${JSON.stringify(latestQr)},width:320,height:320});</script></body></html>`);
});

app.get('/groups', async (req, res) => {
  try {
    if (!client.info) return res.status(503).json({ error: 'WhatsApp not ready' });
    const chats = await client.getChats();
    const groups = chats.filter(c => c.isGroup).map(c => ({ id: c.id?._serialized, name: c.name }));
    res.json({ groups });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/report', async (req, res) => {
  try {
    const invoices = Array.isArray(req.body) ? req.body : (req.body?.invoices || []);
    if (!Array.isArray(invoices)) return res.status(400).json({ error: 'invoices array required' });
    const summary = summarizeInvoices(invoices, new Date());
    const text = renderReport(summary);
    const chatId = process.env.FINANCE_GROUP_ID;
    if (chatId) {
      if (!client.info) return res.status(503).json({ error: 'WhatsApp not ready', report: text });
      const sent = await client.sendMessage(chatId, text);
      return res.json({ success: true, sent: true, chatId, messageId: sent?.id?._serialized || null, report: text, summary });
    }
    res.json({ success: true, sent: false, reason: 'FINANCE_GROUP_ID not set', report: text, summary });
  } catch (e) {
    console.error('Report error:', e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

client.on('qr', qr => { latestQr = qr; console.log('New WhatsApp QR generated. Open /qr to scan it.'); });
client.on('authenticated', () => { latestQr = null; console.log('Finance WhatsApp authenticated.'); });
client.on('ready', () => console.log('BTSA Finance WhatsApp is ready.'));
client.on('auth_failure', m => console.error('Finance WhatsApp auth failure:', m));
client.on('disconnected', r => console.log('Finance WhatsApp disconnected:', r));
client.on('message', async message => {
  try {
    if (message.fromMe) return;
    if (message.from?.endsWith('@g.us')) {
      const chat = await message.getChat().catch(() => null);
      console.log('FINANCE GROUP DETECTED:', message.from, chat?.name || 'unknown');
    }
  } catch (e) { console.error('Inbound finance group log error:', e.message || e); }
});

function removeChromiumLocks(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) removeChromiumLocks(full);
    else if (['SingletonLock','SingletonSocket','SingletonCookie'].includes(entry.name)) {
      try { fs.unlinkSync(full); } catch (_) {}
    }
  }
}

removeChromiumLocks(SESSION_DIR);
client.initialize();

const PORT = Number(process.env.PORT || 4000);
app.listen(PORT, () => console.log(`BTSA Finance WhatsApp listening on ${PORT}`));
