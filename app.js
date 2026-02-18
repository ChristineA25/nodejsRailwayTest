
// app.js
'use strict';

// Only load .env during local development
if (process.env.NODE_ENV !== 'production') {
  try { require('dotenv').config(); } catch (_) {}
}

const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { pool } = require('./db'); // make sure ./db exports { pool }

const app = express();
app.use(express.json({ limit: '256kb' }));

/* ------------------------------------------------------------------ */
/*                          Key Management                             */
/* ------------------------------------------------------------------ */
function loadKeyFromEnv(envName, expectedLen) {
  const b64 = process.env[envName];
  if (!b64) throw new Error(`${envName}_missing`);
  const buf = Buffer.from(b64, 'base64');
  if (buf.length !== expectedLen) {
    throw new Error(`${envName}_must_be_${expectedLen}_bytes_base64`);
  }
  return buf;
}

let DET_KEY = null;
try {
  DET_KEY = loadKeyFromEnv('DETERMINISTIC_KEY', 32);
} catch (e) {
  console.warn('⚠️ Key load warning:', e.message);
}

/* ------------------------------------------------------------------ */
/*                   Deterministic Tokenization                        */
/* ------------------------------------------------------------------ */
function detTokenBase64(plain) {
  if (plain === null || plain === undefined) return null;
  if (!DET_KEY) throw new Error('DETERMINISTIC_KEY_missing');
  return crypto
    .createHmac('sha256', DET_KEY) // ✅ use the loaded key
    .update(String(plain), 'utf8')
    .digest('base64');
}

/* ------------------------------------------------------------------ */
/*                        Email Normalization                          */
/* ------------------------------------------------------------------ */
function normalizeEmail(email) {
  if (!email) return null;
  return String(email).trim().toLowerCase();
}

/* ------------------------------------------------------------------ */
/*                        Build E164                                   */
/* ------------------------------------------------------------------ */
function buildE164({ phoneE164, phone_country_code, phone_number }) {
  const isValidE164 = (v) => typeof v === 'string' && /^\+\d{6,15}$/.test(v);

  if (isValidE164(phoneE164)) return phoneE164;

  const ccRaw = (phone_country_code || '').toString().trim();
  const localRaw = (phone_number || '').toString().trim();

  if (!ccRaw.startsWith('+')) throw new Error('invalid_country_code');

  const ccDigits = ccRaw.replace(/[^\d]/g, '');
  const localDigits = localRaw.replace(/\D+/g, '');

  const combined = `+${ccDigits}${localDigits}`;
  if (!isValidE164(combined)) throw new Error('invalid_e164_combination');

  return combined;
}

/* ------------------------------------------------------------------ */
/*                          Health & Static                            */
/* ------------------------------------------------------------------ */
app.get('/health', (req, res) => res.status(200).send('ok'));
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ */
/*                         Items Endpoints                             */
/* ------------------------------------------------------------------ */

// NOTE: If you truly have ./routes/items, keep it; otherwise comment this out
try {
  const itemsRouter = require('./routes/items'); // optional
  app.use('/api/items', itemsRouter);
} catch (e) {
  // optional file, ignore if missing
}

