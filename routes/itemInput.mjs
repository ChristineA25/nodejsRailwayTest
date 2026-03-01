
// routes/itemInput.mjs
import { Router } from 'express';
import { pool } from '../db.js';

const router = Router();

// Health check
router.get('/health', (req, res) => {
  res.status(200).json({ ok: true, service: 'item-input', message: 'alive' });
});

// GET /api/item-input
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

    if (userID)      { where.push('`userID` = ?');       params.push(String(userID)); }
    if (brand)       { where.push('`brand` = ?');        params.push(String(brand)); }
    if (itemName)    { where.push('`itemName` = ?');     params.push(String(itemName)); } // or LIKE if you prefer
    if (itemID)      { where.push('`itemID` = ?');       params.push(String(itemID)); }
    if (chainShopID) { where.push('`chainShopID` = ?');  params.push(String(chainShopID)); }
    if (channel)     { where.push('LOWER(`channel`) = ?'); params.push(String(channel).toLowerCase()); }
    if (from)        { where.push('`createdAt` >= ?');   params.push(String(from)); }
    if (to)          { where.push('`createdAt` <= ?');   params.push(String(to)); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    
    const lim = Math.max(1, Math.min(parseInt(limit, 10) || 200, 1000));
    const off = Math.max(0, parseInt(offset, 10) || 0);

    const baseSql = `
      SELECT
        id, userID, brand, itemName, itemNo, itemID, feature, quantity,
        priceValue, priceID, discountApplied, channel,
        shop_name, shop_address, chainShopID, createdAt
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
    }));

    res.json({ count: data.length, rows: data });
  } catch (e) {
    console.error('GET /api/item-input error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});


// --- BEGIN DROP-IN: expose ALL rows from itemColor4 -------------------------

// GET /api/item-input/item-color4/all
// Returns every row from `itemColor4` with all columns: item, color, category, note.
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
    // Normalize to predictable strings (null-safe) and split colors if you want arrays
    const data = rows.map(r => ({
      item: (r.item ?? '').toString().trim(),
      color: (r.color ?? '').toString().trim(),      // keep CSV as-is; client can split
      category: (r.category ?? '').toString().trim(),
      note: (r.note ?? '').toString().trim(),
    }));
    return res.json({ count: data.length, rows: data });
  } catch (e) {
    console.error('GET /item-color4/all error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// (Optional) GET /api/item-input/item-color4/items
// Returns distinct items only (useful for dropdowns / quick lookups).
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

// --- END DROP-IN ------------------------------------------------------------


export default router;
