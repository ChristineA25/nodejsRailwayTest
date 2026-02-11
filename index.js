
// index.js (CommonJS) — single server entry
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const { pool, pingDB } = require('./db');

const app = express();

// ---------- middleware ----------
app.use(cors());
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- optional API key gate ----------
const API_KEY = process.env.API_KEY;
app.use((req, res, next) => {
  if (!API_KEY) return next(); // allow all if not configured
  const key = req.get('x-api-key');
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// ---------- root & health ----------
app.get('/', (_req, res) => res.send('API is running'));
app.get('/health', async (_req, res) => {
  try {
    const ok = await pingDB();
    return res.json({ ok });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- helpers ----------
/** Normalize to canonical '+<digits>' (e.g., '+ 1-264' -> '+1264') */
function normalizeCode(s) {
  const raw = String(s ?? '');
  const digits = raw.replace(/[^\d+]/g, ''); // keep '+' and digits
  if (!digits.startsWith('+')) {
    return '+' + digits.replace(/\D/g, '');
  }
  return '+' + digits.slice(1).replace(/\D/g, '');
}

// Small crypto helpers (AES-256-GCM) for field-level encryption of PII
function getFieldKey() {
  const b64 = process.env.FIELD_ENC_KEY || '';
  const key = Buffer.from(b64, 'base64'); // must decode to 32 bytes
  if (key.length !== 32) {
    throw new Error('FIELD_ENC_KEY must be a base64-encoded 32-byte key (AES-256)');
  }
  return key;
}
function encryptField(plain) {
  if (plain == null) return null;
  const key = getFieldKey();
  const iv = crypto.randomBytes(12); // GCM nonce
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Store as iv:tag:ciphertext (base64)
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

// ============================================================================
// PHONE: regions from MySQL (preserving your mapping)
// ============================================================================
app.get('/phone/regions', async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        regionName AS name,
        regionPhoneCode AS phoneCode,
        minRegionPhoneLength AS minLen,
        maxRegionPhoneLength AS maxLen,
        countryFlag AS iso2
      FROM phoneInfo
      WHERE countryFlag IS NOT NULL AND countryFlag <> ''
      ORDER BY name ASC
    `);
    const regions = rows.map(r => {
      const iso2 = String(r.iso2 ?? '').trim().toUpperCase();
      const displayCode = String(r.phoneCode ?? '').trim();
      const code = normalizeCode(displayCode); // canonical '+<digits>'
      return {
        iso2,
        name: String(r.name ?? '').trim(),
        code,        // e.g. '+44'
        displayCode, // e.g. '+ 1-264'
        min: Number(r.minLen ?? 0),
        max: Number(r.maxLen ?? 0),
      };
    });
    return res.json({ regions });
  } catch (e) {
    console.error('Error in /phone/regions:', e);
    return res.status(500).json({ error: 'Failed to load regions' });
  }
});

// Validate local phone number for a region; return E.164 if valid
app.post('/phone/validate', async (req, res) => {
  try {
    const iso2Req = String(req.body?.iso2 ?? '').trim().toUpperCase();
    const localRaw = String(req.body?.local ?? '');
    const localDigits = localRaw.replace(/\D/g, '');
    if (!iso2Req || !localDigits) return res.json({ valid: false });

    const [rows] = await pool.query(
      `SELECT regionPhoneCode AS phoneCode,
              minRegionPhoneLength AS minLen,
              maxRegionPhoneLength AS maxLen
       FROM phoneInfo
       WHERE UPPER(countryFlag) = ? LIMIT 1`,
      [iso2Req]
    );
    if (!rows || rows.length === 0) return res.json({ valid: false });

    const row = rows[0];
    const minLen = Number(row.minLen ?? 0);
    const maxLen = Number(row.maxLen ?? 0);
    if (localDigits.length < minLen || localDigits.length > maxLen) {
      return res.json({ valid: false });
    }
    const canonCode = normalizeCode(row.phoneCode); // '+44', '+1264', etc.
    const e164 = `${canonCode}${localDigits}`;
    return res.json({ valid: true, e164 });
  } catch (e) {
    console.error('Error in /phone/validate:', e);
    return res.json({ valid: false });
  }
});

// ============================================================================
// SHOPS / BRANDS / ITEMS / COLORS
// ============================================================================
app.get('/shops', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT DISTINCT `shopName` AS name FROM `chainShop` ORDER BY `shopName` ASC'
    );
    const shops = rows.map(r => (r.name ?? '').toString().trim()).filter(Boolean);
    res.json({ shops });
  } catch (e) {
    console.error('Error in /shops:', e);
    res.status(500).json({ error: 'Failed to load shops' });
  }
});

app.get('/brands', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT DISTINCT `brand` AS name FROM `prices` WHERE `brand` IS NOT NULL AND `brand` <> "" ORDER BY `brand` ASC'
    );
    const brands = rows.map(r => (r.name ?? '').toString().trim()).filter(Boolean);
    res.json({ brands });
  } catch (e) {
    console.error('Error in /brands:', e);
    res.status(500).json({ error: 'Failed to load brands' });
  }
});

app.get('/items', async (req, res) => {
  try {
    const { brand, channel, shopID } = req.query;
    const where = [];
    const params = [];
    if (brand) { where.push('`brand` = ?'); params.push(brand); }
    if (channel) { where.push('`channel` = ?'); params.push(channel); }
    if (shopID) { where.push('`shopID` = ?'); params.push(shopID); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `
      SELECT DISTINCT \`item\` AS name
      FROM \`prices\`
      ${whereSql}
      ORDER BY \`item\` ASC
    `;
    const [rows] = await pool.query(sql, params);
    const items = rows.map(r => (r.name ?? '').toString().trim()).filter(Boolean);
    res.json({ items });
  } catch (e) {
    console.error('Error in /items:', e);
    res.status(500).json({ error: 'Failed to load items' });
  }
});

app.get('/items-textless', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT DISTINCT `item` AS name FROM `itemColor4` WHERE `item` IS NOT NULL AND `item` <> "" ORDER BY `item` ASC'
    );
    const items = rows.map(r => (r.name ?? '').toString().trim()).filter(Boolean);
    res.json({ items });
  } catch (e) {
    console.error('Error in /items-textless:', e);
    res.status(500).json({ error: 'Failed to load textless items' });
  }
});

app.get('/item-colors-textless', async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT \`item\` AS item, \`color\` AS colors
      FROM \`itemColor4\`
      WHERE \`item\` IS NOT NULL AND \`item\` <> ""
    `);
    const data = rows
      .map(r => ({
        item: (r.item ?? '').toString().trim(),
        colors: (r.colors ?? '')
          .toString()
          .toLowerCase()
          .split(',')
          .map(s => s.trim())
          .filter(Boolean),
      }))
      .filter(x => x.item.length > 0);
    res.json({ items: data });
  } catch (e) {
    console.error('Error in /item-colors-textless:', e);
    res.status(500).json({ error: 'Failed to load textless item colours' });
  }
});

