
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


// Start server last
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