// POST /api/items/batchByIds   (keep one definition only)
app.post('/api/items/batchByIds', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];
    if (ids.length === 0) return res.json({ items: [] });

    const placeholders = ids.map(() => '?').join(', ');
    const sql = `
      SELECT id, name, brand, quantity, feature, productColor, picWebsite
      FROM item
      WHERE id IN (${placeholders})
    `;
    const [rows] = await pool.execute(sql, ids);
    res.json({ items: rows });
  } catch (err) {
    console.error('POST /api/items/batchByIds error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

/* ------------------------------------------------------------------ */
/*                             API: Signup                             */
/* ------------------------------------------------------------------ */
app.post('/api/signup', async (req, res) => {
  try {
    const {
      userID,
      identifierType,
      username, password, email,
      phone_country_code, phone_number, phoneE164,
      secuQuestion1, secuAns1, secuQuestion2, secuAns2, secuQuestion3, secuAns3
    } = req.body || {};

    if (!userID) return res.status(400).json({ error: 'userID_required' });
    if (!password) return res.status(400).json({ error: 'password_required' });

    if (identifierType === 'username' && !username) {
      return res.status(400).json({ error: 'username_required' });
    }
    if (identifierType === 'email' && !email) {
      return res.status(400).json({ error: 'email_required' });
    }
    if (identifierType === 'phone' && !phone_number && !phoneE164) {
      return res.status(400).json({ error: 'phone_number_required' });
    }

    const passwordHash = await bcrypt.hash(String(password), 12);

    // email & phone tokenization
    let emailEnc = null;
    let phoneEnc = null;
    let phoneE164Final = null;

    try {
      if (email) {
        const normEmail = normalizeEmail(email);
        emailEnc = normEmail ? detTokenBase64(normEmail) : null;
      }

      if (identifierType === 'phone' || phoneE164) {
        phoneE164Final = buildE164({
          phoneE164,
          phone_country_code,
          phone_number,
        });
        phoneEnc = detTokenBase64(phoneE164Final);
      }
    } catch (errTok) {
      return res.status(500).json({ error: errTok.message || 'tokenization_failed' });
    }

    // ⚠️ Ensure your loginTable column names match:
    // Using `password_hash` is recommended; adjust if your schema is `password`.
    const sql = `
      INSERT INTO loginTable
        (userID, username, password_hash, phone_country_code,
         secuQuestion1, secuAns1, secuQuestion2, secuAns2, secuQuestion3, secuAns3,
         email_enc, phone_number_enc, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
    `;

    const params = [
      userID,
      username ?? null,
      passwordHash,
      phone_country_code ?? null,
      secuQuestion1 ?? null,
      secuAns1 ?? null,
      secuQuestion2 ?? null,
      secuAns2 ?? null,
      secuQuestion3 ?? null,
      secuAns3 ?? null,
      emailEnc,
      phoneEnc
    ];

    await pool.execute(sql, params);
    return res.status(201).json({ userID });

  } catch (err) {
    const msg = err?.message || 'unknown_error';
    const code = err?.code || null;

    if (code === 'ER_DUP_ENTRY') {
      const raw = (err.sqlMessage || err.message || '').toLowerCase();
      let field = 'identifier';

      if (raw.includes('email_enc')) field = 'email';
      else if (raw.includes('phone_number_enc')) field = 'phone';
      else if (raw.includes('username')) field = 'username';
      else if (raw.includes('secuans1') || raw.includes('secuans2') || raw.includes('secuans3')) field = 'security answer';

      return res.status(409).json({
        error: 'duplicate_identifier',
        field,
        message: `${field} already in use. Please use another.`
      });
    }

    return res.status(500).json({ error: msg });
  }
});

/* ------------------------------------------------------------------ */
/*                           Brands/Items                              */
/* ------------------------------------------------------------------ */
app.get('/brands', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT DISTINCT `brand` AS name FROM `item` WHERE `brand` IS NOT NULL AND `brand` <> "" ORDER BY `brand` ASC'
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
    const { brand } = req.query;
    const where = [];
    const params = [];
    if (brand) { where.push('`brand` = ?'); params.push(brand); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `
      SELECT DISTINCT \`name\` AS name
      FROM \`item\`
      ${whereSql}
      ORDER BY \`name\` ASC
    `;
    const [rows] = await pool.query(sql, params);
    const items = rows.map(r => (r.name ?? '').toString().trim()).filter(Boolean);
    res.json({ items });
  } catch (e) {
    console.error('Error in /items:', e);
    res.status(500).json({ error: 'Failed to load items' });
  }
});

/* ------------------------------------------------------------------ */
/*                       Item Colours from `item`                      */
/* ------------------------------------------------------------------ */
app.get('/item-colors', async (req, res) => {
  try {
    const { brand } = req.query;
    const where = [];
    const params = [];
    if (brand) { where.push('`brand` = ?'); params.push(brand); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(`
      SELECT \`name\` AS item, \`productColor\` AS colors
      FROM \`item\`
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

/* ------------------------------------------------------------------ */
/*                           Allergens                                 */
/* ------------------------------------------------------------------ */
app.get('/api/allergens', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT allergenCommonName AS name
         FROM commonAllergen
        WHERE allergenCommonName IS NOT NULL
          AND allergenCommonName <> ''
        ORDER BY allergenCommonName ASC`
    );
    const items = rows.map(r => (r.name ?? '').toString().trim()).filter(Boolean);
    res.json({ items });
  } catch (e) {
    console.error('Error in /api/allergens:', e);
    res.status(500).json({ error: 'allergens_fetch_failed' });
  }
});

/* ------------------------------------------------------------------ */
/*                     Phone: regions + validate                       */
/* ------------------------------------------------------------------ */
function normalizeCode(s) {
  const raw = String(s ?? '');
  const digits = raw.replace(/[^\d+]/g, ''); // keep '+' and digits
  if (!digits.startsWith('+')) return '+' + digits.replace(/\D/g, '');
  return '+' + digits.slice(1).replace(/\D/g, '');
}

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
      const code = normalizeCode(displayCode);
      return {
        iso2,
        name: String(r.name ?? '').trim(),
        code,        // '+44'
        displayCode, // '+ 1-264'
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
    const canonCode = normalizeCode(row.phoneCode);
    const e164 = `${canonCode}${localDigits}`;
    return res.json({ valid: true, e164 });
  } catch (e) {
    console.error('Error in /phone/validate:', e);
    return res.json({ valid: false });
  }
});

