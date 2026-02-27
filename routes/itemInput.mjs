
// routes/itemInput.mjs (ESM)
import express from 'express';
import { pool } from '../db.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const {
      userID, brand, itemName, itemID, chainShopID, channel,
      from, to, limit = '200', offset = '0',
    } = req.query;

    const where = [];
    const params = [];

    if (userID)     { where.push('`userID` = ?');       params.push(String(userID)); }
    if (brand)      { where.push('`brand` = ?');        params.push(String(brand)); }
    if (itemName)   { where.push('`itemName` = ?');     params.push(String(itemName)); }
    if (itemID)     { where.push('`itemID` = ?');       params.push(String(itemID)); }
    if (chainShopID){ where.push('`chainShopID` = ?');  params.push(String(chainShopID)); }
    if (channel)    { where.push('LOWER(`channel`) = ?'); params.push(String(channel).toLowerCase()); }
    if (from)       { where.push('`createdAt` >= ?');   params.push(String(from)); }
    if (to)         { where.push('`createdAt` <= ?');   params.push(String(to)); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const lim = Math.max(1, Math.min(parseInt(limit, 10) || 200, 1000));
    const off = Math.max(0, parseInt(offset, 10) || 0);

    const sql = `
      SELECT
        id, userID, brand, itemName, itemNo, itemID, feature, quantity,
        priceValue, priceID, discountApplied, channel,
        shop_name, shop_address, chainShopID, createdAt
      FROM itemInput
      ${whereSql}
      ORDER BY createdAt DESC, id DESC
      LIMIT ? OFFSET ?
    `;
    const finalParams = [...params, lim, off];
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

    return res.json({ count: data.length, rows: data });
  } catch (e) {
    console.error('GET /api/item-input error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

export default router;
