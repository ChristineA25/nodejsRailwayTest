
// routes/items.js
const express = require('express');
const router = express.Router();
// reuse your existing DB pool/conn; example shown:
const db = require('../db'); // adjust to your project


// ---------- Items resolver helpers (CJS) ----------
function splitFeaturesCSV(s) {
  return String(s || '')
    .split(',')
    .map(x => x.trim().toLowerCase())
    .filter(Boolean);
}

function uniq(arr) { return Array.from(new Set(arr)); }

/** Canonicalize quantity to {value, unit} with base units: ml, g, pcs, pack */
function canonQty(raw) {
  if (!raw) return null;
  const t = String(raw).trim().toLowerCase().replace(/\s+/g, '');
  const m = t.match(/^(\d+(?:\.\d+)?)([a-z]+)$/);
  if (!m) return null;
  let v = parseFloat(m[1]);
  let u = m[2];

  if (u === 'l' || u === 'lt' || u === 'liter' || u === 'litre') { v *= 1000; u = 'ml'; }
  else if (u === 'kg') { v *= 1000; u = 'g'; }
  else if (u === 'pc' || u === 'piece' || u === 'pieces') { u = 'pcs'; }
  else if (u === 'packs') { u = 'pack'; }

  if (!['ml','g','pcs','pack'].includes(u)) return null;
  return { value: v, unit: u };
}

/** Compare user vs DB quantity with tolerances */
function sameQty(userQ, dbQ) {
  const u = (typeof userQ === 'string' ? canonQty(userQ) : userQ);
  const d = canonQty(dbQ);
  if (!u || !d) return true;            // if missing or unparsable: don't filter it out
  if (u.unit !== d.unit) return false;

  if (u.unit === 'pcs' || u.unit === 'pack') {
    // integer-ish comparison
    return Math.abs(u.value - d.value) < 0.5;
  }
  // ml/g: allow 2% tolerance (minimum ±1)
  const maxV = Math.max(u.value, d.value);
  return Math.abs(u.value - d.value) <= Math.max(1, 0.02 * maxV);
}


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



// POST /api/items/resolve
// Body: {
//   brand, item,
//   quantity?: string|{value,unit},
//   selectedFeatures?: string[],
//   strictQty?: boolean   // NEW
// }
router.post('/resolve', async (req, res) => {
  try {
    const brand = String(req.body?.brand || '').trim();
    const item  = String(req.body?.item  || '').trim();
    const strictQty = Boolean(req.body?.strictQty);          // NEW

    if (!brand || !item) {
      return res.status(400).json({ error: 'brand_and_item_required' });
    }

    const qty = req.body?.quantity ?? null;
    const userQty =
      (qty && typeof qty === 'object')
        ? qty
        : (typeof qty === 'string' ? qty : null);

    if (strictQty && !userQty) {
      // In strict mode, quantity must be provided
      return res.status(400).json({ error: 'quantity_required_in_strict_mode' });
    }

    const selectedFeatures = Array.isArray(req.body?.selectedFeatures)
      ? req.body.selectedFeatures.map(s => String(s).toLowerCase().trim()).filter(Boolean)
      : [];

    // Case-insensitive exact brand & name
    const sql = `
      SELECT id, name, brand, quantity, feature, productColor, picWebsite
      FROM item
      WHERE LOWER(name)  = LOWER(?)
        AND LOWER(brand) = LOWER(?)
    `;
    const [rows] = await db.query(sql, [item, brand]);

    let candidates = rows.map(r => ({
      id: String(r.id ?? ''),
      name: String(r.name ?? ''),
      brand: String(r.brand ?? ''),
      quantity: String(r.quantity ?? ''),
      feature: String(r.feature ?? ''),
      productColor: String(r.productColor ?? ''),
      picWebsite: String(r.picWebsite ?? ''),
    }));

    // Quantity filter
    if (userQty) {
      candidates = candidates.filter(c => sameQty(userQty, c.quantity));
    } else if (strictQty) {
      // In strict mode, if there's no comparable quantity, reject all
      candidates = [];
    }

    // Union features (to suggest to UI if needed)
    const unionFeatures = uniq(
      candidates.flatMap(c => splitFeaturesCSV(c.feature))
    );

    // Narrow by user's typed features (if provided)
    if (selectedFeatures.length) {
      candidates = candidates.filter(c => {
        const f = splitFeaturesCSV(c.feature);
        return selectedFeatures.every(sf => f.includes(sf));
      });
    }

    return res.json({
      exactId: (candidates.length === 1 ? candidates[0].id : null),
      suggestedFeatures: unionFeatures,
      candidates,
    });
  } catch (err) {
    console.error('POST /items/resolve', err);
    res.status(500).json({ error: 'server_error' });
  }
});


module.exports = router;
