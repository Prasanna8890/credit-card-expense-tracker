/**
 * Credit Card Expense Tracker — Google Apps Script backend
 * =========================================================
 * Shared backend for the static front-end (index.html + app.js + config.js).
 *
 * The front-end talks to this script with a single POST endpoint. Every request
 * body is JSON: { action: "<name>", ...payload }. The Content-Type is
 * text/plain on purpose so the browser treats it as a "simple" CORS request and
 * skips the preflight OPTIONS call that Apps Script cannot answer.
 *
 * Response contract (what app.js expects):
 *   load              -> { ok:true, cards:[...], transactions:[...] }
 *   addTransaction    -> { ok:true, transactions:[...] }
 *   updateTransaction -> { ok:true, transactions:[...] }
 *   deleteTransaction -> { ok:true, transactions:[...] }
 *   saveCards         -> { ok:true, cards:[...] }
 *   (any failure)     -> { ok:false, error:"message" }
 *
 * Google Sheets is the single source of truth. The spreadsheet and its tabs are
 * created automatically on first run — no manual sheet setup is required.
 *
 * SETUP
 *   1. Create a blank Google Sheet, open Extensions -> Apps Script.
 *   2. Paste this file in, save.
 *   3. Deploy -> New deployment -> Web app.
 *        Execute as: Me
 *        Who has access: Anyone   (required — GitHub Pages visitors are anonymous)
 *   4. Copy the /exec URL into config.js on the front-end.
 */

/* ------------------------------------------------------------------ config */

var SHEET_TX = 'Transactions';
var SHEET_CARDS = 'Cards';

var TX_HEADERS = [
  'id', 'date', 'amount', 'cardId', 'description',
  'category', 'merchant', 'notes', 'isEmi', 'createdAt', 'updatedAt'
];
var CARD_HEADERS = ['id', 'name', 'last4', 'billingDay', 'limit', 'color'];

// Kept in sync with defaultCards in app.js so a brand-new ledger looks the same.
var DEFAULT_CARDS = [
  { id: 'card-1', name: 'Card 1', last4: '', billingDay: 1, limit: 0, color: '#0f766e' },
  { id: 'card-2', name: 'Card 2', last4: '', billingDay: 1, limit: 0, color: '#2563eb' },
  { id: 'card-3', name: 'Card 3', last4: '', billingDay: 1, limit: 0, color: '#b45309' }
];

// Validation limits (mirror the maxlength attributes in index.html).
var LIMITS = {
  description: 120,
  category: 50,
  merchant: 80,
  notes: 500,
  cardName: 40,
  amountMax: 1e9,   // 1 billion — a sane ceiling for a personal ledger
  maxCards: 24      // generous cap; the UI ships with 3
};

var LOCK_TIMEOUT_MS = 25000;

/* ------------------------------------------------------------------ routing */

function doPost(e) {
  try {
    var body = parseBody_(e);
    var action = String(body.action || '').trim();
    if (!action) throw new Error('Missing "action".');

    // "load" is read-only and safe to serve without a lock.
    if (action === 'load') return jsonOut_({ ok: true, cards: readCards_(), transactions: readTransactions_() });
    if (action === 'ping') return jsonOut_({ ok: true, pong: true, time: new Date().toISOString() });

    // Everything else mutates the sheet — serialize with a script lock so two
    // simultaneous writers can't clobber each other or create duplicates.
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
      throw new Error('The ledger is busy handling another change. Please try again in a moment.');
    }
    try {
      switch (action) {
        case 'addTransaction':    return jsonOut_(handleAdd_(body.transaction));
        case 'updateTransaction': return jsonOut_(handleUpdate_(body.transaction));
        case 'deleteTransaction': return jsonOut_(handleDelete_(body.id));
        case 'saveCards':         return jsonOut_(handleSaveCards_(body.cards));
        default: throw new Error('Unknown action: ' + action);
      }
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return jsonOut_({ ok: false, error: (err && err.message) ? err.message : String(err) });
  }
}

// Visiting the /exec URL in a browser (a GET) lands here — handy for confirming
// the deployment is live without touching any data.
function doGet(e) {
  var action = e && e.parameter && e.parameter.action;
  if (action === 'load') {
    return jsonOut_({ ok: true, cards: readCards_(), transactions: readTransactions_() });
  }
  return jsonOut_({
    ok: true,
    service: 'Credit Card Expense Tracker backend',
    status: 'deployed',
    time: new Date().toISOString(),
    hint: 'This endpoint is used by the app via POST. Deployment is working.'
  });
}