/* ------------------------------------------------------------------ */
/*                         UK Locations                                */
/* ------------------------------------------------------------------ */
app.get('/api/counties', async (_req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT DISTINCT county
         FROM gbrPostcodeNameSake
        WHERE county IS NOT NULL AND county <> ''
        ORDER BY county ASC`
    );
    res.json({ items: rows.map(r => r.county) });
  } catch (e) {
    res.status(500).json({ error: 'counties_fetch_failed' });
  }
});

app.get('/api/districts', async (req, res) => {
  try {
    const { county } = req.query;
    if (!county) return res.status(400).json({ error: 'county_required' });
    const [rows] = await pool.execute(
      `SELECT DISTINCT district
         FROM gbrPostcodeNameSake
        WHERE county = ? AND district IS NOT NULL AND district <> ''
        ORDER BY district ASC`,
      [county]
    );
    res.json({ items: rows.map(r => r.district) });
  } catch (e) {
    res.status(500).json({ error: 'districts_fetch_failed' });
  }
});

app.get('/api/postcodes', async (req, res) => {
  try {
    const { county, district } = req.query;
    if (!county) return res.status(400).json({ error: 'county_required' });
    if (!district) return res.status(400).json({ error: 'district_required' });
    const [rows] = await pool.execute(
      `SELECT DISTINCT postcode
         FROM gbrPostcodeNameSake
        WHERE county = ? AND district = ? AND postcode IS NOT NULL AND postcode <> ''
        ORDER BY postcode ASC`,
      [county, district]
    );
    res.json({ items: rows.map(r => r.postcode) });
  } catch (e) {
    res.status(500).json({ error: 'postcodes_fetch_failed' });
  }
});

/* ------------------------------------------------------------------ */
/*                         Test Insert                                 */
/* ------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------ */
/*                     Optional index router mount                     */
/* ------------------------------------------------------------------ */
try {
  const indexRouter = require('./routes/index'); // optional router
  app.use('/', indexRouter);
} catch (err) {
  // fine if you don't have it
}

/* ------------------------------------------------------------------ */
/*                           404 fallback                              */
/* ------------------------------------------------------------------ */
app.use((req, res) => {
  const fallback404 = path.join(__dirname, 'views', '404.html');
  res.status(404).sendFile(fallback404, (err) => {
    if (err) res.status(404).type('text').send('404 – Not Found');
  });
});

module.exports = app; // ✅ Export app; do not listen here
