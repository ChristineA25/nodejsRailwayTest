
// index.js
import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';

const app = express();
app.use(cors());
app.use(express.json());

// Optional: simple API key gate (set API_KEY in Railway vars)
const API_KEY = process.env.API_KEY;
app.use((req, res, next) => {
  if (!API_KEY) return next();                  // if not set, allow all
  const key = req.get('x-api-key');
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// Create a MySQL pool using Railway-provided env vars
const pool = mysql.createPool({
  host: process.env.MYSQLHOST,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  port: Number(process.env.MYSQLPORT || 3306),
  ssl: { rejectUnauthorized: false },          // common for Railway
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000
});

// Root & health
app.get('/', (req, res) => res.send('API is running'));
app.get('/health', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT 1 AS ok');
    res.json({ ok: rows[0].ok === 1 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ✅ Shops endpoint for Flutter Source dropdown
app.get('/shops', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT DISTINCT `shopName` AS name FROM `chainShop` ORDER BY `shopName` ASC'
    );
    const shops = rows
      .map(r => (r.name ?? '').toString().trim())
      .filter(s => s.length > 0);
    res.json({ shops });
  } catch (e) {
    console.error('Error in /shops:', e);
    res.status(500).json({ error: 'Failed to load shops' });
  }
});

// Example write endpoint you already had
app.post('/add', async (req, res) => {
  const { testing } = req.body;
  if (!testing) return res.status(400).json({ error: 'Field "testing" is required.' });
  try {
    const [result] = await pool.query('INSERT INTO testing (testing) VALUES (?)', [testing]);
    res.status(201).json({ id: result.insertId, testing });
  } catch (err) {
    console.error('Insert error:', err);
    res.status(500).json({ error: 'Database insert failed.' });
  }
});

// ✅ Brands endpoint for Flutter Brand dropdown
app.get('/brands', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT DISTINCT `brand` AS name FROM `prices` WHERE `brand` IS NOT NULL AND `brand` <> "" ORDER BY `brand` ASC'
    );
    const brands = rows
      .map(r => (r.name ?? '').toString().trim())
      .filter(s => s.length > 0);
    res.json({ brands });
  } catch (e) {
    console.error('Error in /brands:', e);
    res.status(500).json({ error: 'Failed to load brands' });
  }
});


// index.js (add below your /shops endpoint)
app.get('/items', async (req, res) => {
  try {
    // Optional filters from querystring (brand, channel, shopID) if you need them
    const { brand, channel, shopID } = req.query;

    // Build a simple SQL with optional WHERE clauses
    const where = [];
    const params = [];
    if (brand)   { where.push('`brand` = ?');   params.push(brand);   }
    if (channel) { where.push('`channel` = ?'); params.push(channel); }
    if (shopID)  { where.push('`shopID` = ?');  params.push(shopID);  }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `
      SELECT DISTINCT \`item\` AS name
      FROM \`prices\`
      ${whereSql}
      ORDER BY \`item\` ASC
    `;

    const [rows] = await pool.query(sql, params);
    const items = rows
      .map(r => (r.name ?? '').toString().trim())
      .filter(s => s.length > 0);

    res.json({ items });
  } catch (e) {
    console.error('Error in /items:', e);
    res.status(500).json({ error: 'Failed to load items' });
  }
});

// index.js (add near your other endpoints)

app.get('/items-textless', async (req, res) => {
  try {
    // Adjust table/column names if different in your DB
    const [rows] = await pool.query(
      'SELECT DISTINCT `item` AS name FROM `itemColor4` WHERE `item` IS NOT NULL AND `item` <> "" ORDER BY `item` ASC'
    );
    const items = rows
      .map(r => (r.name ?? '').toString().trim())
      .filter(s => s.length > 0);

    res.json({ items });
  } catch (e) {
    console.error('Error in /items-textless:', e);
    res.status(500).json({ error: 'Failed to load textless items' });
  }
});


// index.js (Node/Express; using your existing pool and app)

