'use strict';
/*
  Xwadda Escrow server. No npm packages needed (Node 18+).
  Serves the website (index.html) AND the API, stores everything in one JSON file.
  Run:  node server.js     (see README.txt for settings and deployment)
*/
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const DATA = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
const ADMINS = (process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
const ORIGIN = process.env.ALLOW_ORIGIN || '*';
const TRUST = process.env.TRUST_PROXY == '1';
const BASE = {
  rate: +process.env.RATE || 129, spr: +process.env.SPREAD || 1.5,
  payName: process.env.PAY_NAME || 'Joshua', payPhone: process.env.PAY_PHONE || '0745090132',
  addr: {
    'USDT BEP20': process.env.ADDR_BEP20 || '0xc08aad31945e614cab90012b9da4dfa53a3ddc2c',
    'USDT TRC20': process.env.ADDR_TRC20 || 'TPwAc1xBpMssGYh2ioX7x8QL9PXZStPNLP'
  }
};

/* ---------- storage ---------- */
let db = { users: {}, sessions: {}, deals: [], tx: [], orders: [], tickets: [], reports: [], cfg: {} };
try { Object.assign(db, JSON.parse(fs.readFileSync(DATA, 'utf8'))); } catch (e) { }
let saveT = null;
let pool = null, pgBusy = false, pgDirty = false;
async function pgFlush() {
  if (pgBusy) { pgDirty = true; return; }
  pgBusy = true;
  try { do { pgDirty = false; await pool.query('insert into xw_state(id,data,updated) values(1,$1::jsonb,now()) on conflict (id) do update set data=excluded.data, updated=now()', [JSON.stringify(db)]); } while (pgDirty); }
  catch (e) { console.error('database save failed', e.message); }
  pgBusy = false;
}
async function bootDb() {
  const cs = process.env.DATABASE_URL; if (!cs) return;
  let Pool; try { ({ Pool } = require('pg')); } catch (e) { console.error('DATABASE_URL is set but the "pg" package is not installed. On Render set Build Command to:  npm install'); process.exit(1); }
  pool = new Pool({ connectionString: cs, ssl: /sslmode=/.test(cs) ? undefined : { rejectUnauthorized: false }, max: 3 });
  try {
    await pool.query('create table if not exists xw_state(id int primary key, data jsonb not null, updated timestamptz default now())');
    const r = await pool.query('select data from xw_state where id=1');
    if (r.rows[0]) Object.assign(db, r.rows[0].data); else await pgFlush();
    const t = Date.now(); for (const k in db.sessions) if (db.sessions[k].x < t) delete db.sessions[k];
    console.log('Database connected. Accounts loaded: ' + Object.keys(db.users).length);
  } catch (e) { console.error('Cannot reach the database, not starting (so nothing gets overwritten): ' + e.message); process.exit(1); }
}
function flush() {
  if (pool) { pgFlush(); return; }
  try { fs.mkdirSync(path.dirname(DATA), { recursive: true }); const tmp = DATA + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, DATA); }
  catch (e) { console.error('save failed', e.message); }
}
function save() { if (saveT) return; saveT = setTimeout(() => { saveT = null; flush(); }, 150); }
['SIGINT', 'SIGTERM'].forEach(s => process.on(s, async () => { if (saveT) { clearTimeout(saveT); saveT = null; } flush(); const t0 = Date.now(); while (pool && pgBusy && Date.now() - t0 < 5000) await new Promise(r => setTimeout(r, 50)); process.exit(0); }));
(function purge() { const t = Date.now(); for (const k in db.sessions) if (db.sessions[k].x < t) delete db.sessions[k]; })();

/* ---------- helpers ---------- */
class E extends Error { constructor(s, m) { super(m); this.s = s; } }
const bad = (m, s = 400) => { throw new E(s, m); };
const lc = s => String(s || '').trim().toLowerCase();
const rate = () => +db.cfg.rate || BASE.rate;
const rid = (p, n) => { const c = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', b = crypto.randomBytes(n); let s = ''; for (let i = 0; i < n; i++) s += c[b[i] % c.length]; return p + s; };
const sq = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const money = n => 'KES ' + Math.round(n).toLocaleString('en-US');
const FEES = a => a <= 2000 ? 0 : a <= 5000 ? 300 : a <= 20000 ? 400 : a <= 40000 ? 500 : a <= 70000 ? 600 : a <= 100000 ? 800 : 1000;
const isAcct = d => { const t = String(d.desc || '').toLowerCase(); return /\b(accounts?|acc|profiles?)\b/.test(t) && /(freelanc|upwork|fiverr|toptal|academic|essay|writ|paper|assignment|content|ghostwrit)/.test(t); };
const tot = d => (d.pay == 'Buyer' ? d.amt + d.fee : d.pay == 'Seller' ? d.amt : d.amt + d.fee / 2) + (d.bfee || 0);
const net = d => d.pay == 'Seller' ? d.amt - d.fee : d.pay == 'Split 50-50' ? d.amt - d.fee / 2 : d.amt;
const toUsdt = (k, buy) => k / (buy ? rate() - BASE.spr : rate() + BASE.spr);
const usd = n => n.toFixed(2) + ' USDT';
const isAdmin = u => !!u && ADMINS.includes(u.email);
const bal = e => db.tx.reduce((s, t) => t.e == e ? s + t.a : s, 0);
const pub = u => ({ name: u.name, email: u.email, phone: u.phone || '', w: u.w || {}, numbers: u.numbers || [], admin: isAdmin(u), bal: bal(u.email) });
const cfgFor = () => ({ rate: rate(), spr: BASE.spr, payName: BASE.payName, payPhone: BASE.payPhone, addr: BASE.addr });

/* ---------- passwords, sessions, limits ---------- */
const scr = (s, salt) => crypto.scryptSync(s, Buffer.from(salt, 'hex'), 32).toString('hex');
function mkHash(s) { const salt = crypto.randomBytes(16).toString('hex'); return { s: salt, h: scr(s, salt) }; }
function chk(s, o) { if (!o) return false; const a = Buffer.from(scr(s, o.s), 'hex'), b = Buffer.from(o.h, 'hex'); return a.length == b.length && crypto.timingSafeEqual(a, b); }
const sh = t => crypto.createHash('sha256').update(t).digest('hex');
function newSession(email) { const t = crypto.randomBytes(32).toString('hex'); db.sessions[sh(t)] = { e: email, x: Date.now() + 30 * 864e5 }; save(); return t; }
function authUser(req) {
  const h = req.headers.authorization || '', t = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!t) return null; const s = db.sessions[sh(t)]; if (!s) return null;
  if (s.x < Date.now()) { delete db.sessions[sh(t)]; return null; }
  return db.users[s.e] || null;
}
const hits = new Map();
function lim(k, max, ms) {
  const t = Date.now(); let h = hits.get(k);
  if (!h || h.r < t) { h = { n: 0, r: t + ms }; hits.set(k, h); }
  if (++h.n > max) bad('Too many attempts. Please wait a few minutes and try again.', 429);
}
setInterval(() => { const t = Date.now(); for (const [k, h] of hits) if (h.r < t) hits.delete(k); }, 60000).unref();