/* ------------------------------------------------------------------ handlers */

function handleAdd_(transaction) {
  var cards = readCards_();
  var clean = validateTransaction_(transaction, cards, { forUpdate: false });
  var rows = readTransactions_();

  // Idempotency: if this id already exists, treat the retry as a no-op success
  // instead of inserting a duplicate. This is what protects against double-taps
  // and flaky-network retries.
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].id === clean.id) return { ok: true, transactions: rows, duplicate: true };
  }

  var now = new Date().toISOString();
  clean.createdAt = clean.createdAt || now;
  clean.updatedAt = now;

  var sh = getSheet_(SHEET_TX, TX_HEADERS);
  sh.appendRow(txToRow_(clean));
  return { ok: true, transactions: readTransactions_() };
}

function handleUpdate_(transaction) {
  var cards = readCards_();
  var clean = validateTransaction_(transaction, cards, { forUpdate: true });

  var sh = getSheet_(SHEET_TX, TX_HEADERS);
  var found = findRowIndexById_(sh, clean.id);
  if (found < 0) throw new Error('That expense no longer exists. Refresh and try again.');

  // Preserve the original createdAt; only bump updatedAt.
  var existing = rowToTx_(sh.getRange(found, 1, 1, TX_HEADERS.length).getValues()[0]);
  clean.createdAt = existing.createdAt || new Date().toISOString();
  clean.updatedAt = new Date().toISOString();

  sh.getRange(found, 1, 1, TX_HEADERS.length).setValues([txToRow_(clean)]);
  return { ok: true, transactions: readTransactions_() };
}

function handleDelete_(id) {
  id = assertId_(id);
  var sh = getSheet_(SHEET_TX, TX_HEADERS);
  var found = findRowIndexById_(sh, id);
  if (found < 0) {
    // Already gone — return current state rather than erroring.
    return { ok: true, transactions: readTransactions_() };
  }
  sh.deleteRow(found);
  return { ok: true, transactions: readTransactions_() };
}

function handleSaveCards_(cards) {
  if (!Array.isArray(cards) || cards.length === 0) throw new Error('At least one card is required.');
  if (cards.length > LIMITS.maxCards) throw new Error('Too many cards.');

  var seen = {};
  var clean = cards.map(function (c, idx) {
    var card = validateCard_(c, idx);
    if (seen[card.id]) throw new Error('Duplicate card id: ' + card.id);
    seen[card.id] = true;
    return card;
  });

  var sh = getSheet_(SHEET_CARDS, CARD_HEADERS);
  // Rewrite the whole cards table atomically (we hold the script lock here).
  sh.clearContents();
  sh.getRange(1, 1, 1, CARD_HEADERS.length).setValues([CARD_HEADERS]);
  if (clean.length) {
    sh.getRange(2, 1, clean.length, CARD_HEADERS.length).setValues(clean.map(cardToRow_));
  }
  return { ok: true, cards: readCards_() };
}

/* ------------------------------------------------------------------ storage */

function getBook_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    // Fallback for a standalone script not bound to a sheet: reuse/create one
    // whose id is remembered in Script Properties.
    var props = PropertiesService.getScriptProperties();
    var id = props.getProperty('SPREADSHEET_ID');
    if (id) {
      try { return SpreadsheetApp.openById(id); } catch (ignore) {}
    }
    ss = SpreadsheetApp.create('Credit Card Expense Tracker Data');
    props.setProperty('SPREADSHEET_ID', ss.getId());
  }
  return ss;
}

/**
 * Returns a sheet with the given header row, creating and initialising it (as
 * plain-text cells, so Sheets never auto-converts our ISO dates or ids) if it
 * does not yet exist. Seeds the Cards sheet with defaults on first creation.
 */
function getSheet_(name, headers) {
  var ss = getBook_();
  var sh = ss.getSheetByName(name);
  if (sh) return sh;

  sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, 200).setNumberFormat('@'); // header row as text
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  // Force the data columns to plain text too.
  sh.getRange(1, 1, sh.getMaxRows(), headers.length).setNumberFormat('@');
  sh.setFrozenRows(1);

  if (name === SHEET_CARDS) {
    sh.getRange(2, 1, DEFAULT_CARDS.length, CARD_HEADERS.length)
      .setValues(DEFAULT_CARDS.map(cardToRow_));
  }
  return sh;
}

