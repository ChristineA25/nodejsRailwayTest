
// POST /api/items/resolve
// Body: { brand, item, quantity?: string|{value,unit}, strictQty?: boolean }
// Matching is ONLY by brand + item (case-insens.) + quantity (with unit normalization).
// Feature is NOT used to filter. We still include it in the response for display.
router.post('/resolve', async (req, res) => {
  try {
    const brand = String(req.body?.brand || '').trim();
    const item  = String(req.body?.item  || '').trim();
    const strictQty = Boolean(req.body?.strictQty); // keep your flag

    if (!brand || !item) {
      return res.status(400).json({ error: 'brand_and_item_required' });
    }

    const qty = req.body?.quantity ?? null;
    const userQty =
      (qty && typeof qty === 'object') ? qty :
      (typeof qty === 'string' ? qty : null);

    if (strictQty && !userQty) {
      // In strict mode, quantity must be provided
      return res.status(400).json({ error: 'quantity_required_in_strict_mode' });
    }

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
      feature: String(r.feature ?? ''),         // informational only
      productColor: String(r.productColor ?? ''),
      picWebsite: String(r.picWebsite ?? ''),
    }));

    // Quantity filter only (unit‑equivalent; 500ml == 0.5L, kg↔g, etc.)
    if (userQty) {
      candidates = candidates.filter(c => sameQty(userQty, c.quantity)); // uses your canonQty/sameQty
    } else if (strictQty) {
      // strict mode and no comparable quantity -> nothing
      candidates = [];
    }

    // No feature narrowing; suggestedFeatures kept empty for compatibility
    return res.json({
      exactId: (candidates.length === 1 ? candidates[0].id : null),
      suggestedFeatures: [],
      candidates,
    });
  } catch (err) {
    console.error('POST /items/resolve', err);
    res.status(500).json({ error: 'server_error' });
  }
});


router.get('/items/screenshot', async (req, res) => {
  try {
    // You can project a different column if needed (e.g., item_name, title)
    const sql = `
      SELECT DISTINCT TRIM(name) AS item
      FROM ScreenshotItems
      WHERE name IS NOT NULL
        AND TRIM(name) <> ''
      ORDER BY LOWER(TRIM(name)) ASC
    `;

    const [rows] = await pool.query(sql);

    // rows: [ { item: "..." }, ... ]
    const items = Array.isArray(rows)
      ? rows
          .map(r => (r.item || '').toString().trim())
          .filter(Boolean)
      : [];

    res.json({ items });
  } catch (err) {
    console.error('GET /items/screenshot failed:', err);
    res.status(500).json({ error: 'Failed to fetch screenshot items' });
  }
});


// POST /api/items/resolve-by-item
router.post('/api/item/resolve-by-item', async (req, res) => {
  try {
    const { item, quantity } = req.body || {};
    if (!item || !item.trim()) {
      return res.status(400).json({ error: 'item_required' });
    }

    // Normalize
    const normItem = item.trim().toLowerCase();

    // TODO: Replace with your DB access. Example sketch:
    // 1) Find products whose item/name matches normItem (tokenized/fuzzy).
    // 2) Optionally boost candidates that match quantity.value/unit.
    //
    // const rows = await db.query(`
    //   SELECT id, brand, name, quantity, feature, picWebsite
    //   FROM products
    //   WHERE LOWER(name) LIKE ? OR LOWER(item_alias) LIKE ?
    //   ORDER BY relevance DESC
    // `, [`%${normItem}%`, `%${normItem}%`]);

    // Build 'candidates' from rows
    const candidates = rows.map(r => ({
      id: String(r.id),
      brand: r.brand ?? '',
      name: r.name ?? '',
      quantity: r.quantity ?? '',
      feature: r.feature ?? '',
      picWebsite: r.picWebsite ?? ''
    }));

    // If you can detect a high-confidence single hit, set exactId
    let exactId = '';
    // if (candidates.length === 1 && someHighConfidenceRule) exactId = candidates[0].id;

    return res.json({ exactId, candidates });
  } catch (e) {
    console.error('resolve-by-item failed:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});


// POST /api/items/create
// Body: { id?, name, brand?, quantity, feature?, productColor?, picWebsite? }
router.post('/create', async (req, res) => {
  try {
    const {
      id, name, brand, quantity, feature, productColor, picWebsite
    } = req.body || {};

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'name_required' });
    }
    if (!quantity || !String(quantity).trim()) {
      return res.status(400).json({ error: 'quantity_required' });
    }

    const tidy = v => (v == null ? null : String(v).trim() || null);
    const finalId = tidy(id) || crypto.randomBytes(6).toString('base64url'); // ~8 chars

    const sql = `
      INSERT INTO item (id, name, brand, quantity, feature, productColor, picWebsite)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;
    await pool.execute(sql, [
      finalId,
      tidy(name),
      tidy(brand),
      tidy(quantity),
      tidy(feature),
      tidy(productColor),
      tidy(picWebsite),
    ]);

    return res.status(201).json({ id: finalId });
  } catch (e) {
    console.error('POST /items/create error:', e);
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'duplicate_id' });
    return res.status(500).json({ error: 'server_error' });
  }
});


// POST /api/items/create-batch
// Body: { items: [ { id?, name, brand?, quantity, feature?, productColor?, picWebsite? }, ... ] }
router.post('/create-batch', async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) return res.status(400).json({ error: 'items_required' });

    const rows = [];
    const genId = () => crypto.randomBytes(6).toString('base64url');
    const tidy = v => (v == null ? null : String(v).trim() || null);

    for (const it of items) {
      const name = tidy(it?.name);
      const quantity = tidy(it?.quantity);
      if (!name || !quantity) continue; // skip invalid rows

      rows.push([
        tidy(it?.id) || genId(),
        name,
        tidy(it?.brand),
        quantity,
        tidy(it?.feature),
        tidy(it?.productColor),
        tidy(it?.picWebsite),
      ]);
    }
    if (rows.length === 0) return res.status(400).json({ error: 'no_valid_rows' });

    const sql = `
      INSERT INTO item (id, name, brand, quantity, feature, productColor, picWebsite)
      VALUES ?
    `;
    await pool.query(sql, [rows]);

    return res.status(201).json({ ids: rows.map(r => r[0]) });
  } catch (e) {
    console.error('POST /items/create-batch error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