const BADPW = ['password', 'passw0rd', 'qwerty', '123456', 'abcdef', 'letmein', 'welcome', 'iloveyou', 'admin', 'xwadda', 'escrow', 'mpesa'];
function pwProblems(p, n, e) {
  p = String(p || ''); const l = p.toLowerCase(), loc = lc(e).split('@')[0], first = lc(n).split(/\s+/)[0], out = [];
  if (p.length < 8) out.push('at least 8 characters'); if (!/[A-Z]/.test(p)) out.push('an uppercase letter');
  if (!/[a-z]/.test(p)) out.push('a lowercase letter'); if (!/[0-9]/.test(p)) out.push('a number'); if (!/[^A-Za-z0-9]/.test(p)) out.push('a symbol');
  if (BADPW.some(w => l.includes(w)) || (loc.length > 2 && l.includes(loc)) || (first.length > 2 && l.includes(first))) out.push('no common words or your name/email');
  if (/(.)\1\1/.test(p)) out.push('no 3 repeated characters in a row');
  return out;
}
const normKey = k => String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const genKey = () => rid('', 16).replace(/(.{4})(?=.)/g, '$1-');
function sess(u) { return { token: newSession(u.email), user: pub(u), cfg: cfgFor() }; }

/* ---------- deals ---------- */
const roleOf = (d, e) => d.buyer == e ? 'buyer' : d.seller == e ? 'seller' : null;
const isBroker = (d, e) => (d.brokers || []).includes(e);
const mine = (d, e) => d.owner == e || d.buyer == e || d.seller == e || isBroker(d, e);
function nameOf(e) {
  if (!e) return 'Awaiting join'; const u = db.users[e]; if (u) return u.name;
  const p = e.split('@')[0].replace(/[._-]+/g, ' ').trim(); return p ? p.replace(/\b\w/g, c => c.toUpperCase()) : 'Awaiting join';
}
function dest(e) {
  const u = db.users[e], w = u && u.w; if (!w || !w.pref) return 'none saved yet';
  const m = s => s ? ' ••••' + String(s).slice(-4) : '';
  return ({ mpesa: 'M-Pesa' + m(w.mp), bin: 'Binance ID' + m(w.bin), byb: 'Bybit ID' + m(w.byb), bg: 'Bitget ID' + m(w.bg), bep: 'USDT BEP20' + m(w.bep), trc: 'USDT TRC20' + m(w.trc), both: 'USDT BEP20 + TRC20' })[w.pref] || 'none saved yet';
}
function push(d, m) { m.id = d.mid = (d.mid || 0) + 1; m.ts = Date.now(); d.msgs.push(m); if (d.msgs.length > 1500) d.msgs.splice(0, 200); d.v++; save(); }
const bot = (d, t, x) => push(d, Object.assign({ w: 'bot', t }, x));
const ACTIVE = ['Pending', 'Verifying', 'Funded', 'Disputed'];

function newDeal(u, b) {
  const desc = String(b.desc || '').trim().slice(0, 200), role = b.role == 'Seller' ? 'Seller' : 'Buyer';
  let amt = Math.round(+b.amount * (b.cur == 'USDT' ? rate() + BASE.spr : 1));
  if (!desc) bad('Add a description of the deal.');
  if (!(amt >= 100)) bad('The amount must be at least KES 100.'); if (amt > 5e6) bad('The amount is above the KES 5,000,000 limit. Contact support for larger deals.');
  const pay = ['Buyer', 'Seller', 'Split 50-50'].includes(b.pay) ? b.pay : 'Buyer', cp = lc(b.cp);
  if (cp && !/\S+@\S+\.\S+/.test(cp)) bad('The other party email looks wrong.'); if (cp == u.email) bad('You cannot invite yourself.');
  let id, code; do id = rid('XW-', 8); while (db.deals.some(x => x.id == id));
  code = id;
  const d = {
    id, code, desc, role, amt, fee: FEES(amt), pay, owner: u.email, cp, at: Date.now(), v: 1, mid: 0, msgs: [], st: 'Pending', bc: 0, sc: 0, payout: 'KES',
    buyer: role == 'Buyer' ? u.email : cp, seller: role == 'Seller' ? u.email : cp, j: { buyer: role == 'Buyer' ? 1 : 0, seller: role == 'Seller' ? 1 : 0 }, cancel: {}, pend: {}
  };
  db.deals.push(d); push(d, { w: 'bot', card: 'welcome' }); push(d, { w: 'bot', card: 'terms' }); if (isAcct(d)) bot(d, '🔐 Account sale: the seller must send the account logins here, in this chat panel (not by WhatsApp, email or DM) so the handover can be tracked. Buyer: check that the login works, then confirm. Never share your M-Pesa PIN or OTP.');
  return d;
}
function person(d, r) { const e = d[r]; return { name: nameOf(e), joined: !!d.j[r] && !!e }; }
function view(d, u, since) {
  const me = u.email, role = roleOf(d, me), adm = isAdmin(u) && !role;
  const o = {
    id: d.id, code: d.id, desc: d.desc, amt: d.amt, fee: d.fee, pay: d.pay, st: d.st, bc: d.bc, sc: d.sc, payout: d.payout, at: d.at, v: d.v, role, admin: adm, creator: d.role,
    total: tot(d), net: net(d), buyer: person(d, 'buyer'), seller: person(d, 'seller'), cancel: d.cancel || {}, payoutDest: dest(d.seller), refundDest: dest(d.buyer), cfg: { rate: rate(), spr: BASE.spr }
  };
  if (((role == 'buyer' || adm || isBroker(d, me)) && d.bc && d.sc && (d.st == 'Pending' || d.st == 'Verifying')) || (isBroker(d, me) && d.st == 'Funded')) o.payInfo = { name: BASE.payName, phone: BASE.payPhone, addr: BASE.addr };
  if (adm) { o.buyerEmail = d.buyer; o.sellerEmail = d.seller; }
  o.broker = isBroker(d, me); o.acct = isAcct(d); o.bfee = d.bfee || 0; o.bset = !!d.bset; o.bamt = d.bamt || 0; o.top = d.top || 0; o.myFunded = d.fundedBy == me; o.tops = (d.tops || []).map(t => ({ id: t.id, amt: t.amt, st: t.st, by: nameOf(t.by) })); o.brokers = (d.brokers || []).map(e => ({ name: nameOf(e), bid: sh('b:' + e).slice(0, 10), me: e == me }));
  if (o.broker && !role && !adm) { o.payoutDest = 'hidden'; o.refundDest = 'hidden'; }
  o.msgs = d.msgs.filter(m => !m.for || m.for == me).slice(-300);
  return o;
}
function row(d, u) {
  const r = { id: d.id, code: d.id, desc: d.desc, amt: d.amt, st: d.st, role: roleOf(d, u.email) || (isBroker(d, u.email) ? 'broker' : null), at: d.at, total: tot(d), net: net(d), bc: d.bc, sc: d.sc, buyer: nameOf(d.buyer), seller: nameOf(d.seller) };
  if (isAdmin(u)) { r.buyerEmail = d.buyer; r.sellerEmail = d.seller; }
  return r;
}
function getDeal(id, u) {
  const d = db.deals.find(x => x.id == sq(id).replace(/^XW/, 'XW-') || x.id == String(id).toUpperCase());
  if (!d) bad('Deal not found.', 404);
  if (!mine(d, u.email) && !isAdmin(u)) bad('You are not part of this deal.', 403);
  return d;
}

