
// routes/items-all.esm.js
import express from 'express';
import { pool } from '../db.js';

const router = express.Router();

// GET /api/items/all — return ALL rows from `item`
router.get('/api/items/all', async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT id, name, brand, quantity, feature, productColor, picWebsite
      FROM item
      ORDER BY name ASC, brand ASC
    `);
    const data = rows.map(r => ({
      id: String(r.id ?? ''),
      name: String(r.name ?? ''),
      brand: String(r.brand ?? ''),
      quantity: String(r.quantity ?? ''),
      feature: String(r.feature ?? ''),
      productColor: String(r.productColor ?? ''),
      picWebsite: String(r.picWebsite ?? ''),
    }));
    res.set('Cache-Control', 'no-store');
    res.json({ count: data.length, rows: data });
  } catch (e) {
    console.error('GET /api/items/all error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

export default router;
