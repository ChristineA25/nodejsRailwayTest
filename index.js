
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
    if (brand)   { where.push('`brand` = ?');   params.push(brand); }
    if (channel) { where.push('`channel` = ?'); params.push(channel); }
    if (shopID)  { where.push('`shopID` = ?');  params.push(shopID); }
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

// ---- Start server -----------------------------------------------------------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