/* --- state changes (shared by buttons and the chat bot) --- */
function doConfirm(d, u) {
  const r = roleOf(d, u.email); if (!r) bad('Only the buyer or the seller can confirm the terms.', 403);
  if (d.st != 'Pending') bad('This deal is already ' + d.st + '.');
  const k = r == 'buyer' ? 'bc' : 'sc'; if (r == 'buyer' && (d.brokers || []).length && !d.bset) bad('A broker is in this deal. The broker must list their fee or amount before you can confirm as buyer.'); if (d[k]) bad('You already confirmed. Waiting for the other party.');
  if (!d.buyer || !d.seller || !d.j.buyer || !d.j.seller) bad('The other party has not joined yet. Share the join code ' + d.code + ' with them.');
  d[k] = 1; bot(d, (r == 'buyer' ? 'Buyer ' : 'Seller ') + nameOf(u.email) + ' confirmed the deal terms.');
  if (d.bc && d.sc) bot(d, 'Both parties confirmed. Payment details are now unlocked. Buyer: type "fund" or tap Fund this deal and pay exactly ' + money(tot(d)) + '. Funds stay held until you confirm delivery.');
}
function doPaid(d, u, method) {
  if (roleOf(d, u.email) != 'buyer' && !isBroker(d, u.email)) bad('Only the buyer or a broker in this deal can report payment.', 403);
  if (d.st == 'Verifying') bad('We are already verifying your payment.'); if (d.st != 'Pending') bad('Nothing to pay. Status: ' + d.st + '.');
  if (!(d.bc && d.sc)) bad('Both parties must confirm the terms before payment.');
  d.st = 'Verifying'; d.method = String(method || 'M-Pesa').slice(0, 30); d.fundedBy = u.email;
  bot(d, 'Payment reported by ' + (roleOf(d, u.email) ? 'the buyer' : 'broker ' + nameOf(u.email)) + ' (' + d.method + '). We are verifying it and will confirm to both sides when funds are received.');
}
function doFunded(d, u) {
  if (!isAdmin(u)) bad('Only Xwadda staff can confirm received funds.', 403);
  if (d.st != 'Verifying' && !(d.st == 'Pending' && d.bc && d.sc)) bad('This deal is not waiting for payment confirmation.');
  d.st = 'Funded'; bot(d, 'Funds received and held in escrow. Seller: you can now deliver. Buyer: check the delivery, then type "release" (or "dispute" if something is wrong).');
}
function topRefund(d) { (d.tops || []).filter(t => t.st == 'Done').forEach(t => credit(t.by, t.amt, 'refund', d.id, 'Top-up refund ' + d.id)); d.top = 0; }
function credit(email, a, type, ref, note) { db.tx.push({ id: rid('TX-', 8), e: email, a, type, ref, note: note || '', st: 'Done', ts: Date.now() }); }
function doRelease(d, u, dry) {
  const r = roleOf(d, u.email), adm = isAdmin(u) && !r;
  const br = isBroker(d, u.email) && !r; if (!r && !adm && !br) bad('Only the buyer can release funds.', 403); if (br && d.fundedBy != u.email) bad('A broker can only release funds that they funded themselves.', 403);
  if (d.st != 'Funded' && !(adm && d.st == 'Disputed')) bad(d.st == 'Released' ? 'Funds were already released.' : 'Nothing to release yet. Status: ' + d.st + '.');
  if (r == 'seller') bad('Only the buyer can release funds.', 403);
  if (dry) return;
  d.st = 'Released'; credit(d.seller, net(d) + (d.top || 0), 'release', d.id, 'Deal ' + d.id); if (d.bfee && d.bfeeBy) credit(d.bfeeBy, d.bfee, 'release', d.id, 'Broker fee ' + d.id);
  bot(d, (adm ? 'Support released the funds. ' : 'Buyer confirmed delivery. ') + money(net(d) + (d.top || 0)) + (d.payout == 'USDT' ? ' (≈ ' + usd(toUsdt(net(d), 0)) + ')' : '') + ' was added to ' + nameOf(d.seller) + "'s Xwadda balance, less our fee. Payout preference: " + dest(d.seller) + '. The seller can now withdraw it from Wallet & payouts.');
}
function doDispute(d, u, dry) {
  const r = roleOf(d, u.email); if (!r) bad('Only the buyer or the seller can raise a dispute.', 403);
  if (d.st == 'Disputed') bad('A dispute is already open. Share your evidence here.');
  if (d.st != 'Funded') bad('A dispute can be raised once the deal is funded. Status: ' + d.st + '.');
  if (dry) return; d.st = 'Disputed'; bot(d, 'Dispute raised by the ' + r + '. Funds are frozen and our team will review. Share your evidence here.');
}
function doCancel(d, u, dry) {
  const r = roleOf(d, u.email); if (!r) bad('Only the buyer or the seller can cancel.', 403);
  if (d.st == 'Pending') { if (dry) return; d.st = 'Cancelled'; bot(d, 'Deal cancelled by the ' + r + '. No money was received, so nothing needs to be refunded.'); return; }
  if (d.st == 'Funded') {
    if (d.cancel[r]) bad('You already asked to cancel. Waiting for the other party to agree (they type "cancel deal").');
    if (dry) return; d.cancel[r] = 1;
    if (d.cancel.buyer && d.cancel.seller) { d.st = 'Refunded'; credit(d.fundedBy || d.buyer, tot(d), 'refund', d.id, 'Cancelled deal ' + d.id); topRefund(d); bot(d, 'Both parties agreed to cancel. ' + money(tot(d)) + ' was refunded to ' + nameOf(d.buyer) + "'s Xwadda balance."); }
    else bot(d, 'The ' + r + ' asked to cancel. The ' + (r == 'buyer' ? 'seller' : 'buyer') + ' must also type "cancel deal" to agree. If you cannot agree, raise a dispute.');
    return;
  }
  if (d.st == 'Verifying') bad('Your payment is being verified, so it cannot be cancelled here. Type "human" and support will help.');
  if (d.st == 'Disputed') bad('A dispute is open. Our team will resolve it.');
  bad('This deal is already ' + d.st + '.');
}
function doRefund(d, u) {
  if (!isAdmin(u)) bad('Only Xwadda staff can refund.', 403);
  if (d.st != 'Funded' && d.st != 'Disputed') bad('Only funded or disputed deals can be refunded.');
  d.st = 'Refunded'; credit(d.fundedBy || d.buyer, tot(d), 'refund', d.id, 'Refund ' + d.id); topRefund(d);
  bot(d, 'Support refunded ' + money(tot(d)) + ' to ' + nameOf(d.buyer) + "'s Xwadda balance.");
}

