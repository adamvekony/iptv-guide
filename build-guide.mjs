#!/usr/bin/env node
/**
 * Builds a pruned XMLTV guide for the channels listed in channels.json.
 * Runs on GitHub Actions (twice a day and after every change pushed by IPTV Control Room).
 * Zero dependencies — Node 18+ (fetch, zlib).
 *
 *   node build-guide.mjs [outDir]     (default outDir: site)
 *
 * channels.json: { "sources": ["https://…xml.gz", …], "channels": [{ "id": "m1.HD.hu", "name": "m1 HD", "logo": "https://…" }] }
 * Output: <outDir>/guide.xml.gz, guide.xml, status.json, index.html (+ logos/ and the kodi/ add-on repository copied from the repo).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const KEEP_PAST_MS = 6 * 3600_000;
const KEEP_FUTURE_MS = 8 * 24 * 3600_000;

const outDir = path.resolve(process.argv[2] ?? 'site');
const cfg = JSON.parse(fs.readFileSync('channels.json', 'utf8'));
const now = Date.now();

/** lower-case id -> exact id as used in the playlist (tvg-id) */
const wanted = new Map();
const channelMeta = [];
for (const c of cfg.channels ?? []) {
  if (!c.id || wanted.has(c.id.toLowerCase())) continue;
  wanted.set(c.id.toLowerCase(), c.id);
  channelMeta.push(c);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function parseTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-])?(\d{2})?(\d{2})?/.exec((s ?? '').trim());
  if (!m) return null;
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
  if (!m[7]) return utc;
  const off = (+(m[8] ?? 0) * 60 + +(m[9] ?? 0)) * 60000;
  return m[7] === '+' ? utc - off : utc + off;
}

function attr(openTag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`).exec(openTag);
  return m ? m[1] : null;
}

async function download(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'iptv-guide-builder/1.0 (+GitHub Actions)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return (buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString('utf8');
}

const claimed = new Map(); // lc id -> source url
const programmes = [];
const sourceReport = [];

for (const url of cfg.sources ?? []) {
  const t0 = Date.now();
  let text;
  try {
    text = await download(url);
  } catch (e) {
    sourceReport.push({ url, ok: false, error: String(e.message ?? e) });
    console.error(`✗ ${url}: ${e.message ?? e}`);
    continue;
  }
  /** lc id -> programme xml strings from this source */
  const perId = new Map();
  let total = 0;
  for (const m of text.matchAll(/<programme\b([^>]*)>[\s\S]*?<\/programme>/g)) {
    total++;
    const open = m[1];
    const ch = attr(open, 'channel');
    if (!ch) continue;
    const lc = ch.toLowerCase();
    if (!wanted.has(lc) || claimed.has(lc)) continue;
    const start = parseTime(attr(open, 'start'));
    const stop = parseTime(attr(open, 'stop')) ?? (start ? start + 3600_000 : null);
    if (!start || !stop || stop < now - KEEP_PAST_MS || start > now + KEEP_FUTURE_MS) continue;
    let list = perId.get(lc);
    if (!list) perId.set(lc, (list = { xml: [], upcoming: false }));
    // Rewrite the channel attribute to the playlist's exact tvg-id so Kodi always matches.
    list.xml.push(m[0].replace(/(\schannel\s*=\s*")[^"]*(")/, `$1${esc(wanted.get(lc))}$2`));
    if (stop > now) list.upcoming = true;
  }
  let used = 0;
  // A source only "claims" a channel if it actually has upcoming programmes for it.
  for (const [lc, list] of perId) {
    if (!list.upcoming) continue;
    claimed.set(lc, url);
    programmes.push(...list.xml);
    used++;
  }
  sourceReport.push({ url, ok: true, programmesInFeed: total, channelsUsed: used, seconds: (Date.now() - t0) / 1000 });
  console.log(`✓ ${url}: ${total} programmes in feed, ${used} channels taken`);
}

if (!sourceReport.some((s) => s.ok)) {
  console.error('All EPG sources failed — keeping the previously published guide.');
  process.exit(1);
}

const header = channelMeta.map((c) =>
  `  <channel id="${esc(c.id)}">\n    <display-name>${esc(c.name ?? c.id)}</display-name>\n` +
  (c.logo ? `    <icon src="${esc(c.logo)}" />\n` : '') +
  '  </channel>');

const xml =
  '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE tv SYSTEM "xmltv.dtd">\n<tv generator-info-name="IPTV Control Room cloud guide">\n' +
  header.join('\n') + '\n' +
  programmes.map((p) => '  ' + p).join('\n') + '\n</tv>\n';

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'guide.xml'), xml);
fs.writeFileSync(path.join(outDir, 'guide.xml.gz'), zlib.gzipSync(Buffer.from(xml), { level: 9 }));
if (fs.existsSync('logos')) fs.cpSync('logos', path.join(outDir, 'logos'), { recursive: true });
// Kodi add-on repository for the IPTV Control Room skin (the Pi installs and updates the skin from here).
if (fs.existsSync('kodi')) fs.cpSync('kodi', path.join(outDir, 'kodi'), { recursive: true });

const missing = channelMeta.filter((c) => !claimed.has(c.id.toLowerCase())).map((c) => c.id);
const status = {
  builtAt: new Date(now).toISOString(),
  channels: channelMeta.length,
  channelsWithProgrammes: claimed.size,
  programmes: programmes.length,
  missing,
  sources: sourceReport,
};
fs.writeFileSync(path.join(outDir, 'status.json'), JSON.stringify(status, null, 2));
fs.writeFileSync(
  path.join(outDir, 'index.html'),
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TV guide</title>
<body style="font:15px system-ui;background:#0b0f17;color:#cbd5e1;max-width:720px;margin:40px auto;padding:0 16px">
<h1 style="color:#fff">TV guide</h1>
<p>Built ${esc(status.builtAt)} · ${status.channelsWithProgrammes}/${status.channels} channels with programmes · ${status.programmes} programmes</p>
<p>Kodi XMLTV URL: <code style="color:#67e8f9">guide.xml.gz</code> in this folder.</p>
${missing.length ? `<p>No guide data: ${missing.map(esc).join(', ')}</p>` : ''}
</body>`,
);
console.log(`Guide: ${claimed.size}/${channelMeta.length} channels, ${programmes.length} programmes → ${outDir}`);
