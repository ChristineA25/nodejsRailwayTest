
// routes/shops.js (CommonJS)
'use strict';
const express = require('express');
const { pool } = require('../db');

const router = express.Router();

/** Normalize a shop name to a canonical key (lowercase, ascii, no suffixes/branch) */
function normalizeShopName(raw) {
  let s = String(raw || '').normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');        // strip diacritics
  // drop bracketed branch notes e.g. "(Cabot Circus)"
  s = s.replace(/\(.*?\)/g, ' ');
  // remove common small-format suffixes
  s = s.replace(/\b(express|local|extra|metro|superstore)\b/gi, ' ');
  // letters/digits only + single spaces
  s = s.replace(/[^a-zA-Z0-9]+/g, ' ')
       .trim()
       .replace(/\s+/g, ' ')
       .toLowerCase();
  return s;
}

/** Generate a slug for shopID from normalized name */
function slugifyShopId(norm) {
  return norm.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * POST /api/shops/ensure
 * Body: { name: string, shopId?: string }
 * Result: { created: boolean, shop: { shopID, shopName } }
 */
router.post('/ensure', async (req, res) => {
  try {
    const rawName = String(req.body?.name ?? '').trim();
    let shopId = String(req.body?.shopId ?? '').trim();
    if (!rawName) return res.status(400).json({ error: 'name_required' });

    const norm = normalizeShopName(rawName);
    if (!norm) return res.status(400).json({ error: 'name_normalized_empty' });

    // 1) Try find by normalized name
    const [exist] = await pool.query(
      'SELECT `shopID`, `shopName` FROM `chainShop` WHERE `shopNameNorm` = ? LIMIT 1',
      [norm]
    );
    if (exist.length) {
      return res.json({ created: false, shop: exist[0] });
    }

    // 2) Generate unique shopID if not provided
    if (!shopId) {
      const base = slugifyShopId(norm) || 'shop';
      let candidate = base;
      let n = 1;
      // ensure unique shopID
      // NOTE: small loop is OK because this runs only on first-time insertions
      // and shop names are few.
      // You can replace with a DB-side constraint and try/catch for collisions.
      for (;;) {
        const [hit] = await pool.query(
          'SELECT 1 FROM `chainShop` WHERE `shopID` = ? LIMIT 1', [candidate]
        );
        if (hit.length === 0) break;
        candidate = `${base}-${n++}`;
      }
      shopId = candidate;
    }

    // 3) Insert (ignore other columns)
    await pool.query(
      'INSERT INTO `chainShop` (`shopName`, `shopNameNorm`, `shopID`) VALUES (?, ?, ?)',
      [rawName, norm, shopId]
    );

    return res.status(201).json({
      created: true,
      shop: { shopID: shopId, shopName: rawName }
    });
  } catch (e) {
    console.error('POST /api/shops/ensure error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

/**
 * GET /api/shops/find?name=...
 * Finds by normalized name.
 */
router.get('/find', async (req, res) => {
  try {
    const raw = String(req.query?.name ?? '').trim();
    if (!raw) return res.status(400).json({ error: 'name_required' });
    const norm = normalizeShopName(raw);
    if (!norm) return res.json({ shop: null });

    const [rows] = await pool.query(
      'SELECT `shopID`, `shopName` FROM `chainShop` WHERE `shopNameNorm` = ? LIMIT 1',
      [norm]
    );
    return res.json({ shop: rows[0] ?? null });
  } catch (e) {
    console.error('GET /api/shops/find error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});


// routes/shops.js (CommonJS)
'use strict';
const express = require('express');
const { pool } = require('../db');

const router = express.Router();

/** Make a safe slug for shopID from a display name (ASCII, hyphen-separated) */
function slugify(raw) {
  return String(raw || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')    // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')                          // non-alnum -> hyphen
    .replace(/^-+|-+$/g, '')                              // trim edges
    || 'shop';
}

/**
 * POST /api/shops/ensure-lite
 * Body: { name: string }
 * Result: { created: boolean, shop: { shopID, shopName } }
 *
 * - Case-insensitive existence check on chainShop.shopName
 * - If missing, inserts one row (shopName, shopID)
 * - NO schema changes, NO extra columns
 */
router.post('/ensure-lite', async (req, res) => {
  try {
    const raw = String(req.body?.name ?? '').trim();
    if (!raw) return res.status(400).json({ error: 'name_required' });

    // 1) Does it already exist? (case-insensitive)
    const [exist] = await pool.query(
      'SELECT `shopID`, `shopName` FROM `chainShop` WHERE LOWER(`shopName`) = LOWER(?) LIMIT 1',
      [raw]
    );
    if (exist.length) {
      return res.json({ created: false, shop: exist[0] });
    }

    // 2) Generate a unique shopID slug without migrations
    const base = slugify(raw);
    let candidate = base;
    let n = 1;
    // Ensure uniqueness on shopID
    for (;;) {
      const [hit] = await pool.query(
        'SELECT 1 FROM `chainShop` WHERE `shopID` = ? LIMIT 1',
        [candidate]
      );
      if (hit.length === 0) break;
      candidate = `${base}-${n++}`;
    }

    // 3) Insert the new shop
    await pool.query(
      'INSERT INTO `chainShop` (`shopName`, `shopID`) VALUES (?, ?)',
      [raw, candidate]
    );

    return res.status(201).json({
      created: true,
      shop: { shopID: candidate, shopName: raw }
    });
  } catch (e) {
    console.error('POST /api/shops/ensure-lite error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