/* --- chat bot --- */
function lev(a, b) {
  const m = []; for (let i = 0; i <= a.length; i++) m[i] = [i]; for (let j = 0; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1));
  return m[a.length][b.length];
}
const KW = ['help', 'status', 'fund', 'fees', 'cancel', 'release', 'dispute', 'confirm', 'paid', 'refund', 'human', 'summary', 'balance', 'people', 'rates', 'code', 'menu', 'withdraw'];
const HELP = 'I understand plain words as well as commands. Try:\n• deal id — the Deal ID and join code\n• status — where the deal stands\n• confirm — confirm the deal terms\n• fund — how and where to pay\n• paid — tell us you have paid\n• release — release funds to the seller (buyer)\n• cancel deal — cancel (or ask to cancel)\n• dispute — freeze funds and call support\n• fees, summary, people, rates, balance\n• human — talk to a person';
const ACTS = { cancel: doCancel, release: doRelease, dispute: doDispute };
function ask(d, u, a, text) {
  try { ACTS[a](d, u, true); } catch (e) { return bot(d, e.message); }
  d.pend[u.email] = { a, ts: Date.now() }; bot(d, text + '\nReply YES to confirm or NO to keep things as they are.');
}
function hear(d, u, raw) {
  const me = u.email, role = roleOf(d, me);
  let n = raw.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(); if (!n) return;
  const slash = raw.trim()[0] == '/', words = n.split(' '), addressed = slash || /\b(bot|xwadda|escrow)\b/.test(n);
  if (words.length == 1 && n.length >= 4 && !KW.includes(n)) { const k = KW.find(k => lev(k, n) <= (n.length >= 6 ? 2 : 1)); if (k) { n = k; words[0] = k; } }
  if (!(addressed || words.length <= 6)) return;       // long messages are people talking, stay quiet
  const T = re => re.test(n), p = d.pend && d.pend[me];
  if (p && Date.now() - p.ts < 18e4) {
    if (/^(yes|y|yeah|yep|proceed|go ahead|do it|i confirm|confirm|yes please)$/.test(n)) { delete d.pend[me]; try { ACTS[p.a](d, u); } catch (e) { bot(d, e.message); } return; }
    if (/^(no|n|nope|stop|abort|dont|do not|never mind|nevermind|wait|no thanks)$/.test(n)) { delete d.pend[me]; return bot(d, 'Okay, nothing was changed.'); }
  }
  const run = (f, ...a) => { try { f(d, u, ...a); } catch (e) { bot(d, e.message); } };
  if (T(/\b(cancel|call off|abort deal|end deal)\b/)) return ask(d, u, 'cancel', d.st == 'Funded' ? 'Cancel deal ' + d.id + '? Because funds are held, both buyer and seller must agree, then the buyer is refunded.' : 'Cancel deal ' + d.id + '?');
  if (T(/\brefund\b|money back|get my money/)) {
    if (d.st == 'Funded' || d.st == 'Disputed') return bot(d, 'Funds held in escrow can be refunded when both sides agree to cancel (type "cancel deal"), or after a dispute is reviewed by support (type "dispute").');
    return bot(d, d.st == 'Pending' ? 'No payment has been made yet, so there is nothing to refund. Type "cancel deal" to cancel.' : 'Status: ' + d.st + '. Type "human" if you need help with a refund.');
  }
  if (T(/^(release|release (the )?(funds?|payment|money)|release now|confirm delivery|i (have )?(received|got) (the )?(item|goods|order|product|package|it))\b/)) return ask(d, u, 'release', 'Release ' + money(net(d)) + ' to ' + nameOf(d.seller) + '? This cannot be undone.');
  if (T(/^(dispute|raise (a )?dispute|open (a )?dispute|file (a )?dispute|report (a )?problem)\b/)) return ask(d, u, 'dispute', 'Raise a dispute on deal ' + d.id + '? Funds will be frozen until our team reviews it.');
  if (T(/\b(i have paid|ive paid|i paid|i have sent|i sent|payment (sent|done|made)|^paid$|^done$|^sent$)\b/)) return run(doPaid, 'M-Pesa');
  if (T(/^(confirm|i confirm|agree|i agree|accept|i accept|ok confirm|confirm deal|confirm terms)$/)) return run(doConfirm);
  if (T(/\b(fund|pay|payment|deposit|paybill|send money|till|account details|payment details)\b/)) {
    if (role == 'seller') return bot(d, 'Only the buyer pays. Status: ' + d.st + '. ' + (d.st == 'Funded' ? 'Funds are held, you can deliver.' : 'We will tell you here once funds are held.'));
    if (d.st == 'Funded' || d.st == 'Released') return bot(d, 'This deal is already funded. Status: ' + d.st + '.');
    if (d.st == 'Verifying') return bot(d, 'We are verifying the buyer\'s payment. We will confirm here as soon as it arrives.');
    if (d.st != 'Pending') return bot(d, 'This deal is ' + d.st + ', so it cannot be funded.');
    if (!(d.bc && d.sc)) return bot(d, 'Payment details unlock after both sides confirm. Buyer confirmed: ' + (d.bc ? 'yes' : 'no') + '. Seller confirmed: ' + (d.sc ? 'yes' : 'no') + '. Type "confirm" to confirm your side.');
    return bot(d, 'To fund deal ' + d.id + ' pay ' + money(tot(d)) + ' (or ≈ ' + usd(toUsdt(tot(d), 1)) + '):\n• M-Pesa Send Money to ' + BASE.payPhone + ' (' + BASE.payName + '). Put ' + d.id + ' in the note.\n• USDT BEP20: ' + BASE.addr['USDT BEP20'] + '\n• USDT TRC20: ' + BASE.addr['USDT TRC20'] + '\nThese details are also on the Fund page. After paying, type "paid". I never ask for your M-Pesa PIN.');
  }
  if (T(/\b(deal id|id|ref|reference|deal number|escrow id|room id|deal code)\b/) && !T(/\bjoin\b/)) return bot(d, 'Deal ID: ' + d.id + '\nJoin code: ' + d.code);
  if (T(/\b(join|invite|code|link)\b/)) return bot(d, 'Join code: ' + d.code + '\nThe other party signs in, opens "Join with a code" and enters it, or opens your Invite link. Deal ID: ' + d.id + '.');
  if (T(/\b(status|progress|state|where are we|what next|next step)\b/)) {
    const nx = d.st == 'Pending' ? (!(d.j.buyer && d.j.seller) ? 'Waiting for the other party to join with code ' + d.code + '.' : !(d.bc && d.sc) ? 'Waiting for confirmation (type "confirm").' : 'Buyer: type "fund" to pay.') : d.st == 'Verifying' ? 'We are verifying the payment.' : d.st == 'Funded' ? 'Seller delivers, then the buyer types "release".' : d.st == 'Disputed' ? 'Support is reviewing the dispute.' : 'This deal is closed.';
    return bot(d, 'Deal ' + d.id + ': ' + d.st + '.\nBuyer confirmed: ' + (d.bc ? 'yes' : 'no') + '. Seller confirmed: ' + (d.sc ? 'yes' : 'no') + '.\nNext: ' + nx);
  }
  if (T(/\b(fees?|charges?|cost|commission)\b/)) return bot(d, 'Fee for this deal: ' + (d.fee ? money(d.fee) : 'KES 0') + ', paid by ' + d.pay + '. Tiers: up to 2,000 free; to 5,000 KES 300; to 20,000 KES 400; to 40,000 KES 500; to 70,000 KES 600; to 100,000 KES 800; above 100,000 KES 1,000.');
  if (T(/\b(summary|details|terms|amount|how much|price|total|breakdown)\b/)) return push(d, { w: 'bot', card: 'summary' });
  if (T(/\b(who|people|participants?|members?|buyer|seller|counterparty|other party)\b/)) return bot(d, 'Buyer: ' + nameOf(d.buyer) + (d.j.buyer ? '' : ' (not joined yet)') + '\nSeller: ' + nameOf(d.seller) + (d.j.seller ? '' : ' (not joined yet)') + '\nAdmin: Xwadda Escrow Bot');
  if (T(/\b(rates?|usdt|exchange|convert|dollar|usd)\b/)) return bot(d, 'Rates: buy USDT at KES ' + (rate() + BASE.spr) + ', sell at KES ' + (rate() - BASE.spr) + '. This deal: ' + money(d.amt) + ' ≈ ' + usd(toUsdt(d.amt, 1)) + '; buyer pays ' + money(tot(d)) + ' ≈ ' + usd(toUsdt(tot(d), 1)) + '.');
  if (T(/\b(balance|withdraw|wallet)\b/)) return push(d, { w: 'bot', for: me, t: 'Your available balance is ' + money(bal(me)) + '. Open Wallet & payouts to withdraw.' });
  if (T(/\b(human|agent|support|someone|customer care|operator|talk to (a )?person)\b/)) {
    db.tickets.push({ id: rid('TK-', 6), e: me, deal: d.id, msg: 'Asked for a human in room ' + d.id + ': ' + raw.slice(0, 300), st: 'open', ts: Date.now() });
    return bot(d, 'Done. A human agent has been notified about deal ' + d.id + ' and will reply in this room or by email. Meanwhile you can keep chatting here.');
  }
  if (T(/\b(pin|otp)\b/) || (!isAcct(d) && T(/\b(password|passcode)\b/))) return bot(d, 'Never share your M-Pesa PIN, password or OTP with anyone, including people who claim to be Xwadda. I will never ask for them.'); if (isAcct(d) && T(/\b(password|passcode|login|logins|username|email)\b/)) return bot(d, '🔐 Login details noted in this room for tracking. Buyer: check that the login works, then confirm. Seller: do not change the details until funds are released. Never share your M-Pesa PIN or OTP here.');
  if (T(/^(help|menu|commands?|options|what can you do|how does this work|how to use|\?)/)) return bot(d, HELP);
  if (T(/^(hi|hello|hey|hallo|habari|niaje|sasa|mambo|good (morning|afternoon|evening))\b/) && words.length <= 3) return bot(d, 'Hello ' + u.name.split(' ')[0] + '! Deal ' + d.id + ' is ' + d.st + '. Type "help" to see what I can do.');
  if (T(/\b(thanks?|thank you|asante)\b/) && words.length <= 3) return bot(d, 'You are welcome. I am here if you need anything.');
  if (words.length <= 3 || addressed) return bot(d, 'I did not catch that. Try: deal id, status, fund, confirm, release, cancel deal, dispute, fees or help.');
}

