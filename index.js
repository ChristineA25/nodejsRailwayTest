
// index.js (ESM) — single server, new schema ready
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import { pool, pingDB } from './db.js'; // see db.js below

const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb' }));

const routes = require('./routes');
app.use('/', routes);

// Optional: simple API key gate (Railway variable API_KEY)
const API_KEY = process.env.API_KEY;
app.use((req, res, next) => {
  if (!API_KEY) return next();
  const key = req.get('x-api-key');
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
/** Normalize to canonical '+<digits>' (e.g., '+ 1-264' -> '+1264') */
function normalizeCode(s) {
  const raw = String(s ?? '');
  const digits = raw.replace(/[^\d+]/g, ''); // keep '+' and digits
  if (!digits.startsWith('+')) {
    return '+' + digits.replace(/\D/g, '');
  }
  return '+' + digits.slice(1).replace(/\D/g, '');
}

// ----------------------------------------------------------------------------
// Root & Health
// ----------------------------------------------------------------------------
app.get('/', (_req, res) => res.send('API is running'));
app.get('/health', async (_req, res) => {
  try {
    const ok = await pingDB();
    return res.json({ ok });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ----------------------------------------------------------------------------
// ITEMS: search the `item` table (fetch-only)
// GET /api/items/search?q=&field=all|name|brand|quantity|feature|productcolor&limit=50
// ----------------------------------------------------------------------------
app.get('/api/items/search', async (req, res) => {
  try {
    const q = String(req.query.q ?? '').trim();
    const field = String(req.query.field ?? 'all').toLowerCase();
    const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 100);

    const allow = new Set(['all', 'name', 'brand', 'quantity', 'feature', 'productcolor']);
    if (!allow.has(field)) return res.status(400).json({ error: 'invalid_field' });

    const where = [];
    const params = [];
    if (q) {
      const like = `%${q}%`;
      if (field === 'all') {
        where.push(`(name LIKE ? OR brand LIKE ? OR quantity LIKE ? OR feature LIKE ? OR productColor LIKE ?)`);
        params.push(like, like, like, like, like);
      } else if (field === 'productcolor') {
        where.push(`productColor LIKE ?`);
        params.push(like);
      } else {
        where.push(`${field} LIKE ?`);
        params.push(like);
      }
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `
      SELECT id, name, brand, quantity, feature, productColor, picWebsite
      FROM item
      ${whereSql}
      ORDER BY name ASC, brand ASC
      LIMIT ?
    `;
    params.push(limit);

    const [rows] = await pool.query(sql, params);
    const items = rows.map(r => ({
      id: String(r.id ?? ''),
      name: String(r.name ?? ''),
      brand: String(r.brand ?? ''),
      quantity: String(r.quantity ?? ''),
      feature: String(r.feature ?? ''),
      productColor: String(r.productColor ?? ''),
      picWebsite: String(r.picWebsite ?? ''),
    }));
    return res.json({ items });
  } catch (e) {
    console.error('Error in /api/items/search:', e);
    return res.status(500).json({ error: 'items_search_failed' });
  }
});

// ----------------------------------------------------------------------------
// Batch fetch by IDs (from `item`) — POST /api/items/batchByIds
// body: { ids: ["<id1>", "<id2>", ...] }
// ----------------------------------------------------------------------------
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

// ----------------------------------------------------------------------------
// BRANDS / ITEMS (for dropdowns) — now reading from `item`
// ----------------------------------------------------------------------------
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

// ----------------------------------------------------------------------------
// Item colors (from `item.productColor`), optionally filter by brand
// ----------------------------------------------------------------------------
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

    // Deduplicate by item, keep the longest colors string per item
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

// ----------------------------------------------------------------------------
// Allergens (unchanged) — still from commonAllergen
// ----------------------------------------------------------------------------
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

// ----------------------------------------------------------------------------
// Phone: regions + validate (unchanged tables: phoneInfo)
// ----------------------------------------------------------------------------
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

// ----------------------------------------------------------------------------
// UK Location lookups (unchanged tables: gbrPostcodeNameSake)
// ----------------------------------------------------------------------------
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

// ----------------------------------------------------------------------------
// Simple test insert (unchanged)
// ----------------------------------------------------------------------------
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

// ----------------------------------------------------------------------------
// Signup (kept minimal; adjust to your schema if needed)
// ----------------------------------------------------------------------------
app.post('/signup', async (req, res) => {
  try {
    const {
      username,
      email,
      password,            // from Flutter client
      phone_country_code,  // digits only, e.g., "852"
      phone_number,        // digits only
      q1, a1, q2, a2, q3, a3,
    } = req.body;

    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Weak or missing password' });
    }

    // Allow any one identifier; derive username from phone if none provided
    let finalUsername = username ?? null;
    const finalEmail = email ?? null;
    if (!finalUsername && !finalEmail && phone_country_code && phone_number) {
      finalUsername = `u_${phone_country_code}_${phone_number}`;
    }
    if (!finalUsername && !finalEmail) {
      return res.status(400).json({ error: 'Provide username, email, or phone' });
    }

    const hashed = await bcrypt.hash(password, 10);

    const sql = `
      INSERT INTO loginTable
        (username, password, email, phone_country_code, phone_number,
         secuQuestion1, secuAns1, secuQuestion2, secuAns2, secuQuestion3, secuAns3)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const params = [
      finalUsername,
      hashed,
      finalEmail,
      phone_country_code ?? null,
      phone_number ?? null,
      q1 ?? null, a1 ?? null,
      q2 ?? null, a2 ?? null,
      q3 ?? null, a3 ?? null,
    ];

    const [result] = await pool.query(sql, params);
    return res.status(201).json({ userID: result.insertId });
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Identifier already exists' });
    }
    console.error('Signup error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ----------------------------------------------------------------------------
// Start server (single instance only)
// ----------------------------------------------------------------------------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