function readTransactions_() {
  var sh = getSheet_(SHEET_TX, TX_HEADERS);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, TX_HEADERS.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === '') continue; // skip blank rows
    out.push(rowToTx_(values[i]));
  }
  return out;
}

function readCards_() {
  var sh = getSheet_(SHEET_CARDS, CARD_HEADERS);
  var last = sh.getLastRow();
  if (last < 2) {
    // Sheet exists but empty (e.g. someone cleared it) — reseed defaults.
    sh.getRange(2, 1, DEFAULT_CARDS.length, CARD_HEADERS.length)
      .setValues(DEFAULT_CARDS.map(cardToRow_));
    return DEFAULT_CARDS.map(function (c) { return cardToRow_(c); }).map(rowToCard_);
  }
  var values = sh.getRange(2, 1, last - 1, CARD_HEADERS.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === '') continue;
    out.push(rowToCard_(values[i]));
  }
  return out.length ? out : DEFAULT_CARDS.slice();
}

function findRowIndexById_(sh, id) {
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2; // 1-based, offset header
  }
  return -1;
}

/* ------------------------------------------------------------------ mapping */

function txToRow_(t) {
  return [
    t.id, t.date, t.amount, t.cardId, t.description,
    t.category, t.merchant, t.notes, t.isEmi ? 'true' : 'false',
    t.createdAt || '', t.updatedAt || ''
  ];
}

function rowToTx_(r) {
  return {
    id: String(r[0]),
    date: normalizeDate_(r[1]),
    amount: toNumber_(r[2], 0),
    cardId: String(r[3]),
    description: String(r[4] || ''),
    category: String(r[5] || ''),
    merchant: String(r[6] || ''),
    notes: String(r[7] || ''),
    isEmi: toBool_(r[8]),
    createdAt: normalizeStamp_(r[9]),
    updatedAt: normalizeStamp_(r[10])
  };
}

function cardToRow_(c) {
  return [c.id, c.name, c.last4 || '', c.billingDay, c.limit, c.color || ''];
}

function rowToCard_(r) {
  return {
    id: String(r[0]),
    name: String(r[1] || ''),
    last4: String(r[2] || ''),
    billingDay: clampInt_(toNumber_(r[3], 1), 1, 28),
    limit: Math.max(0, toNumber_(r[4], 0)),
    color: String(r[5] || '#0f766e')
  };
}

/* ------------------------------------------------------------------ validation */

function validateTransaction_(t, cards, opts) {
  if (!t || typeof t !== 'object') throw new Error('Missing transaction data.');

  var id = String(t.id || '').trim();
  if (!id) throw new Error('Transaction id is required.');
  if (id.length > 64) throw new Error('Transaction id is too long.');

  var amount = toNumber_(t.amount, NaN);
  if (!isFinite(amount) || amount <= 0) throw new Error('Amount must be a positive number.');
  if (amount > LIMITS.amountMax) throw new Error('Amount is unrealistically large.');
  amount = Math.round(amount * 100) / 100; // 2-decimal money precision

  var description = cleanText_(t.description, LIMITS.description);
  if (!description) throw new Error('Description is required.');

  var date = normalizeDate_(t.date);
  if (!isValidIsoDate_(date)) throw new Error('Date must be a real calendar date (YYYY-MM-DD).');

  var cardId = String(t.cardId || '').trim();
  if (!cardId) throw new Error('A card must be selected.');
  if (!cardExists_(cardId, cards)) throw new Error('The selected card does not exist.');

  return {
    id: id,
    amount: amount,
    description: description,
    cardId: cardId,
    date: date,
    category: cleanText_(t.category, LIMITS.category),
    merchant: cleanText_(t.merchant, LIMITS.merchant),
    notes: cleanText_(t.notes, LIMITS.notes),
    isEmi: toBool_(t.isEmi),
    createdAt: typeof t.createdAt === 'string' ? t.createdAt : ''
  };
}

function validateCard_(c, idx) {
  if (!c || typeof c !== 'object') throw new Error('Card ' + (idx + 1) + ' is malformed.');
  var id = String(c.id || '').trim() || ('card-' + (idx + 1));
  var name = cleanText_(c.name, LIMITS.cardName);
  if (!name) throw new Error('Each card needs a name.');

  var last4 = String(c.last4 || '').replace(/\D/g, '').slice(0, 4);

  return {
    id: id,
    name: name,
    last4: last4,
    billingDay: clampInt_(toNumber_(c.billingDay, 1), 1, 28),
    limit: Math.max(0, Math.round(toNumber_(c.limit, 0) * 100) / 100),
    color: sanitizeColor_(c.color)
  };
}

