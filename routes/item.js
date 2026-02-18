
// /routes/item.js  (ESM)
// Keeps your original functionality and adds a batch find-or-create.
// Mount under /api/items in index.js:  app.use('/api/items', itemsRouter);

import { Router } from 'express';
import crypto from 'crypto';
import { pool } from '../db.js';

const router = Router();

/* ------------------------------ helpers ----------------------------------- */
function norm(s) {
  if (s == null) return null;
  return String(s).trim();
}
function nonNullLower(s) {
  return s == null ? '' : String(s).trim().toLowerCase();
}
function genId() {
  // short, URL-safe id; on rare duplicate key we retry
  return crypto.randomBytes(5).toString('base64url'); // ~8 chars
}

/* ------------------- GET /api/items/:id (keep existing) ------------------- */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query(
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

/* --------------- POST /api/items/byIds (keep existing) -------------------- */
router.post('/byIds', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length) return res.json({ items: [] });

    const placeholders = ids.map(() => '?').join(',');
    const sql = `
      SELECT id, name, brand, quantity, feature, productColor, picWebsite
        FROM item
       WHERE id IN (${placeholders})
    `;
    const [rows] = await pool.query(sql, ids);

    // Preserve original order
    const byId = new Map(rows.map(r => [String(r.id), r]));
    const ordered = ids.map(id => byId.get(String(id))).filter(Boolean);

    return res.json({ items: ordered });
  } catch (err) {
    console.error('POST /items/byIds', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/* -------- NEW: POST /api/items/findOrCreateBatch (Flutter Submit) --------- */
/*
  Body:   { rows: [ { name, brand, feature?, quantity? }, ... ] }
  Return: { results: [ { ok, id, existed, error? }, ... ] }
  - Match rule (case-insensitive equality): (name, brand, quantity?, feature?)
  - If not found -> insert new row into `item` and return new id
*/
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

      // Try match (case-insensitive) on the 4‑tuple
      const [found] = await conn.execute(
        `
          SELECT id
            FROM item
           WHERE LOWER(TRIM(name))                  = ?
             AND LOWER(TRIM(brand))                 = ?
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

      if (found.length > 0) {
        results.push({ ok: true, id: String(found[0].id), existed: true });
        continue;
      }

      // Not found -> insert a new item
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
          // regenerate id on duplicate; otherwise rethrow
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

export default router;