/* ---------- routes ---------- */
const routes = [];
const R = (m, p, f, o) => routes.push({ m, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), f, o: o || {} });
const numArg = (v, min, max, msg) => { v = Math.round(+v); if (!(v >= min && v <= max)) bad(msg); return v; };

R('GET', '/api/health', () => ({ ok: true, t: Date.now(), storage: pool ? 'database' : 'file' }), { pub: 1 });
R('GET', '/api/config', () => ({ rate: rate(), spr: BASE.spr }), { pub: 1 });

R('POST', '/api/register', c => {
  lim('reg:' + c.ip, 10, 36e5);
  const n = String(c.b.name || '').trim().slice(0, 80), e = lc(c.b.email), p = String(c.b.password || '');
  if (!n || !/^\S+@\S+\.\S+$/.test(e) || e.length > 120) bad('Enter your full name and a valid email.');
  if (db.users[e]) bad('An account with this email already exists. Please sign in.', 409);
  const pr = pwProblems(p, n, e); if (pr.length) bad('Password needs: ' + pr.join(', ') + '.');
  const key = genKey(), u = { name: n, email: e, pw: mkHash(p), rk: mkHash(normKey(key)), w: {}, numbers: [], created: Date.now() };
  db.users[e] = u; save(); return Object.assign(sess(u), { recoveryKey: key });
}, { pub: 1 });

R('POST', '/api/login', c => {
  const e = lc(c.b.email), p = String(c.b.password || ''); lim('login:' + c.ip + e, 8, 6e5);
  const u = db.users[e], ok = chk(p, u ? u.pw : { s: '00'.repeat(16), h: '00'.repeat(32) });
  if (!u || !ok) bad('Incorrect email or password.', 401); return sess(u);
}, { pub: 1 });

R('POST', '/api/reset', c => {
  const e = lc(c.b.email), k = normKey(c.b.key), p = String(c.b.password || ''); lim('reset:' + c.ip + e, 5, 6e5);
  const u = db.users[e]; if (u && !u.rk) bad('This account has no recovery key, so it cannot be reset here. Please contact support.');
  if (!u || !chk(k, u.rk)) bad('Email or recovery key is incorrect.', 401);
  const pr = pwProblems(p, u.name, e); if (pr.length) bad('New password needs: ' + pr.join(', ') + '.');
  const key = genKey(); u.pw = mkHash(p); u.rk = mkHash(normKey(key));
  for (const t in db.sessions) if (db.sessions[t].e == e) delete db.sessions[t];
  save(); return Object.assign(sess(u), { recoveryKey: key });
}, { pub: 1 });

