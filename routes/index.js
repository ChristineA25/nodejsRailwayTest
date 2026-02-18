
// routes/index.js (ESM)
import { Router } from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import { pool } from '../db.js';

const router = Router();
router.use(cors());
router.use((req, res, next) => {
  const API_KEY = process.env.API_KEY;
  if (!API_KEY) return next();
  const key = req.get('x-api-key');
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// Helpers
function normalizeCode(s) {
  const raw = String(s ?? '');
  const digits = raw.replace(/[^\d+]/g, '');
  if (!digits.startsWith('+')) return '+' + digits.replace(/\D/g, '');
  return '+' + digits.slice(1).replace(/\D/g, '');
}

// Root & health
router.get('/', (_req, res) => res.send('API is running'));
router.get('/health', async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT 1 AS ok');
    return res.json({ ok: rows?.[0]?.ok === 1 });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ITEMS — from `item` table
router.get('/api/items/search', async (req, res) => {
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
    res.json({ items });
  } catch (e) {
    console.error('Error in /api/items/search:', e);
    res.status(500).json({ error: 'items_search_failed' });
  }
});

router.post('/api/items/batchByIds', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];
    if (ids.length === 0) return res.json({ items: [] });
    const placeholders = ids.map(() => '?').join(', ');
    const [rows] = await pool.execute(
      `SELECT id, name, brand, quantity, feature, productColor, picWebsite
       FROM item WHERE id IN (${placeholders})`, ids);
    res.json({ items: rows });
  } catch (err) {
    console.error('POST /api/items/batchByIds error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// Brands & Items (from `item`)
router.get('/brands', async (_req, res) => {
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

router.get('/items', async (req, res) => {
  try {
    const { brand } = req.query;
    const where = [];
    const params = [];
    if (brand) { where.push('`brand` = ?'); params.push(brand); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT DISTINCT \`name\` AS name FROM \`item\` ${whereSql} ORDER BY \`name\` ASC`,
      params
    );
    const items = rows.map(r => (r.name ?? '').toString().trim()).filter(Boolean);
    res.json({ items });
  } catch (e) {
    console.error('Error in /items:', e);
    res.status(500).json({ error: 'Failed to load items' });
  }
});

// Item-colors (from `item.productColor`)
router.get('/item-colors', async (req, res) => {
  try {
    const { brand } = req.query;
    const where = [];
    const params = [];
    if (brand) { where.push('`brand` = ?'); params.push(brand); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT \`name\` AS item, \`productColor\` AS colors FROM \`item\` ${whereSql}`, params
    );

    // Deduplicate by item; keep the longest colors string
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

// Allergens (from commonAllergen)
router.get('/api/allergens', async (_req, res) => {
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

// Phone: regions + validate (from phoneInfo)
router.get('/phone/regions', async (_req, res) => {
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
    res.json({ regions });
  } catch (e) {
    console.error('Error in /phone/regions:', e);
    res.status(500).json({ error: 'Failed to load regions' });
  }
});

router.post('/phone/validate', async (req, res) => {
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
    res.json({ valid: true, e164 });
  } catch (e) {
    console.error('Error in /phone/validate:', e);
    res.json({ valid: false });
  }
});

// UK location lookups
router.get('/api/counties', async (_req, res) => {
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

router.get('/api/districts', async (req, res) => {
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

router.get('/api/postcodes', async (req, res) => {
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

export default router;
