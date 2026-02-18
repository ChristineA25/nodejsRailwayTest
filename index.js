
// index.js (ESM)
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import { pool, pingDB } from './db.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb' }));

// Optional: simple API key gate (set API_KEY in Railway Variables)
const API_KEY = process.env.API_KEY;
app.use((req, res, next) => {
  if (!API_KEY) return next(); // allow all if not configured
  const key = req.get('x-api-key');
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// Root & health
app.get('/', (_req, res) => res.send('API is running'));
app.get('/health', async (_req, res) => {
  try {
    const ok = await pingDB();
    return res.json({ ok });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/** Normalize to canonical '+<digits>' (e.g., '+ 1-264' -> '+1264') */
function normalizeCode(s) {
  const raw = String(s ?? '');
  const digits = raw.replace(/[^\d+]/g, ''); // keep '+' and digits
  if (!digits.startsWith('+')) {
    return '+' + digits.replace(/\D/g, '');
  }
  return '+' + digits.slice(1).replace(/\D/g, '');
}


// --- ITEMS: search the `item` table (fetch-only) ----------------------------
// GET /api/items/search?q=...&field=all|name|brand|quantity|feature|productcolor&limit=50
app.get('/api/items/search', async (req, res) => {
  try {
    const q = String(req.query.q ?? '').trim();
    const field = String(req.query.field ?? 'all').toLowerCase();
    const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 100);

    const allow = new Set(['all','name','brand','quantity','feature','productcolor']);
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


// --- ALLERGENS: distinct common names ---
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

// --- PHONE: regions from MySQL (preserving your query & mapping) ---
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
        code,          // e.g. '+44'
        displayCode,   // e.g. '+ 1-264'
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


// --- Location lookups: counties, districts, postcodes ---
app.get('/api/counties', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT DISTINCT county FROM gbrPostcodeNameSake WHERE county IS NOT NULL AND county <> '' ORDER BY county ASC`
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
    if (!county)   return res.status(400).json({ error: 'county_required' });
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

// --- PHONE: validate local number against a region ---
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

// --- SHOPS / BRANDS / ITEMS / COLORS (kept from your file) ---
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

// --- Simple test insert (unchanged) ---
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

// --- SIGNUP (fixed) ---
app.post('/signup', async (req, res) => {
  try {
    const {
      username,
      email,
      password,            // from Flutter client
      phone_country_code,  // digits only, e.g. "678"
      phone_number,        // digits only
      q1, a1, q2, a2, q3, a3,
    } = req.body;

    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Weak or missing password' });
    }

    // Allow any one identifier; if none given, derive from phone
    let finalUsername = username ?? null;
    const finalEmail = email ?? null;
    if (!finalUsername && !finalEmail && phone_country_code && phone_number) {
      finalUsername = `u_${phone_country_code}_${phone_number}`;
    }
    if (!finalUsername && !finalEmail) {
      return res.status(400).json({ error: 'Provide username, email, or phone' });
    }

    // Hash password (bcryptjs)
    const hashed = await bcrypt.hash(password, 10);

    // Insert into loginTable (store hashed in 'password' column)
    const sql = `
      INSERT INTO loginTable
        (username, password, email, phone_country_code, phone_number, secuQuestion1, secuAns1, secuQuestion2, secuAns2, secuQuestion3, secuAns3)
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
    console.error('Signup error:', err); // keep for diagnostics
    return res.status(500).json({ error: 'Server error' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