R('POST', '/api/logout', c => { const t = (c.req.headers.authorization || '').slice(7); delete db.sessions[sh(t)]; save(); return { ok: true }; });
R('GET', '/api/me', c => ({ user: pub(c.u), cfg: cfgFor() }));
R('POST', '/api/password', c => {
  lim('pw:' + c.u.email, 6, 6e5); if (!chk(String(c.b.cur || ''), c.u.pw)) bad('Your current password is incorrect.', 403);
  const pr = pwProblems(c.b.next, c.u.name, c.u.email); if (pr.length) bad('New password needs: ' + pr.join(', ') + '.');
  c.u.pw = mkHash(String(c.b.next)); save(); return { ok: true };
});
R('PUT', '/api/profile', c => {
  const n = String(c.b.name || '').trim().slice(0, 80); if (n) c.u.name = n;
  const ph = String(c.b.phone || '').replace(/[^0-9+]/g, '').slice(0, 16); if (ph) c.u.phone = ph; save(); return pub(c.u);
});
R('PUT', '/api/wallet', c => {
  const w = c.b.w || {}, o = { pref: String(w.pref || '') };
  ['mp', 'bin', 'byb', 'bg', 'bep', 'trc'].forEach(k => o[k] = String(w[k] || '').trim().slice(0, 80));
  if (o.bep && !/^0x[a-fA-F0-9]{40}$/.test(o.bep)) bad('BEP20 address looks wrong. It should start with 0x and be 42 characters.');
  if (o.trc && !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(o.trc)) bad('TRC20 address looks wrong. It should start with T and be 34 characters.');
  if (!['mpesa', 'bin', 'byb', 'bg', 'bep', 'trc', 'both'].includes(o.pref)) bad('Choose a preferred method.');
  const need = o.pref == 'both' ? (o.bep && o.trc) : o[({ mpesa: 'mp', bin: 'bin', byb: 'byb', bg: 'bg', bep: 'bep', trc: 'trc' })[o.pref]];
  if (!need) bad(o.pref == 'both' ? 'Add both the BEP20 and TRC20 addresses, or choose one network.' : 'Fill in the field for your preferred method.');
  c.u.w = o; save(); return pub(c.u);
});
R('PUT', '/api/numbers', c => {
  const l = Array.isArray(c.b.list) ? c.b.list.slice(0, 10) : [], out = [];
  for (const x of l) { const p = String(x.phone || '').replace(/[^0-9+]/g, ''); if (p.replace(/\D/g, '').length < 9 || p.length > 16) bad('One of the numbers is not valid.'); out.push({ label: String(x.label || 'My number').slice(0, 30), phone: p, def: !!x.def }); }
  if (out.length && !out.some(x => x.def)) out[0].def = true; c.u.numbers = out; save(); return pub(c.u);
});

/* public figures (no sign-in needed) */
R('GET', '/api/public/stats', c => {
  lim('ps:' + c.ip, 240, 6e4);
  const h = db.deals.filter(d => d.st == 'Funded' || d.st == 'Disputed');
  return { held: h.reduce((s, d) => s + d.amt + (d.top || 0), 0), rate: rate(), deals: h.length, t: Date.now() };
}, { pub: 1 });

/* deals */
R('GET', '/api/deals', c => ({ deals: db.deals.filter(d => mine(d, c.u.email)).map(d => row(d, c.u)).reverse(), user: pub(c.u) }));
R('POST', '/api/deals', c => { lim('mk:' + c.u.email, 30, 36e5); return view(newDeal(c.u, c.b), c.u); });
R('POST', '/api/join', c => {
  lim('join:' + c.u.email, 20, 6e5); const k = sq(c.b.code); if (!k) bad('Enter the deal join code.');
  if (c.b.as == 'broker') {
    const bd = db.deals.find(x => sq(x.id) == k); if (!bd) bad('No deal found with that Deal ID. Brokers join with the Deal ID (XW-...) from the buyer or seller.', 404);
    const bm = c.u.email; if (roleOf(bd, bm) || bd.owner == bm || isBroker(bd, bm)) return { id: bd.id, already: true };
    if (!ACTIVE.includes(bd.st)) bad('This deal is already ' + bd.st + ' and cannot be joined.');
    bd.brokers = bd.brokers || []; if (bd.brokers.length >= 3) bad('This deal already has the maximum number of brokers.');
    bd.brokers.push(bm); bot(bd, '🤝 ' + c.u.name + ' joined as a Broker. Brokers can read and chat in this room, but cannot confirm, pay, release or cancel. The buyer or seller can remove a broker from the side panel.');
    return { id: bd.id };
  }
  const d = db.deals.find(x => sq(x.code) == k || sq(x.id) == k); if (!d) bad('No deal found with that code. Check it and try again.', 404);
  const me = c.u.email; if (roleOf(d, me) || d.owner == me || isBroker(d, me)) { return { id: d.id, already: true }; }
  if (!ACTIVE.includes(d.st)) bad('This deal is already ' + d.st + ' and cannot be joined.');
  const slot = d.role == 'Buyer' ? 'seller' : 'buyer';
  if (d[slot] && d[slot] != me) bad('This deal is already assigned to another account.', 403);
  d[slot] = me; d.j[slot] = 1; bot(d, '✅ ' + c.u.name + ' joined as the ' + (slot == 'buyer' ? 'Buyer' : 'Seller') + '. Both sides can now review the deal and type "confirm" (or press Confirm).');
  return { id: d.id };
});
R('GET', '/api/deals/:id', c => {
  const d = getDeal(c.p.id, c.u), r = roleOf(d, c.u.email);
  if (r && !d.j[r]) { d.j[r] = 1; bot(d, '✅ ' + c.u.name + ' joined as the ' + (r == 'buyer' ? 'Buyer' : 'Seller') + '.'); }
  if (c.q.get('v') && +c.q.get('v') == d.v) return { same: true };
  return view(d, c.u);
});
const act = (name, fn) => R('POST', '/api/deals/:id/' + name, c => { const d = getDeal(c.p.id, c.u); fn(d, c.u, c.b); return view(d, c.u); });
act('confirm', (d, u) => doConfirm(d, u));
act('paid', (d, u, b) => doPaid(d, u, b.method));
act('fund', (d, u) => doFunded(d, u));
act('release', (d, u) => doRelease(d, u));
act('dispute', (d, u) => doDispute(d, u));
act('cancel', (d, u) => doCancel(d, u));
act('brokerfee', (d, u, b) => {
  if (!isBroker(d, u.email)) bad('Only a broker in this deal can list a broker fee.', 403);
  if (d.st != 'Pending' || d.bc) bad('The broker fee can only be listed before the buyer confirms and funding starts.');
  const f = Math.round(+b.fee), a = Math.round(+b.amt) || 0; if (!(f >= 0) || f > 1e6) bad('Enter a broker fee of KES 0 or more.');
  d.bfee = f; d.bamt = a; d.bfeeBy = u.email; d.bset = 1;
  bot(d, '🤝 Broker ' + nameOf(u.email) + ' listed their fee: ' + money(f) + (a ? ' and will fund up to ' + money(a) : '') + '. New buyer total: ' + money(tot(d)) + '. The buyer can now confirm as buyer.');
});
act('topup', (d, u, b) => {
  if (!isBroker(d, u.email)) bad('Only a broker can top up the held funds.', 403);
  if (d.st != 'Funded') bad('Top-ups are for funds already held in escrow. Status: ' + d.st + '.');
  const a = Math.round(+b.amount); if (!(a >= 100) || a > 5e6) bad('A top-up must be at least KES 100.');
  d.tops = d.tops || []; if (d.tops.filter(t => t.st == 'Verifying').length >= 3) bad('You already have pending top-ups. Wait for support to confirm them.');
  const t = { id: rid('TP-', 6), by: u.email, amt: a, st: 'Verifying', ts: Date.now() }; d.tops.push(t);
  bot(d, '➕ Broker ' + nameOf(u.email) + ' reported a top-up of ' + money(a) + ' (' + t.id + '). We are verifying it and will add it to the held funds.');
});
act('topupok', (d, u, b) => {
  if (!isAdmin(u)) bad('Only Xwadda staff can confirm top-ups.', 403);
  const t = (d.tops || []).find(x => x.id == b.tid && x.st == 'Verifying'); if (!t) bad('Top-up not found.', 404);
  t.st = 'Done'; d.top = (d.top || 0) + t.amt;
  bot(d, '✅ Top-up ' + t.id + ' of ' + money(t.amt) + ' confirmed. Funds now held for this deal: ' + money(d.amt + d.top) + '.');
});
act('refund', (d, u) => doRefund(d, u));
act('payout', (d, u, b) => {
  if (roleOf(d, u.email) != 'seller') bad('Only the seller sets the payout currency.', 403);
  d.payout = b.cur == 'USDT' ? 'USDT' : 'KES'; bot(d, 'Seller payout set to ' + (d.payout == 'KES' ? money(net(d)) + ' via M-Pesa' : usd(toUsdt(net(d), 0)) + ' in USDT') + '.');
});
R('POST', '/api/deals/:id/messages', c => {
  const d = getDeal(c.p.id, c.u), t = String(c.b.text || '').trim().slice(0, 1000); if (!t) bad('Type a message.');
  lim('msg:' + c.u.email, 40, 6e4);
  push(d, { w: 'user', e: c.u.email, n: c.u.name, t, adm: isAdmin(c.u) && !roleOf(d, c.u.email), br: isBroker(d, c.u.email) && !roleOf(d, c.u.email) });
  hear(d, c.u, t); return view(d, c.u);
});

