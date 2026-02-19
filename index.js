
// index.js (ESM server)
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import { pool, pingDB } from './db.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '512kb' }));

// Optional API key gate (set API_KEY on Railway)
const API_KEY = process.env.API_KEY || null;
app.use((req, res, next) => {
  if (!API_KEY) return next();
  const key = req.get('x-api-key');
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// Log DB vars (helps when debugging on Railway)
console.log('DB VARS SNAPSHOT', {
  MYSQLHOST: process.env.MYSQLHOST,
  MYSQLUSER: process.env.MYSQLUSER,
  MYSQLDATABASE: process.env.MYSQLDATABASE,
  MYSQLPORT: process.env.MYSQLPORT,
});

// ----------------------------- Helpers --------------------------------------
/** CSV / repeated query param -> clean array of strings */
const splitCsv = (v) =>
  (typeof v === 'string' ? v.split(',') : Array.isArray(v) ? v : [])
    .map((s) => (s ?? '').toString().trim())
    .filter(Boolean);

/** Normalize to canonical "+<digits>" (e.g., "+ 1-264" -> "+1264") */
function normalizeCode(s) {
  const raw = String(s ?? '');
  const digits = raw.replace(/[^\d+]/g, ''); // keep '+' and digits
  if (!digits.startsWith('+')) return '+' + digits.replace(/\D/g, '');
  return '+' + digits.slice(1).replace(/\D/g, '');
}


// ---------- Items resolver helpers (ESM) ----------
function splitFeaturesCSV(s) {
  return String(s ?? '')
    .split(',')
    .map(x => x.trim().toLowerCase())
    .filter(Boolean);
}


// Helper: canonicalize any supported quantity shape to { value, unit } in base units
function toCanon(q) {
  if (!q) return null;
  if (typeof q === 'string') return canonQty(q);

  // Object like { value, unit } from Flutter
  if (typeof q === 'object' && q.value != null && q.unit) {
    // Use canonQty on a synthetic string to reuse unit/alias logic
    return canonQty(String(q.value) + String(q.unit));
  }
  return null;
}

function uniq(arr) { return Array.from(new Set(arr)); }

// canonicalize quantity to { value, unit } with base units: ml, g, pcs, pack
function canonQty(raw) {
  if (!raw) return null;
  const t = String(raw).trim().toLowerCase().replace(/\s+/g, '');
  const m = t.match(/^(\d+(?:\.\d+)?)([a-z]+)$/);
  if (!m) return null;
  let v = parseFloat(m[1]);
  let u = m[2];

  // Normalize common plurals/aliases
  if (u === 'l' || u === 'lt' || u === 'liter' || u === 'litre') { v *= 1000; u = 'ml'; }
  else if (u === 'kg') { v *= 1000; u = 'g'; }
  else if (u === 'pc' || u === 'piece' || u === 'pieces') { u = 'pcs'; }
  else if (u === 'packs') { u = 'pack'; }

  if (!['ml','g','pcs','pack'].includes(u)) return null;
  return { value: v, unit: u };
}


// Replace sameQty with this version:
function sameQty(userQ, dbQ) {
  const u = toCanon(userQ);
  const d = toCanon(dbQ);
  if (!u || !d) return true;  // if either missing, do not filter out
  if (u.unit !== d.unit) return false;

  if (u.unit === 'pcs' || u.unit === 'pack') {
    return Math.abs(u.value - d.value) < 0.5; // integer-ish tolerance
  }
  // ml/g: allow 2% tolerance, min absolute 1 unit
  const maxV = Math.max(u.value, d.value);
  return Math.abs(u.value - d.value) <= Math.max(1, 0.02 * maxV);
}


// -------------------------- Root & health -----------------------------------
app.get('/', (_req, res) => res.send('API is running'));
app.get('/health', async (_req, res) => {
  try {
    const ok = await pingDB();
    return res.json({ ok });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});


// ----------------------- Item resolve API (ESM) -----------------------------
// POST /api/items/resolve
// body: { brand, item, quantity?: {value, unit}|string }
// MATCHING: brand + item (case-insensitive) + quantity (with unit normalization).
// Feature is NOT used to filter. We still return each candidate's feature as info.
app.post('/api/items/resolve', async (req, res) => {
  try {
    const brand = String(req.body?.brand ?? '').trim();
    const item  = String(req.body?.item  ?? '').trim();
    if (!brand || !item) return res.status(400).json({ error: 'brand_and_item_required' });

    // Quantity can be string like "545ml" or object { value, unit }
    const qty = req.body?.quantity ?? null;

    // Case-insensitive exact match for brand & name
    const sql = `
      SELECT id, name, brand, quantity, feature, productColor, picWebsite
      FROM item
      WHERE LOWER(name)  = LOWER(?)
        AND LOWER(brand) = LOWER(?)
    `;
    const [rows] = await pool.query(sql, [item, brand]);
    let candidates = rows.map(r => ({
      id: String(r.id ?? ''),
      name: String(r.name ?? ''),
      brand: String(r.brand ?? ''),
      quantity: String(r.quantity ?? ''),
      feature: String(r.feature ?? ''),           // informational only
      productColor: String(r.productColor ?? ''),
      picWebsite: String(r.picWebsite ?? ''),
    }));

    // Quantity-based filter only (unit-equivalent; 500ml == 0.5L, etc.)
    if (qty) {
      candidates = candidates.filter(c => sameQty(qty, c.quantity));
    }

    // No feature narrowing; just return what we have.
    const payload = {
      exactId: (candidates.length === 1 ? candidates[0].id : null),
      suggestedFeatures: [],       // kept for compatibility; client may ignore
      candidates,
    };
    return res.json(payload);
  } catch (e) {
    console.error('POST /api/items/resolve error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// -------------------------- ITEMS (search page) ------------------------------
// GET /api/items/search?q=&field=all|name|brand|quantity|feature|productcolor&limit=50
// Reads only from `item` table (id, name, brand, quantity, feature, productColor, picWebsite).
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
        where.push('(name LIKE ? OR brand LIKE ? OR quantity LIKE ? OR feature LIKE ? OR productColor LIKE ?)');
        params.push(like, like, like, like, like);
      } else if (field === 'productcolor') {
        where.push('productColor LIKE ?');
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
    const items = rows.map((r) => ({
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


// ----------------------- Item resolve API (ESM) -----------------------------
// POST /api/items/resolve
// body: { brand, item, quantity?: {value, unit}|string, selectedFeatures?: string[] }
app.post('/api/items/resolve', async (req, res) => {
  try {
    const brand = String(req.body?.brand ?? '').trim();
    const item  = String(req.body?.item  ?? '').trim();

    if (!brand || !item) {
      return res.status(400).json({ error: 'brand_and_item_required' });
    }

    // Quantity can be string like "545ml" or object { value, unit }
    const qty = req.body?.quantity ?? null;
    const userQty = (qty && typeof qty === 'object') ? qty : (typeof qty === 'string' ? qty : null);

    const selectedFeatures = Array.isArray(req.body?.selectedFeatures)
      ? req.body.selectedFeatures.map(s => String(s).toLowerCase().trim()).filter(Boolean)
      : [];

    // Case-insensitive exact match for brand & name
    const sql = `
      SELECT id, name, brand, quantity, feature, productColor, picWebsite
      FROM item
      WHERE LOWER(name)  = LOWER(?)
        AND LOWER(brand) = LOWER(?)
    `;
    const [rows] = await pool.query(sql, [item, brand]);
    let candidates = rows.map(r => ({
      id: String(r.id ?? ''),
      name: String(r.name ?? ''),
      brand: String(r.brand ?? ''),
      quantity: String(r.quantity ?? ''),
      feature: String(r.feature ?? ''),
      productColor: String(r.productColor ?? ''),
      picWebsite: String(r.picWebsite ?? ''),
    }));

    // Filter by (normalized) quantity when provided
    if (userQty) {
      candidates = candidates.filter(c => sameQty(userQty, c.quantity));
    }

    // Union of features across current candidates
    const unionFeatures = uniq(
      candidates.flatMap(c => splitFeaturesCSV(c.feature))
    );

    // If caller provided selectedFeatures, filter further:
    if (selectedFeatures.length) {
      candidates = candidates.filter(c => {
        const f = splitFeaturesCSV(c.feature);
        // require that all selected features are present in candidate.features
        return selectedFeatures.every(sf => f.includes(sf));
      });
    }

    const payload = {
      exactId: (candidates.length === 1 ? candidates[0].id : null),
      suggestedFeatures: unionFeatures,
      candidates,
    };

    return res.json(payload);
  } catch (e) {
    console.error('POST /api/items/resolve error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Add to index.js (ESM) on the 53a4 service
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

    // Ensure strings
    const items = rows.map(r => ({
      id: String(r.id ?? ''),
      name: String(r.name ?? ''),
      brand: String(r.brand ?? ''),
      quantity: String(r.quantity ?? ''),
      feature: String(r.feature ?? ''),
      productColor: String(r.productColor ?? ''),
      picWebsite: String(r.picWebsite ?? ''),
    }));
    res.json({ items });
  } catch (err) {
    console.error('POST /api/items/batchByIds error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});


// ------------------------- Misc reference data -------------------------------
// Distinct allergens
app.get('/api/allergens', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT allergenCommonName AS name
         FROM commonAllergen
        WHERE allergenCommonName IS NOT NULL
          AND allergenCommonName <> ''
        ORDER BY allergenCommonName ASC`
    );
    const items = rows.map((r) => (r.name ?? '').toString().trim()).filter(Boolean);
    res.json({ items });
  } catch (e) {
    console.error('Error in /api/allergens:', e);
    res.status(500).json({ error: 'allergens_fetch_failed' });
  }
});

// UK location lookups (counties, districts, postcodes)
app.get('/api/counties', async (_req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT DISTINCT county
         FROM gbrPostcodeNameSake
        WHERE county IS NOT NULL AND county <> ''
        ORDER BY county ASC`
    );
    res.json({ items: rows.map((r) => r.county) });
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
        WHERE county = ?
          AND district IS NOT NULL AND district <> '' 
        ORDER BY district ASC`,
      [county]
    );
    res.json({ items: rows.map((r) => r.district) });
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
        WHERE county = ?
          AND district = ?
          AND postcode IS NOT NULL
          AND postcode <> '' 
        ORDER BY postcode ASC`,
      [county, district]
    );
    res.json({ items: rows.map((r) => r.postcode) });
  } catch (e) {
    res.status(500).json({ error: 'postcodes_fetch_failed' });
  }
});

// ----------------------------- Phone helper APIs ----------------------------
app.get('/phone/regions', async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        regionName           AS name,
        regionPhoneCode      AS phoneCode,
        minRegionPhoneLength AS minLen,
        maxRegionPhoneLength AS maxLen,
        countryFlag          AS iso2
      FROM phoneInfo
      WHERE countryFlag IS NOT NULL AND countryFlag <> ''
      ORDER BY name ASC
    `);

    const regions = rows.map((r) => {
      const iso2 = String(r.iso2 ?? '').trim().toUpperCase();
      const displayCode = String(r.phoneCode ?? '').trim();
      const code = normalizeCode(displayCode);
      return {
        iso2,
        name: String(r.name ?? '').trim(),
        code,        // canonical like '+44'
        displayCode, // original, e.g. '+ 1-264'
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

    const canonCode = normalizeCode(row.phoneCode); // '+44', '+1264', ...
    const e164 = `${canonCode}${localDigits}`;
    return res.json({ valid: true, e164 });
  } catch (e) {
    console.error('Error in /phone/validate:', e);
    return res.json({ valid: false });
  }
});

// ------------------------ Shops / Brands (for Flutter) ----------------------
// GET /shops -> { shops: [ "Tesco", "Savers", ... ] }
app.get('/shops', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT DISTINCT `shopName` AS name FROM `chainShop` ORDER BY `shopName` ASC'
    );
    const shops = rows.map((r) => (r.name ?? '').toString().trim()).filter(Boolean);
    res.json({ shops });
  } catch (e) {
    console.error('Error in /shops:', e);
    res.status(500).json({ error: 'Failed to load shops' });
  }
});

// GET /brands -> { brands: [ "TESCO", "FAIRY", ... ] }
app.get('/brands', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT DISTINCT `brand` AS name FROM `item` WHERE `brand` IS NOT NULL AND `brand` <> "" ORDER BY `brand` ASC'
    );
    const brands = rows.map((r) => (r.name ?? '').toString().trim()).filter(Boolean);
    res.json({ brands });
  } catch (e) {
    console.error('Error in /brands:', e);
    res.status(500).json({ error: 'Failed to load brands' });
  }
});

// --------------------------- Items (for Flutter) ----------------------------
// NEW STRUCTURE AWARE: joins `item` with `prices` when needed.
// Supported query params:
//   id=string (item.id exact)
//   name=string (exact)    q=string (LIKE on i.name)
//   brand=CSV              color=CSV (matches ANY in i.productColor CSV)
//   shop=string (substring match in i.picWebsite)
//   shopID=string (matches prices.shopID)
//   channel=string (matches prices.channel)
//   from=YYYY-MM-DD, to=YYYY-MM-DD (filters by COALESCE(p.date, i.date))
//   limit (default 200, max 1000)  offset (default 0)
//
// Response: { count, items: [ "wash up liquid", ... ] }
app.get('/items', async (req, res) => {
  try {
    const {
      id,
      name,
      q,
      brand,
      shop,
      color,
      shopID,
      channel,
      from,
      to,
      limit = '200',
      offset = '0',
    } = req.query;

    const brands = splitCsv(brand);
    const colors = splitCsv(color).map((c) => c.toLowerCase());

    // Always left join prices so filters can apply if provided.
    const where = [];
    const params = [];

    if (id)        { where.push('i.`id` = ?');        params.push(id); }
    if (name)      { where.push('i.`name` = ?');      params.push(name); }
    if (q)         { where.push('i.`name` LIKE ?');   params.push(`%${q}%`); }

    if (brands.length) {
      where.push('(' + brands.map(() => 'i.`brand` = ?').join(' OR ') + ')');
      params.push(...brands);
    }

    // Legacy shop substring match on product picture URL
    if (shop) {
      where.push('i.`picWebsite` LIKE ?');
      params.push(`%${shop}%`);
    }

    // Precise shop/channel filters live in `prices` now
    if (shopID)    { where.push('p.`shopID` = ?');    params.push(shopID); }
    if (channel)   { where.push('p.`channel` = ?');   params.push(channel); }

    // Colors: i.productColor is CSV; normalize & match ANY color requested
    if (colors.length) {
      const colorClause = colors
        .map(() => 'FIND_IN_SET(LOWER(?), REPLACE(REPLACE(i.`productColor`, " ", ""), ",,", ","))')
        .join(' OR ');
      where.push('(' + colorClause + ')');
      params.push(...colors.map((c) => c.replace(/\s+/g, '')));
    }

    // Date window: prefer prices.date; fall back to item.date
    if (from) { where.push('COALESCE(p.`date`, i.`date`) >= ?'); params.push(from); }
    if (to)   { where.push('COALESCE(p.`date`, i.`date`) <= ?'); params.push(to); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const lim = Math.max(1, Math.min(parseInt(limit, 10) || 200, 1000));
    const off = Math.max(0, parseInt(offset, 10) || 0);

    const sql = `
      SELECT DISTINCT i.\`name\` AS name
        FROM \`item\` i
   LEFT JOIN \`prices\` p ON p.\`itemID\` = i.\`id\`
       ${whereSql}
    ORDER BY i.\`name\` ASC
       LIMIT ? OFFSET ?
    `;

    const finalParams = [...params, lim, off];
    const [rows] = await pool.query(sql, finalParams);
    const items = rows.map((r) => (r.name ?? '').toString().trim()).filter(Boolean);
    res.json({ count: items.length, items });
  } catch (e) {
    console.error('Error in /items:', e);
    res.status(500).json({ error: 'Failed to load items' });
  }
});

// --------------------- Textless fallback lists (for Flutter) ----------------
// GET /items-textless -> { items: [ "basmati rice", ... ] }
app.get('/items-textless', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT DISTINCT `item` AS name FROM `itemColor4` WHERE `item` IS NOT NULL AND `item` <> "" ORDER BY `item` ASC'
    );
    const items = rows.map((r) => (r.name ?? '').toString().trim()).filter(Boolean);
    res.json({ items });
  } catch (e) {
    console.error('Error in /items-textless:', e);
    res.status(500).json({ error: 'Failed to load textless items' });
  }
});

// GET /item-colors-textless -> { items: [ { item, colors: [...] }, ... ] }
app.get('/item-colors-textless', async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT \`item\` AS item, \`color\` AS colors
        FROM \`itemColor4\`
       WHERE \`item\` IS NOT NULL AND \`item\` <> ""
    `);
    const data = rows
      .map((r) => ({
        item: (r.item ?? '').toString().trim(),
        colors: (r.colors ?? '')
          .toString()
          .toLowerCase()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      }))
      .filter((x) => x.item.length > 0);
    res.json({ items: data });
  } catch (e) {
    console.error('Error in /item-colors-textless:', e);
    res.status(500).json({ error: 'Failed to load textless item colours' });
  }
});

// -------------------- Color map (goods w/out receipt) -----------------------
// GET /item-colors?[brand=...]&[channel=...]&[shopID=...]
// Note: `brand` is in `item`; `channel` and `shopID` are in `prices` now.
// Response: { items: [ { item: "<name>", colors: ["blue","white",...] }, ... ] }
app.get('/item-colors', async (req, res) => {
  try {
    const { brand, channel, shopID } = req.query;
    const where = [];
    const params = [];

    if (brand)   { where.push('i.`brand` = ?');   params.push(brand); }
    if (channel) { where.push('p.`channel` = ?'); params.push(channel); }
    if (shopID)  { where.push('p.`shopID` = ?');  params.push(shopID); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `
      SELECT i.\`name\` AS item, i.\`productColor\` AS colors
        FROM \`item\` i
   LEFT JOIN \`prices\` p ON p.\`itemID\` = i.\`id\`
       ${whereSql}
      `,
      params
    );

    // Prefer the "longest" color string when duplicates exist (as before)
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
        colors: colorsStr
          .toLowerCase()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      }))
      .sort((a, b) => a.item.localeCompare(b.item));

    res.json({ items: data });
  } catch (e) {
    console.error('Error in /item-colors:', e);
    res.status(500).json({ error: 'Failed to load item colours' });
  }
});

// ------------------------- Test insert endpoint -----------------------------
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

// ------------------------------ Signup APIs ---------------------------------
// POST /signup  -> simple password hash storage (bcryptjs) in loginTable
app.post('/signup', async (req, res) => {
  try {
    const {
      username,
      email,
      password,
      phone_country_code,
      phone_number,
      q1, a1, q2, a2, q3, a3,
    } = req.body;

    if (!password || String(password).length < 8) {
      return res.status(400).json({ error: 'Weak or missing password' });
    }

    // Accept any single identifier; if neither username nor email provided,
    // derive a username from phone values when both exist.
    let finalUsername = username ?? null;
    const finalEmail = email ?? null;
    if (!finalUsername && !finalEmail && phone_country_code && phone_number) {
      finalUsername = `u_${phone_country_code}_${phone_number}`;
    }
    if (!finalUsername && !finalEmail) {
      return res.status(400).json({ error: 'Provide username, email, or phone' });
    }

    const hashed = await bcrypt.hash(String(password), 10);

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
    console.error('Signup error:', err); // keep for diagnostics
    return res.status(500).json({ error: 'Server error' });
  }
});

// ------------------------------ Start server --------------------------------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