// ✅ Item → colours for textless photos (from itemColor4)
app.get('/item-colors-textless', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT \`item\` AS item, \`color\` AS colors
      FROM \`itemColor4\`
      WHERE \`item\` IS NOT NULL AND \`item\` <> ""
    `);
    const data = rows.map(r => ({
      item: (r.item ?? '').toString().trim(),
      // Normalize to ['red','green',...] lower-case tokens
      colors: (r.colors ?? '')
        .toString()
        .toLowerCase()
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0),
    })).filter(x => x.item.length > 0);
    res.json({ items: data });
  } catch (e) {
    console.error('Error in /item-colors-textless:', e);
    res.status(500).json({ error: 'Failed to load textless item colours' });
  }
});

// ✅ Item → colours for goods photo without receipt (from prices.productColor)
// Optional filters (brand, channel, shopID) same as your /items endpoint.
app.get('/item-colors', async (req, res) => {
  try {
    const { brand, channel, shopID } = req.query;
    const where = [];
    const params = [];
    if (brand)   { where.push('`brand` = ?');   params.push(brand);   }
    if (channel) { where.push('`channel` = ?'); params.push(channel); }
    if (shopID)  { where.push('`shopID` = ?');  params.push(shopID);  }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(`
      SELECT \`item\` AS item, \`productColor\` AS colors
      FROM \`prices\`
      ${whereSql}
      -- no DISTINCT on item here to preserve ordered colours per row;
      -- we’ll aggregate in JS by item.
    `, params);

    // Aggregate by item; take the longest non-empty colour string if multiple rows
    const byItem = new Map();
    for (const r of rows) {
      const item = (r.item ?? '').toString().trim();
      const colorsStr = (r.colors ?? '').toString().trim();
      if (!item || !colorsStr) continue;
      const existing = byItem.get(item) ?? '';
      // Prefer the entry with more colours (assumes richer pictureColor string)
      if (colorsStr.length > existing.length) byItem.set(item, colorsStr);
    }

    const data = Array.from(byItem.entries()).map(([item, colorsStr]) => ({
      item,
      // Keep order (most abundant first); normalize tokens
      colors: colorsStr
        .toLowerCase()
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0),
    }));

    // Sort items alphabetically for determinism
    data.sort((a, b) => a.item.localeCompare(b.item));
    res.json({ items: data });
  } catch (e) {
    console.error('Error in /item-colors:', e);
    res.status(500).json({ error: 'Failed to load item colours' });
  }
});


// --- phone regions for the app dropdown ---
app.get('/phone/regions', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        \`countryFlag\` AS iso2,              -- e.g., 'GB'
        UPPER(\`regionID\`) AS iso3,          -- e.g., 'GBR' (or your alpha-3)
        \`regionName\` AS name,               -- e.g., 'United Kingdom'
        REPLACE(REPLACE(\`regionPhoneCode\`, ' ', ''), '-', '') AS code, -- canonical '+<digits>'
        \`regionPhoneCode\` AS displayCode,   -- human-friendly '+1-264' if you keep hyphens
        \`minRegionPhoneLength\` AS min,
        \`maxRegionPhoneLength\` AS max
      FROM \`phoneInfo\`
      ORDER BY \`regionName\` ASC
    `);

    const regions = rows
      .map(r => ({
        iso2: (r.iso2 ?? '').trim(),
        iso3: (r.iso3 ?? '').trim(),
        name: (r.name ?? '').trim(),
        code: (r.code ?? '').trim(),            // '+44'
        displayCode: (r.displayCode ?? '').trim(), // '+44' or '+1-264'
        min: Number(r.min ?? 0),
        max: Number(r.max ?? 0),
      }))
      .filter(r => r.iso2 && r.name && r.code.startsWith('+'));

    res.json({ regions });
  } catch (e) {
    console.error('Error /phone/regions:', e);
    res.status(500).json({ error: 'Failed to load phone regions' });
  }
});


// Start server last
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