function assertId_(id) {
  id = String(id || '').trim();
  if (!id) throw new Error('An id is required.');
  if (id.length > 64) throw new Error('Invalid id.');
  return id;
}

function cardExists_(cardId, cards) {
  for (var i = 0; i < cards.length; i++) if (cards[i].id === cardId) return true;
  return false;
}

/* ------------------------------------------------------------------ helpers */

function parseBody_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw new Error('Empty request body.');
  }
  try {
    var parsed = JSON.parse(e.postData.contents);
    if (!parsed || typeof parsed !== 'object') throw new Error('bad');
    return parsed;
  } catch (err) {
    throw new Error('Request body was not valid JSON.');
  }
}

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function cleanText_(v, max) {
  var s = String(v == null ? '' : v)
    .replace(/[\x00-\x1F\x7F]/g, ' ') // strip control chars
    .replace(/\s+/g, ' ')
    .trim();
  if (max && s.length > max) s = s.slice(0, max);
  return s;
}

function toNumber_(v, fallback) {
  if (typeof v === 'number') return isFinite(v) ? v : fallback;
  var n = parseFloat(String(v).replace(/,/g, ''));
  return isFinite(n) ? n : fallback;
}

function toBool_(v) {
  if (v === true) return true;
  var s = String(v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

function clampInt_(n, lo, hi) {
  n = Math.round(toNumber_(n, lo));
  return Math.min(hi, Math.max(lo, n));
}

function sanitizeColor_(v) {
  var s = String(v || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s : '#0f766e';
}

function normalizeDate_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone() || 'UTC', 'yyyy-MM-dd');
  }
  return String(v || '').trim().slice(0, 10);
}

function normalizeStamp_(v) {
  if (v instanceof Date) return v.toISOString();
  return String(v || '');
}

function isValidIsoDate_(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  var parts = s.split('-');
  var y = +parts[0], m = +parts[1], d = +parts[2];
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  var dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/* ------------------------------------------------------------------ self-test */

/**
 * Optional: run this once from the Apps Script editor (Run -> selfTest) to
 * exercise the full add/update/delete/saveCards cycle against your live sheet.
 * It cleans up after itself. Check the execution log for the result.
 */
function selfTest() {
  var log = [];
  function assert(cond, msg) { if (!cond) throw new Error('SELFTEST FAILED: ' + msg); log.push('ok: ' + msg); }

  var cards = readCards_();
  assert(cards.length >= 1, 'cards seeded');
  var cardId = cards[0].id;

  var id = 'selftest-' + Date.now();
  var add = handleAdd_({ id: id, amount: '123.456', description: '  Test  ', cardId: cardId, date: '2026-08-28', category: 'Groceries', merchant: '', notes: '', isEmi: false });
  assert(add.ok, 'add ok');
  var mine = add.transactions.filter(function (t) { return t.id === id; })[0];
  assert(mine && mine.amount === 123.46, 'amount rounded to 2dp');
  assert(mine.description === 'Test', 'description trimmed');

  var dup = handleAdd_({ id: id, amount: 999, description: 'dup', cardId: cardId, date: '2026-08-28' });
  assert(dup.duplicate === true, 'duplicate id rejected');

  var upd = handleUpdate_({ id: id, amount: 200, description: 'Updated', cardId: cardId, date: '2026-08-29' });
  var mine2 = upd.transactions.filter(function (t) { return t.id === id; })[0];
  assert(mine2.amount === 200 && mine2.description === 'Updated', 'update applied');

  var badCaught = false;
  try { handleAdd_({ id: 'x', amount: -5, description: 'bad', cardId: cardId, date: '2026-08-28' }); }
  catch (e) { badCaught = true; }
  assert(badCaught, 'negative amount rejected');

  var badCard = false;
  try { handleAdd_({ id: 'y', amount: 5, description: 'bad', cardId: 'nope', date: '2026-08-28' }); }
  catch (e) { badCard = true; }
  assert(badCard, 'unknown card rejected');

  var del = handleDelete_(id);
  assert(del.transactions.filter(function (t) { return t.id === id; }).length === 0, 'delete removed row');

  Logger.log(log.join('\n'));
  return log.join('\n');
}
