
// index.js (ES Modules)
import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';

const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb' }));

// Optional: simple API key gate (set API_KEY in Railway vars)
const API_KEY = process.env.API_KEY;
app.use((req, res, next) => {
  if (!API_KEY) return next();                 // allow all if not configured
  const key = req.get('x-api-key');
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

console.log('DB VARS SNAPSHOT', {
  MYSQLHOST: process.env.MYSQLHOST,
  MYSQLUSER: process.env.MYSQLUSER,
  MYSQLDATABASE: process.env.MYSQLDATABASE,  // should NOT be undefined/empty
  MYSQLPORT: process.env.MYSQLPORT,
});

// ---- MySQL pool (Railway) ---------------------------------------------------
const pool = mysql.createPool({
  host: process.env.MYSQLHOST,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  port: Number(process.env.MYSQLPORT || 3306),
  ssl: { rejectUnauthorized: false }, // typical for Railway
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000
});

// ---- Helpers ----------------------------------------------------------------
/** Normalize to canonical '+<digits>' (e.g., '+ 1-264' -> '+1264') */
function normalizeCode(s) {
  const raw = String(s || '');
  const digits = raw.replace(/[^\d+]/g, '');   // keep '+' and digits
  if (!digits.startsWith('+')) {
    return '+' + digits.replace(/\D/g, '');
  }
  return '+' + digits.slice(1).replace(/\D/g, '');
}

// ---- Routes: root & health --------------------------------------------------
app.get('/', (_req, res) => res.send('API is running'));
app.get('/health', async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT 1 AS ok');
    return res.json({ ok: rows[0]?.ok === 1 });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});


// --- ITEMS: search the `item` table (fetch-only) ----------------------------
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


// ---- PHONE: regions from MySQL ---------------------------------------------
// Returns: { regions: [{ iso2, name, code, displayCode, min, max }] }
app.get('/phone/regions', async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        regionName              AS name,
        regionPhoneCode         AS phoneCode,
        minRegionPhoneLength    AS minLen,
        maxRegionPhoneLength    AS maxLen,
        countryFlag             AS iso2
      FROM phoneInfo
      WHERE countryFlag IS NOT NULL AND countryFlag <> ''
      ORDER BY name ASC
    `);

    const regions = rows.map(r => {
      const iso2 = String(r.iso2 || '').trim().toUpperCase();
      const displayCode = String(r.phoneCode ?? '').trim();
      const code = normalizeCode(displayCode);     // canonical '+<digits>'
      return {
        iso2,
        name: String(r.name || '').trim(),
        code,                                      // e.g. '+44'
        displayCode,                               // e.g. '+ 1-264'
        min: Number(r.minLen || 0),
        max: Number(r.maxLen || 0),
      };
    });

    return res.json({ regions });
  } catch (e) {
    console.error('Error in /phone/regions:', e);
    return res.status(500).json({ error: 'Failed to load regions' });
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

// ---- PHONE: validate local number against a region --------------------------
// Expects: { iso2: 'GB', local: '7123456789' }
// Returns: { valid: boolean, e164?: '+447123456789' }
app.post('/phone/validate', async (req, res) => {
  try {
    const iso2Req = String(req.body?.iso2 || '').trim().toUpperCase();
    const localRaw = String(req.body?.local || '');
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
    const minLen = Number(row.minLen || 0);
    const maxLen = Number(row.maxLen || 0);
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

// ---- Your existing data endpoints (unchanged; adjust names if needed) -------
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
    const { brand, channel, shopID } = req.query;
    const where = [];
    const params = [];
    if (brand)   { where.push('`brand` = ?');   params.push(brand); }
    if (channel) { where.push('`channel` = ?'); params.push(channel); }
    if (shopID)  { where.push('`shopID` = ?');  params.push(shopID); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `
      SELECT DISTINCT \`name\` AS name
      FROM \`item\`
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
    const data = rows.map(r => ({
      item: (r.item ?? '').toString().trim(),
      colors: (r.colors ?? '')
        .toString()
        .toLowerCase()
        .split(',')
        .map(s => s.trim())
        .filter(Boolean),
    })).filter(x => x.item.length > 0);
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
    if (brand)   { where.push('`brand` = ?');   params.push(brand); }
    if (channel) { where.push('`channel` = ?'); params.push(channel); }
    if (shopID)  { where.push('`shopID` = ?');  params.push(shopID); }
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
    const data = Array.from(byItem.entries()).map(([item, colorsStr]) => ({
      item,
      colors: colorsStr
        .toLowerCase()
        .split(',')
        .map(s => s.trim())
        .filter(Boolean),
    })).sort((a, b) => a.item.localeCompare(b.item));

    res.json({ items: data });
  } catch (e) {
    console.error('Error in /item-colors:', e);
    res.status(500).json({ error: 'Failed to load item colours' });
  }
});

app.post('/add', async (req, res) => {
  const { testing } = req.body || {};
  if (!testing) return res.status(400).json({ error: 'Field "testing" is required.' });
  try {
    const [result] = await pool.query('INSERT INTO testing (testing) VALUES (?)', [testing]);
    res.status(201).json({ id: result.insertId, testing });
  } catch (err) {
    console.error('Insert error:', err);
    res.status(500).json({ error: 'Database insert failed.' });
  }
});

// POST /signup
app.post('/signup', async (req, res) => {
  try {
    const {
      username,
      email,
      password,              // store hashed!
      phone_country_code,    // e.g., "852"
      phone_number,          // e.g., "12345678"
      q1, a1, q2, a2, q3, a3
    } = req.body;

    // 1) Basic validation
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Weak or missing password' });
    }

    // Accept any one identifier. If none provided, derive one from phone.
    let finalUsername = username ?? null;
    const finalEmail = email ?? null;

    if (!finalUsername && !finalEmail && phone_country_code && phone_number) {
      // generate a safe username from phone
      finalUsername = `u_${phone_country_code}_${phone_number}`;
    }

    if (!finalUsername && !finalEmail) {
      return res.status(400).json({ error: 'Provide username, email, or phone' });
    }

    // 2) Hash password (very important in production)
    const hashed = await bcrypt.hash(password, 10);

    // 3) Build INSERT. Example table columns:
    // id (PK, auto), username (NULL ok), email (NULL ok),
    // password_hash, phone_country_code, phone_number,
    // q1,a1,q2,a2,q3,a3, created_at
    const sql = `
      INSERT INTO loginTable
        (username, email, password_hash, phone_country_code, phone_number,
         q1, a1, q2, a2, q3, a3, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
    `;

    const params = [
      finalUsername,
      finalEmail,
      hashed,
      phone_country_code ?? null,
      phone_number ?? null,
      q1 ?? null, a1 ?? null,
      q2 ?? null, a2 ?? null,
      q3 ?? null, a3 ?? null
    ];

    const [result] = await db.execute(sql, params);
    // mysql2 returns insertId for AUTOINCREMENT PK
    return res.status(201).json({ userID: result.insertId });
  } catch (err) {
    console.error('Signup error:', err); // <-- keep this to see real error cause
    return res.status(500).json({ error: 'Server error' });
  }
});


// ---- Start server -----------------------------------------------------------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
