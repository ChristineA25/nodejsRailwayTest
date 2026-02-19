
// ----------------------- Item resolve API (ESM) -----------------------------
// POST /api/items/resolve
// body: { brand, item, quantity?: {value, unit}|string }
// MATCHING: brand + item (case-insensitive) + quantity (with unit normalization).
// Feature is NOT used to filter. We still return each candidate's feature as info.
app.post('/api/items/resolve', async (req, res) => {
  try {
    const brand = String(req.body?.brand ?? '').trim();
    const item  = String(req.body?.item  ?? '').trim();
    if (!brand || !item) return res.status(400).json({ error: 'brand_and_item_required' });

    // Quantity can be string like "545ml" or object { value, unit }
    const qty = req.body?.quantity ?? null;

    // Case-insensitive exact match for brand & name
    const sql = `
      SELECT id, name, brand, quantity, feature, productColor, picWebsite
      FROM item
      WHERE LOWER(name)  = LOWER(?)
        AND LOWER(brand) = LOWER(?)
    `;
    const [rows] = await pool.query(sql, [item, brand]);
    let candidates = rows.map(r => ({
      id: String(r.id ?? ''),
      name: String(r.name ?? ''),
      brand: String(r.brand ?? ''),
      quantity: String(r.quantity ?? ''),
      feature: String(r.feature ?? ''),           // informational only
      productColor: String(r.productColor ?? ''),
      picWebsite: String(r.picWebsite ?? ''),
    }));

    // Quantity-based filter only (unit-equivalent; 500ml == 0.5L, etc.)
    if (qty) {
      candidates = candidates.filter(c => sameQty(qty, c.quantity));
    }

    // No feature narrowing; just return what we have.
    const payload = {
      exactId: (candidates.length === 1 ? candidates[0].id : null),
      suggestedFeatures: [],       // kept for compatibility; client may ignore
      candidates,
    };
    return res.json(payload);
  } catch (e) {
    console.error('POST /api/items/resolve error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});
``
