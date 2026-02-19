
// routes/items.js
const express = require('express');
const router = express.Router();
// reuse your existing DB pool/conn; example shown:
const db = require('../db'); // adjust to your project

// GET /api/items/:id  -> single item by id (handy for debugging)
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await db.query(
      'SELECT id, name, brand, quantity, feature, productColor, picWebsite FROM item WHERE id = ?',
      [id]
    );
    if (!rows.length) return res.status(404).json({ message: 'Not found' });
    return res.json(rows[0]);
  } catch (err) {
    console.error('GET /items/:id', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/items/byIds  -> bulk details for ids[]
router.post('/byIds', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length) return res.json({ items: [] });

    // IMPORTANT: use parameter placeholders to prevent SQL injection
    const placeholders = ids.map(() => '?').join(',');
    const sql = `
      SELECT id, name, brand, quantity, feature, productColor, picWebsite
      FROM item
      WHERE id IN (${placeholders})
    `;
    const [rows] = await db.query(sql, ids);

    // Keep original order (optional): map back to ids order
    const byId = new Map(rows.map(r => [String(r.id), r]));
    const ordered = ids.map(id => byId.get(String(id))).filter(Boolean);

    return res.json({ items: ordered });
  } catch (err) {
    console.error('POST /items/byIds', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