R('POST', '/api/deals/:id/brokers/remove', c => {
  const d = getDeal(c.p.id, c.u), me = c.u.email, r = roleOf(d, me), adm = isAdmin(c.u);
  const target = (d.brokers || []).find(e => sh('b:' + e).slice(0, 10) == String(c.b.bid || '')); if (!target) bad('Broker not found.', 404);
  if (!(r || d.owner == me || adm || target == me)) bad('Only the buyer, the seller or the broker can do that.', 403);
  d.brokers = d.brokers.filter(e => e != target); if (d.bfeeBy == target && d.st == 'Pending') { d.bfee = 0; d.bamt = 0; d.bset = 0; d.bfeeBy = ''; d.bc = 0; }
  bot(d, '🤝 ' + nameOf(target) + (target == me ? ' left the deal as a broker.' : ' was removed as a broker.'));
  return (target == me && !r && !adm) ? { left: true } : view(d, c.u);
});

/* wallet */
R('GET', '/api/wallet', c => ({ bal: bal(c.u.email), tx: db.tx.filter(t => t.e == c.u.email).slice(-100).reverse().map(t => ({ id: t.id, a: t.a, type: t.type, ref: t.ref, note: t.note, st: t.st, ts: t.ts })), user: pub(c.u) }));
R('POST', '/api/withdraw', c => {
  lim('wd:' + c.u.email, 10, 36e5); const a = numArg(c.b.amount, 100, 5e6, 'Minimum withdrawal is KES 100.');
  if (a > bal(c.u.email)) bad('That is more than your available balance.');
  const k = String(c.b.dest || ''), w = c.u.w || {}; let label = '';
  if (k.startsWith('num:')) { const n = (c.u.numbers || [])[+k.slice(4)]; if (n) label = 'M-Pesa ' + n.phone; }
  else { const m = { mpesa: ['M-Pesa', w.mp], bin: ['Binance ID', w.bin], byb: ['Bybit ID', w.byb], bg: ['Bitget ID', w.bg], bep: ['USDT BEP20', w.bep], trc: ['USDT TRC20', w.trc] }[k.slice(2)]; if (k.startsWith('w:') && m && m[1]) label = m[0] + ' ' + m[1]; }
  if (!label) bad('Choose where to send the money. Add details under My numbers or Wallet & payouts.');
  db.tx.push({ id: rid('WD-', 8), e: c.u.email, a: -a, type: 'withdraw', ref: label, note: 'Withdrawal request', st: 'Pending', ts: Date.now() }); save();
  return { bal: bal(c.u.email) };
});

/* kiosk, scam watch, support */
R('POST', '/api/kiosk', c => {
  lim('ko:' + c.u.email, 20, 36e5); const b = c.b, usdt = +b.usdt, buy = b.action == 'buy';
  if (!(usdt >= 1 && usdt <= 50000)) bad('Enter an amount between 1 and 50,000 USDT.');
  const o = { id: rid('KO-', 7), e: c.u.email, action: buy ? 'buy' : 'sell', usdt, kes: Math.round(usdt * (buy ? rate() + BASE.spr : rate() - BASE.spr)), st: 'Pending', ts: Date.now() };
  if (buy) { const id = String(b.uid || '').trim().slice(0, 60); if (!id) bad('Enter your exchange ID.'); o.to = String(b.platform || 'Binance ID').slice(0, 20) + ' ' + id; }
  else { const p = String(b.phone || '').replace(/[^0-9+]/g, ''); if (p.replace(/\D/g, '').length < 9) bad('Enter the number to receive your KES.'); o.to = 'M-Pesa ' + p; o.net = String(b.net || '').slice(0, 20); }
  db.orders.push(o); save(); return o;
});
R('GET', '/api/orders', c => ({ orders: db.orders.filter(o => o.e == c.u.email).slice(-30).reverse() }));
const normV = v => { v = lc(v).replace(/[\s-]/g, ''); if (/^\+?\d{9,15}$/.test(v)) { v = v.replace('+', ''); if (v[0] == '0') v = '254' + v.slice(1); else if (/^[71]\d{8}$/.test(v)) v = '254' + v; } return v; };
const reportSt = x => x.st || 'pending';
function scamLists() {
  const cnt = {}; db.reports.filter(x => reportSt(x) != 'rejected').forEach(x => { cnt[x.v] = (cnt[x.v] || 0) + 1; });
  const pending = db.reports.filter(x => reportSt(x) == 'pending').slice(-100).reverse().map(x => ({ id: x.id, v: x.v, kind: x.kind, note: x.note, e: x.e, ts: x.ts, n: cnt[x.v] }));
  const seen = {}, confirmed = [];
  db.reports.filter(x => reportSt(x) == 'confirmed').reverse().forEach(x => { if (seen[x.v]) { seen[x.v].n++; return; } seen[x.v] = { id: x.id, v: x.v, kind: x.kind, n: 1, ct: x.ct || x.ts, by: x.by || '' }; confirmed.push(seen[x.v]); });
  return { pending, confirmed: confirmed.slice(0, 200) };
}
R('GET', '/api/scam/check', c => {
  lim('sc:' + c.u.email, 60, 36e5); const v = normV(c.q.get('value')); if (v.length < 4) bad('Enter a number, email, wallet or handle to check.');
  const all = db.reports.filter(x => x.v == v), r = all.filter(x => reportSt(x) == 'confirmed'), p = all.filter(x => reportSt(x) == 'pending');
  return { count: r.length, pending: p.length, kinds: [...new Set(r.map(x => x.kind))], latest: r.slice(-3).reverse().map(x => ({ note: x.note.slice(0, 140), ts: x.ct || x.ts })) };
});
R('POST', '/api/scam/report', c => {
  lim('sr:' + c.u.email, 5, 864e5); const v = normV(c.b.value), note = String(c.b.note || '').trim().slice(0, 500);
  if (v.length < 4 || note.length < 10) bad('Add the number, wallet, email or handle, and a short description of what happened.');
  if (db.reports.some(x => x.v == v && x.e == c.u.email && reportSt(x) != 'rejected')) bad('You already reported this one. Thank you, our team is reviewing it.');
  db.reports.push({ id: rid('SR-', 6), e: c.u.email, kind: String(c.b.kind || 'Other').slice(0, 30), v, note, st: 'pending', ts: Date.now() }); save(); return { ok: true };
});
R('POST', '/api/support', c => {
  lim('sp:' + c.u.email, 10, 36e5); const m = String(c.b.msg || '').trim().slice(0, 1500); if (m.length < 5) bad('Tell us a little more so we can help.');
  db.tickets.push({ id: rid('TK-', 6), e: c.u.email, deal: String(c.b.deal || '').slice(0, 20), msg: m, st: 'open', ts: Date.now() }); save(); return { ok: true };
});

