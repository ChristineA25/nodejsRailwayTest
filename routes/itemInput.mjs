
// routes/itemInput.mjs
import { Router } from 'express';
import { pool } from '../db.js';

const router = Router();

/* -------------------------------------------------------------------------- */
/* Health check                                                               */
/* -------------------------------------------------------------------------- */
router.get('/health', (req, res) => {
  res.status(200).json({ ok: true, service: 'item-input', message: 'alive' });
});

/* -------------------------------------------------------------------------- */
/* GET /api/item-input                                                        */
/*  - Returns rows from itemInput (same columns you see in the DB UI)         */
/*  - Filters: userID, brand, itemName, itemID, chainShopID, channel, from,   */
/*             to, limit, offset                                              */
/*  - x-all: 1 header bypasses pagination                                     */
/* -------------------------------------------------------------------------- */
router.get('/', async (req, res) => {
  try {
    const {
      userID, brand, itemName, itemID, chainShopID, channel,
      from, to, limit = '200', offset = '0',
    } = req.query;

    // Allow clients to request "all" rows without changing the URL (via header)
    const returnAll = req.get('x-all') === '1';

    const where = [];
    const params = [];

    if (userID)      { where.push('`userID` = ?');        params.push(String(userID)); }
    if (brand)       { where.push('`brand` = ?');         params.push(String(brand)); }
    if (itemName)    { where.push('`itemName` = ?');      params.push(String(itemName)); } // or LIKE if you prefer
    if (itemID)      { where.push('`itemID` = ?');        params.push(String(itemID)); }
    if (chainShopID) { where.push('`chainShopID` = ?');   params.push(String(chainShopID)); }
    if (channel)     { where.push('LOWER(`channel`) = ?'); params.push(String(channel).toLowerCase()); }
    if (from)        { where.push('`createdAt` >= ?');    params.push(String(from)); }
    if (to)          { where.push('`createdAt` <= ?');    params.push(String(to)); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    
    const lim = Math.max(1, Math.min(parseInt(limit, 10) || 200, 1000));
    const off = Math.max(0, parseInt(offset, 10) || 0);

    const baseSql = `
      SELECT
        id, userID, brand, itemName, itemNo, itemID, feature, quantity,
        priceValue, priceID, discountApplied, channel,
        shop_name, shop_address, chainShopID, createdAt,
        category
      FROM itemInput
      ${whereSql}
      ORDER BY createdAt DESC, id DESC
    `;
    
    const sql = returnAll ? baseSql : `${baseSql}\nLIMIT ? OFFSET ?`;
    const finalParams = returnAll ? params : [...params, lim, off];

    const [rows] = await pool.query(sql, finalParams);

    const data = rows.map(r => ({
      id:              r.id != null ? Number(r.id) : null,
      userID:          r.userID ?? null,
      brand:           r.brand ?? null,
      itemName:        r.itemName ?? null,
      itemNo:          r.itemNo ?? null,
      itemID:          r.itemID ?? null,
      feature:         r.feature ?? null,
      quantity:        r.quantity ?? null,
      priceValue:      r.priceValue == null ? null : Number(r.priceValue),
      priceID:         r.priceID == null ? null : String(r.priceID),
      discountApplied: r.discountApplied == null ? null : Number(r.discountApplied),
      channel:         r.channel ?? null,
      shop_name:       r.shop_name ?? null,
      shop_address:    r.shop_address ?? null,
      chainShopID:     r.chainShopID ?? null,
      createdAt:       r.createdAt ? String(r.createdAt) : null,
      category:        r.category ?? null,
    }));

    res.json({ count: data.length, rows: data });
  } catch (e) {
    console.error('GET /api/item-input error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

/* -------------------------------------------------------------------------- */
/* PATCH /api/item-input/category                                             */
/*  - Body: { userID, itemID, priceID, chainShopID, createdAt, category }     */
/*  - Updates category for the single most-recent matching row (LIMIT 1).     */
/*  - Normalizes category to lowercase; adjust as needed (or validate set).   */
/* -------------------------------------------------------------------------- */
router.patch('/category', async (req, res) => {
  try {
    const b = req.body ?? {};
    const required = ['userID', 'itemID', 'priceID', 'chainShopID', 'createdAt', 'category'];
    for (const k of required) {
      if (b[k] == null || String(b[k]).trim() === '') {
        return res.status(400).json({ error: `${k}_required` });
      }
    }

    const userID      = String(b.userID);
    const itemID      = String(b.itemID);
    const priceID     = String(b.priceID);
    const chainShopID = String(b.chainShopID);
    const createdAt   = String(b.createdAt); // must match stored timestamp exactly
    const category    = String(b.category).trim().toLowerCase();

    const sql = `
      UPDATE itemInput
      SET category = ?
      WHERE userID = ?
        AND itemID = ?
        AND priceID = ?
        AND chainShopID = ?
        AND createdAt = ?
      ORDER BY id DESC
      LIMIT 1
    `;
    const [result] = await pool.execute(sql, [
      category, userID, itemID, priceID, chainShopID, createdAt,
    ]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ updated: false, reason: 'not_found' });
    }
    return res.json({ updated: true, affected: result.affectedRows });
  } catch (e) {
    console.error('PATCH /api/item-input/category error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

/* -------------------------------------------------------------------------- */
/* POST /api/item-input/category/bulk                                         */
/*  - Body: { updates: [ { userID, itemID, priceID, chainShopID, createdAt,   */
/*                        category }, ... ] }                                 */
/*  - Applies per-row update in a transaction; responds with { ok, miss, fail }*/
/* -------------------------------------------------------------------------- */
router.post('/category/bulk', async (req, res) => {
  try {
    const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
    if (updates.length === 0) return res.status(400).json({ error: 'updates_required' });

    let ok = 0, miss = 0, fail = 0;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const sql = `
        UPDATE itemInput
        SET category = ?
        WHERE userID = ?
          AND itemID = ?
          AND priceID = ?
          AND chainShopID = ?
          AND createdAt = ?
        ORDER BY id DESC
        LIMIT 1
      `;

      for (const u of updates) {
        const must = ['userID', 'itemID', 'priceID', 'chainShopID', 'createdAt', 'category'];
        if (!must.every(k => u[k] != null && String(u[k]).trim() !== '')) {
          fail++; continue;
        }
        const params = [
          String(u.category).trim().toLowerCase(),
          String(u.userID),
          String(u.itemID),
          String(u.priceID),
          String(u.chainShopID),
          String(u.createdAt),
        ];
        const [r] = await conn.execute(sql, params);
        if (r.affectedRows === 0) miss++; else ok++;
      }

      await conn.commit();
      conn.release();
      return res.json({ ok, miss, fail, count: updates.length });
    } catch (inner) {
      try { await conn.rollback(); conn.release(); } catch {}
      throw inner;
    }
  } catch (e) {
    console.error('POST /api/item-input/category/bulk error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

/* -------------------------------------------------------------------------- */
/* --- BEGIN DROP-IN: expose ALL rows from itemColor4 ----------------------- */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/item-input/item-color4/all
 * Returns every row from `itemColor4` with all columns: item, color, category, note.
 */
router.get('/item-color4/all', async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        \`item\`,
        \`color\`,
        \`category\`,
        \`note\`
      FROM \`itemColor4\`
      ORDER BY \`item\` ASC
    `);
    // Normalize to predictable strings (null-safe) and keep CSV color as-is
    const data = rows.map(r => ({
      item: (r.item ?? '').toString().trim(),
      color: (r.color ?? '').toString().trim(),      // CSV string preserved; clients can split
      category: (r.category ?? '').toString().trim(),
      note: (r.note ?? '').toString().trim(),
    }));
    return res.json({ count: data.length, rows: data });
  } catch (e) {
    console.error('GET /item-color4/all error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

/**
 * GET /api/item-input/item-color4/items
 * Returns distinct items only (useful for dropdowns / quick lookups).
 */
router.get('/item-color4/items', async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT DISTINCT \`item\` AS name
      FROM \`itemColor4\`
      WHERE \`item\` IS NOT NULL AND \`item\` <> ''
      ORDER BY \`item\` ASC
    `);
    const items = rows.map(r => (r.name ?? '').toString().trim()).filter(Boolean);
    return res.json({ count: items.length, items });
  } catch (e) {
    console.error('GET /item-color4/items error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

/* -------------------------------------------------------------------------- */
/* --- END DROP-IN ---------------------------------------------------------- */
/* -------------------------------------------------------------------------- */

export default router;
