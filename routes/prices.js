
// routes/prices.js (CommonJS)
'use strict';
const express = require('express');
const { pool } = require('../db');

const router = express.Router();

/**
 * GET /api/prices
 * Optional query params: itemID, shopID, channel, from, to, limit, offset
 * Returns: { count, rows: [...] }
 */

router.get('/', async (req, res) => {
  try {
    const {
      itemID,
      shopID,
      channel,
      from,
      to,
      limit = '500',
      offset = '0',
    } = req.query;

    const where = [];
    const params = [];

    if (itemID)  { where.push('`itemID` = ?');  params.push(String(itemID)); }
    if (shopID)  { where.push('`shopID` = ?');  params.push(String(shopID)); }
    if (channel) { where.push('`channel` = ?'); params.push(String(channel).toLowerCase()); }
    if (from)    { where.push('`date` >= ?');   params.push(String(from)); }
    if (to)      { where.push('`date` <= ?');   params.push(String(to)); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const lim = Math.max(1, Math.min(parseInt(limit, 10) || 500, 2000));
    const off = Math.max(0, parseInt(offset, 10) || 0);

    const sql = `
      SELECT
        \`id\`, \`channel\`, \`itemID\`, \`shopID\`,
        \`date\`, \`normalPrice\`, \`discountPrice\`,
        \`shopAdd\`, \`discountCond\`
      FROM \`prices\`
      ${whereSql}
      ORDER BY \`date\` DESC, \`id\` DESC
      LIMIT ? OFFSET ?
    `;
    const finalParams = [...params, lim, off];
    const [rows] = await pool.query(sql, finalParams);

    const data = rows.map(r => ({
      id: (r.id != null ? Number(r.id) : null),
      channel: (r.channel ?? '').toString(),
      itemID: (r.itemID ?? '').toString(),
      shopID: (r.shopID ?? '').toString(),
      date: (r.date ?? '').toString(),
      normalPrice: (r.normalPrice == null ? null : Number(r.normalPrice)),
      discountPrice: (r.discountPrice == null ? null : Number(r.discountPrice)),
      shopAdd: (r.shopAdd == null ? null : String(r.shopAdd)),
      discountCond: (r.discountCond == null ? null : String(r.discountCond)),
    }));

    return res.json({ count: data.length, rows: data });
  } catch (e) {
    console.error('GET /api/prices error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});


// UPDATE an existing price row by id
router.put('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { normalPrice, discountPrice, discountCond } = req.body;

    const sql = `
      UPDATE \`prices\`
      SET \`normalPrice\` = ?,
          \`discountPrice\` = ?,
          \`discountCond\` = ?
      WHERE \`id\` = ?
    `;

    await pool.execute(sql, [
      normalPrice ?? null,
      discountPrice ?? null,
      discountCond ?? null,
      id,
    ]);

    return res.json({ updated: true, id: Number(id) });
  } catch (e) {
    console.error('PUT /api/prices/:id error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});


module.exports = router;
