
import { Router } from 'express';
import crypto from 'crypto';
import { pool } from '../db.js';

// ... your GET /:id, POST /byIds, and POST /findOrCreateBatch handlers ...

export default router;  // <-- important

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


// --- Find or create multiple items in one request --------------------------
// POST /api/items/findOrCreateBatch
// Body: { rows: [ { name, brand, feature?, quantity? }, ... ] }
// Returns: { results: [ { ok, id, existed, error? }, ... ] }
import crypto from 'crypto';
import { pool } from '../db.js'; // adjust path if this router is sibling to db.js

function norm(s) {
  if (s == null) return null;
  return String(s).trim();
}

function nonNullLower(s) {
  return s == null ? '' : String(s).trim().toLowerCase();
}

// Generate short url-safe id like "fnbwp1"
function genId() {
  return crypto.randomBytes(5).toString('base64url'); // ~8 chars
}

router.post('/findOrCreateBatch', async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (rows.length === 0) return res.json({ results: [] });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const results = [];
    for (const raw of rows) {
      const name     = norm(raw?.name);
      const brand    = norm(raw?.brand);
      const feature  = norm(raw?.feature);
      const quantity = norm(raw?.quantity);

      if (!name || !brand) {
        results.push({ ok: false, error: 'name_and_brand_required' });
        continue;
      }

      // 1) Try to find existing (case-insensitive match on the 4-tuple).
      //    If feature/quantity are NULL on either side, coalesce to '' for compare.
      const [foundRows] = await conn.execute(
        `
        SELECT id
          FROM item
         WHERE LOWER(TRIM(name))      = ?
           AND LOWER(TRIM(brand))     = ?
           AND LOWER(TRIM(COALESCE(quantity,''))) = ?
           AND LOWER(TRIM(COALESCE(feature,'')))  = ?
         LIMIT 1
        `,
        [
          nonNullLower(name),
          nonNullLower(brand),
          nonNullLower(quantity ?? ''),
          nonNullLower(feature ?? ''),
        ]
      );

      if (foundRows.length > 0) {
        results.push({ ok: true, id: String(foundRows[0].id), existed: true });
        continue;
      }

      // 2) Not found -> insert a new item
      //    We only fill columns you showed in screenshots; others set NULL.
      //    Ensure we produce a new (probably unique) id; in a rare collision, retry a few times.
      let newId = genId();
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await conn.execute(
            `
            INSERT INTO item
              (id, name, brand, quantity, feature, productColor, picWebsite, date)
            VALUES (?,  ?,    ?,     ?,        ?,       NULL,         NULL,     CURDATE())
            `,
            [newId, name, brand, quantity ?? null, feature ?? null]
          );
          results.push({ ok: true, id: String(newId), existed: false });
          break;
        } catch (e) {
          // If duplicate key on id, generate a new id and try again
          if (e && e.code === 'ER_DUP_ENTRY') {
            newId = genId();
            continue;
          }
          throw e;
        }
      }
    }

    await conn.commit();
    return res.json({ results });
  } catch (e) {
    await conn.rollback();
    console.error('findOrCreateBatch error:', e);
    return res.status(500).json({ error: 'server_error' });
  } finally {
    conn.release();
  }
});


module.exports = router;

