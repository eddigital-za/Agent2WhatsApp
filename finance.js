const express = require('express');

const app = express();
app.use(express.json({ limit: '20mb' }));

const TZ = 'Africa/Johannesburg';
const WEEKLY_TARGET = Number(process.env.WEEKLY_REVENUE_TARGET || process.env.MONTHLY_REVENUE_TARGET || 96154);
const ANNUAL_TARGET = Number(process.env.ANNUAL_REVENUE_TARGET || 5000000);
const WHATSAPP_SEND_URL = process.env.WHATSAPP_SEND_URL || 'https://agent2whatsapp-production.up.railway.app/send';

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
  const p = localDateParts(date);
  const ymd = `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`;
  // Determine weekday at local midday so UTC conversion cannot roll the date back.
  const localMidday = new Date(`${ymd}T12:00:00+02:00`);
  const day = localMidday.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  const d = new Date(`${ymd}T00:00:00+02:00`);
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}

function daysBetweenLocal(from, to) {
  return Math.max(0, Math.floor((startOfLocalDay(to) - startOfLocalDay(from)) / 86400000));
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

  // Monday report always covers the last fully completed Monday-Sunday week in SAST.
  const currentWeekStart = mondayStart(now);
  const reportWeekStart = new Date(currentWeekStart);
  reportWeekStart.setUTCDate(reportWeekStart.getUTCDate() - 7);
  const reportWeekEnd = new Date(currentWeekStart); // exclusive
  const comparisonWeekStart = new Date(reportWeekStart);
  comparisonWeekStart.setUTCDate(comparisonWeekStart.getUTCDate() - 7);

  const reportWeek = clean.filter(x => x.txnDate >= reportWeekStart && x.txnDate < reportWeekEnd);
  const comparisonWeek = clean.filter(x => x.txnDate >= comparisonWeekStart && x.txnDate < reportWeekStart);

  const reportEndSnapshot = new Date(reportWeekEnd.getTime() - 1);
  const p = localDateParts(reportEndSnapshot);
  const monthStart = new Date(`${p.year}-${String(p.month).padStart(2,'0')}-01T00:00:00+02:00`);
  const mtd = clean.filter(x => x.txnDate >= monthStart && x.txnDate < reportWeekEnd);

  const sum = arr => arr.reduce((a, b) => a + b.total, 0);
  const lastWeekRevenue = sum(reportWeek);
  const weekBeforeRevenue = sum(comparisonWeek);
  const mtdRevenue = sum(mtd);
  const lastWeekAvg = reportWeek.length ? lastWeekRevenue / reportWeek.length : 0;
  const weekBeforeAvg = comparisonWeek.length ? weekBeforeRevenue / comparisonWeek.length : 0;

  const outstanding = clean.filter(x => x.balance > 0 && x.txnDate < reportWeekEnd);
  const buckets = {
    current: { count: 0, value: 0 },
    d2to7: { count: 0, value: 0 },
    d7to10: { count: 0, value: 0 },
    d10plus: { count: 0, value: 0 },
  };

  for (const x of outstanding) {
    const age = daysBetweenLocal(x.txnDate, reportEndSnapshot);
    const bucket = age <= 1 ? buckets.current : age <= 7 ? buckets.d2to7 : age <= 10 ? buckets.d7to10 : buckets.d10plus;
    bucket.count += 1;
    bucket.value += x.balance;
  }

  const totalOutstanding = outstanding.reduce((a, b) => a + b.balance, 0);
  const targetPct = WEEKLY_TARGET ? (lastWeekRevenue / WEEKLY_TARGET) * 100 : 0;
  const weeklyChangePct = weekBeforeRevenue ? ((lastWeekRevenue - weekBeforeRevenue) / weekBeforeRevenue) * 100 : null;
  const avgChangePct = weekBeforeAvg ? ((lastWeekAvg - weekBeforeAvg) / weekBeforeAvg) * 100 : null;
  const mtdOutstanding = mtd.reduce((a, b) => a + Math.min(b.balance, b.total), 0);
  const unpaidPct = mtdRevenue ? (mtdOutstanding / mtdRevenue) * 100 : 0;

  const warnings = [];
  if (lastWeekRevenue < WEEKLY_TARGET) {
    const behind = ((WEEKLY_TARGET - lastWeekRevenue) / WEEKLY_TARGET) * 100;
    warnings.push(`Last week finished ${behind.toFixed(0)}% behind the ${fmtMoney(WEEKLY_TARGET)} weekly target.`);
  }
  if (weeklyChangePct !== null && weeklyChangePct <= -10) {
    warnings.push(`Weekly sales dropped ${Math.abs(weeklyChangePct).toFixed(0)}% versus the week before.`);
  }
  if (avgChangePct !== null && avgChangePct <= -10) {
    warnings.push(`Average invoice value fell from ${fmtMoney(weekBeforeAvg)} to ${fmtMoney(lastWeekAvg)}.`);
  }
  if (mtdRevenue > 0 && unpaidPct >= 20) {
    warnings.push(`${unpaidPct.toFixed(0)}% of MTD invoiced revenue remains unpaid.`);
  }

  let managementSummary;
  if (lastWeekRevenue < WEEKLY_TARGET && weeklyChangePct !== null && weeklyChangePct < 0) {
    managementSummary = `Last week finished below the pace required for the ${fmtMoney(ANNUAL_TARGET)} annual goal and was down on the week before. The immediate focus is closing the weekly revenue gap while preventing older debtors from growing.`;
  } else if (lastWeekRevenue < WEEKLY_TARGET) {
    managementSummary = `Last week finished below the ${fmtMoney(WEEKLY_TARGET)} weekly target required to support the ${fmtMoney(ANNUAL_TARGET)} annual goal. Debtor ageing should be watched alongside the sales gap.`;
  } else {
    managementSummary = `Last week met or exceeded the weekly revenue target. The main finance risk to watch is movement in overdue debtors and average invoice value.`;
  }

  return {
    lastWeekRevenue,
    weekBeforeRevenue,
    weeklyChangePct,
    mtdRevenue,
    targetPct,
    lastWeekCount: reportWeek.length,
    lastWeekAvg,
    weekBeforeAvg,
    buckets,
    totalOutstanding,
    warnings,
    managementSummary,
    reportWeekStart: reportWeekStart.toISOString(),
    reportWeekEndExclusive: reportWeekEnd.toISOString(),
  };
}