/* admin */
R('GET', '/api/admin', c => {
  const rel = db.deals.filter(d => d.st == 'Released');
  return {
    stats: { users: Object.keys(db.users).length, deals: db.deals.length, volume: rel.reduce((s, d) => s + d.amt, 0), fees: rel.reduce((s, d) => s + d.fee, 0), held: db.deals.filter(d => d.st == 'Funded').length, heldKes: db.deals.filter(d => d.st == 'Funded').reduce((s, d) => s + d.amt + (d.top || 0), 0), reports: db.reports.filter(x => reportSt(x) == 'pending').length },
    rate: rate(), users: Object.values(db.users).sort((a, b) => (b.created || 0) - (a.created || 0)).slice(0, 30).map(u => ({ name: u.name, email: u.email, phone: u.phone || '', ts: u.created || 0 })), deals: db.deals.slice().reverse().map(d => row(d, c.u)),
    withdrawals: db.tx.filter(t => t.type == 'withdraw').slice(-100).reverse().map(t => ({ id: t.id, e: t.e, a: -t.a, ref: t.ref, st: t.st, ts: t.ts })),
    orders: db.orders.slice(-100).reverse(), tickets: db.tickets.filter(t => t.st == 'open').reverse(), scam: scamLists()
  };
}, { admin: 1 });
R('POST', '/api/admin/rate', c => { const r = +c.b.rate; if (!(r > 50 && r < 500)) bad('Enter a rate between 50 and 500.'); db.cfg.rate = r; save(); return { rate: r }; }, { admin: 1 });
R('POST', '/api/admin/withdrawals/:id', c => {
  const t = db.tx.find(x => x.id == c.p.id && x.type == 'withdraw'); if (!t) bad('Not found.', 404); if (t.st != 'Pending') bad('Already ' + t.st + '.');
  if (c.b.action == 'pay') t.st = 'Paid'; else { t.st = 'Rejected'; credit(t.e, -t.a, 'withdraw_refund', t.id, 'Withdrawal rejected'); } save(); return { ok: true };
}, { admin: 1 });
R('POST', '/api/admin/orders/:id', c => { const o = db.orders.find(x => x.id == c.p.id); if (!o) bad('Not found.', 404); o.st = c.b.action == 'done' ? 'Done' : 'Rejected'; save(); return { ok: true }; }, { admin: 1 });
R('POST', '/api/admin/scam/:id', c => {
  const x = db.reports.find(r => r.id == c.p.id); if (!x) bad('Not found.', 404); const a = c.b.action, now = Date.now();
  if (a == 'confirm') db.reports.forEach(r => { if (r.v == x.v && reportSt(r) == 'pending') { r.st = 'confirmed'; r.ct = now; r.by = c.u.email; } });
  else if (a == 'reject') { x.st = 'rejected'; x.ct = now; x.by = c.u.email; }
  else if (a == 'remove') db.reports.forEach(r => { if (r.v == x.v && reportSt(r) == 'confirmed') { r.st = 'rejected'; r.ct = now; r.by = c.u.email; } });
  else bad('Unknown action.');
  save(); return { ok: true };
}, { admin: 1 });
R('POST', '/api/admin/scam', c => {
  const v = normV(c.b.value), note = String(c.b.note || '').trim().slice(0, 500);
  if (v.length < 4 || note.length < 5) bad('Add the number, wallet, email or handle, and a short note.');
  if (db.reports.some(x => x.v == v && reportSt(x) == 'confirmed')) bad('That one is already on the scam list.');
  const now = Date.now(); db.reports.push({ id: rid('SR-', 6), e: c.u.email, kind: String(c.b.kind || 'Other').slice(0, 30), v, note, st: 'confirmed', ts: now, ct: now, by: c.u.email }); save(); return { ok: true };
}, { admin: 1 });
R('POST', '/api/admin/tickets/:id', c => { const t = db.tickets.find(x => x.id == c.p.id); if (!t) bad('Not found.', 404); t.st = 'closed'; save(); return { ok: true }; }, { admin: 1 });

/* ---------- http ---------- */
const HTML = () => fs.readFileSync(path.join(__dirname, 'index.html'));
function body(req) {
  return new Promise((res, rej) => {
    let n = 0; const c = [];
    req.on('data', b => { n += b.length; if (n > 1e5) { rej(new E(413, 'Request too large')); req.destroy(); } else c.push(b); });
    req.on('end', () => { try { res(c.length ? JSON.parse(Buffer.concat(c)) : {}); } catch (e) { rej(new E(400, 'Bad request')); } });
    req.on('error', rej);
  });
}
const CORS = { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS', 'Access-Control-Max-Age': '600' };
function send(res, s, o) { res.writeHead(s, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, CORS)); res.end(JSON.stringify(o)); }

const srv = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname == '/' || url.pathname == '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
      return res.end(HTML());
    }
    if (!url.pathname.startsWith('/api/')) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    if (req.method == 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    const ip = (TRUST && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
    lim('ip:' + ip, 1500, 6e5);
    let m, r; for (const x of routes) { if (x.m != req.method) continue; const g = x.re.exec(url.pathname); if (g) { r = x; m = g; break; } }
    if (!r) bad('Not found.', 404);
    const u = authUser(req); if (!r.o.pub && !u) bad('Please sign in.', 401); if (r.o.admin && !isAdmin(u)) bad('Admins only.', 403);
    const b = req.method == 'GET' ? {} : await body(req);
    send(res, 200, await r.f({ u, b, p: m.groups || {}, q: url.searchParams, ip, req }));
  } catch (e) {
    if (e instanceof E) return send(res, e.s, { error: e.message });
    console.error(e); send(res, 500, { error: 'Something went wrong on the server. Please try again.' });
  }
});
bootDb().then(() => srv.listen(PORT, () => console.log('Xwadda Escrow running on http://localhost:' + PORT + (pool ? '  [storage: database]' : '  [storage: file ' + DATA + ']') + (ADMINS.length ? '' : '  (no ADMIN_EMAILS set)'))));