app.get('/item-colors', async (req, res) => {
  try {
    const { brand, channel, shopID } = req.query;
    const where = [];
    const params = [];
    if (brand) { where.push('`brand` = ?'); params.push(brand); }
    if (channel) { where.push('`channel` = ?'); params.push(channel); }
    if (shopID) { where.push('`shopID` = ?'); params.push(shopID); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(`
      SELECT \`item\` AS item, \`productColor\` AS colors
      FROM \`prices\`
      ${whereSql}
    `, params);

    const byItem = new Map();
    for (const r of rows) {
      const item = (r.item ?? '').toString().trim();
      const colorsStr = (r.colors ?? '').toString().trim();
      if (!item || !colorsStr) continue;
      const existing = byItem.get(item) ?? '';
      if (colorsStr.length > existing.length) byItem.set(item, colorsStr);
    }
    const data = Array.from(byItem.entries())
      .map(([item, colorsStr]) => ({
        item,
        colors: colorsStr.toLowerCase().split(',').map(s => s.trim()).filter(Boolean),
      }))
      .sort((a, b) => a.item.localeCompare(b.item));
    res.json({ items: data });
  } catch (e) {
    console.error('Error in /item-colors:', e);
    res.status(500).json({ error: 'Failed to load item colours' });
  }
});

// ============================================================================
// TEST insert
// ============================================================================
app.post('/add', async (req, res) => {
  const { testing } = req.body ?? {};
  if (!testing) return res.status(400).json({ error: 'Field "testing" is required.' });
  try {
    const [result] = await pool.query('INSERT INTO testing (testing) VALUES (?)', [testing]);
    res.status(201).json({ id: result.insertId, testing });
  } catch (err) {
    console.error('Insert error:', err);
    res.status(500).json({ error: 'Database insert failed.' });
  }
});

// ============================================================================
// SIGNUP — client supplies userID (from Flutter). Hash password; encrypt PII.
// ============================================================================
/**
 * Expected JSON (one of username/email/phone required):
 * {
 *   "userID": "client-supplied id",
 *   "identifierType": "username" | "email" | "phone",
 *   "username": "chris",                // when identifierType = username
 *   "email": "me@example.com",          // when identifierType = email
 *   "phone_country_code": "+44",        // when identifierType = phone
 *   "phone_number": "7123456789",       // digits only (no spaces)
 *   "password": "Passw0rd!123",
 *   "secuQuestion1": "...", "secuAns1": "...",
 *   "secuQuestion2": "...", "secuAns2": "...",
 *   "secuQuestion3": "...", "secuAns3": "..."
 * }
 */
app.post('/api/signup', async (req, res) => {
  try {
    const {
      userID,
      identifierType,
      username,
      email,
      phone_country_code,
      phone_number, // local digits only
      password,
      secuQuestion1, secuAns1,
      secuQuestion2, secuAns2,
      secuQuestion3, secuAns3,
    } = req.body || {};

    if (!userID && userID !== 0) {
      return res.status(400).json({ error: 'userID_required' });
    }
    if (!password) {
      return res.status(400).json({ error: 'password_required' });
    }
    if (!identifierType || !['username', 'email', 'phone'].includes(String(identifierType))) {
      return res.status(400).json({ error: 'identifierType_invalid' });
    }

    // mode-specific validation & preparation
    let usernameToStore = null;
    let emailEnc = null;
    let phoneCodeToStore = null;
    let phoneLocalEnc = null;

    if (identifierType === 'username') {
      if (!username) return res.status(400).json({ error: 'username_required' });
      usernameToStore = String(username);
    } else if (identifierType === 'email') {
      if (!email) return res.status(400).json({ error: 'email_required' });
      emailEnc = encryptField(String(email).trim());
    } else if (identifierType === 'phone') {
      if (!phone_country_code) return res.status(400).json({ error: 'phone_country_code_required' });
      if (!phone_number || !/^\d{1,20}$/.test(String(phone_number))) {
        return res.status(400).json({ error: 'phone_number_digits_only' });
      }
      phoneCodeToStore = String(phone_country_code).trim();       // store plain code
      phoneLocalEnc = encryptField(String(phone_number).trim());  // encrypt local digits
    }

    // hash password
    const hashed = await bcrypt.hash(String(password), 12);

    // insert
    const sql = `
      INSERT INTO loginTable
        (userID, username, password, email, phone_country_code, phone_number,
         secuQuestion1, secuAns1, secuQuestion2, secuAns2, secuQuestion3, secuAns3)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const params = [
      userID,
      usernameToStore,
      hashed,
      emailEnc,
      phoneCodeToStore,
      phoneLocalEnc,
      secuQuestion1 ?? null, secuAns1 ?? null,
      secuQuestion2 ?? null, secuAns2 ?? null,
      secuQuestion3 ?? null, secuAns3 ?? null,
    ];

    await pool.execute(sql, params);
    return res.status(201).json({ userID });
  } catch (err) {
    const code = err && err.code ? err.code : null;
    if (code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'duplicate_identifier' });
    }
    console.error('signup error:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// ---------- 404 fallback ----------
app.use((req, res) => {
  const fallback404 = path.join(__dirname, 'views', '404.html');
  res.status(404).sendFile(fallback404, (sendErr) => {
    if (sendErr) {
      res.status(404).type('text').send('404 – Not Found');
    }
  });
});

// ---------- start server ----------
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server listening on http://0.0.0.0:${PORT}`);
});