function renderReport(s) {
  const change = s.weeklyChangePct === null ? 'n/a' : `${s.weeklyChangePct >= 0 ? '+' : ''}${s.weeklyChangePct.toFixed(0)}%`;
  const lines = [
    '*BTSA Weekly Revenue Report*',
    '',
    '*Revenue Position*',
    `Last week: ${fmtMoney(s.lastWeekRevenue)}`,
    `Month-to-date: ${fmtMoney(s.mtdRevenue)}`,
    `Weekly target: ${fmtMoney(WEEKLY_TARGET)}`,
    `Weekly target achieved: ${s.targetPct.toFixed(0)}%`,
    `Annual revenue goal: ${fmtMoney(ANNUAL_TARGET)}`,
    '',
    '*Revenue Trend*',
    `Last week: ${fmtMoney(s.lastWeekRevenue)}`,
    `Week before: ${fmtMoney(s.weekBeforeRevenue)}`,
    `Change: ${change}`,
    `Invoices last week: ${s.lastWeekCount}`,
    `Average invoice value: ${fmtMoney(s.lastWeekAvg)}`,
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

  lines.push('', '*Management Summary*', s.managementSummary);
  return lines.join('\n');
}

app.get('/health', (req, res) => res.json({
  ok: true,
  transport: 'Agent2WhatsApp',
  weeklyTarget: WEEKLY_TARGET,
  annualTarget: ANNUAL_TARGET,
  reportPeriod: 'previous-completed-week',
}));

app.post('/report', async (req, res) => {
  try {
    const invoices = Array.isArray(req.body) ? req.body : (req.body?.invoices || []);
    if (!Array.isArray(invoices)) return res.status(400).json({ error: 'invoices array required' });
    const summary = summarizeInvoices(invoices, new Date());
    const text = renderReport(summary);
    const chatId = process.env.FINANCE_GROUP_ID;
    if (!chatId) return res.status(500).json({ success: false, error: 'FINANCE_GROUP_ID not set', report: text, summary });

    const sendResponse = await fetch(WHATSAPP_SEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId, text }),
    });
    const sendBody = await sendResponse.text();
    let sendResult = null;
    try { sendResult = JSON.parse(sendBody); } catch (_) { sendResult = { raw: sendBody }; }
    if (!sendResponse.ok) {
      console.error('Shared WhatsApp send failed:', sendResponse.status, sendResult);
      return res.status(502).json({ success: false, sent: false, error: 'Shared WhatsApp send failed', upstreamStatus: sendResponse.status, upstream: sendResult, report: text, summary });
    }
    return res.json({ success: true, sent: true, chatId, transport: 'Agent2WhatsApp', upstream: sendResult, report: text, summary });
  } catch (e) {
    console.error('Report error:', e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

const PORT = Number(process.env.PORT || 4000);
app.listen(PORT, () => console.log(`BTSA Finance report service listening on ${PORT}`));
