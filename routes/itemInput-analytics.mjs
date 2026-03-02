
// routes/itemInput-analytics.mjs (ESM)
import { Router } from 'express';
import { pool } from '../db.js'; // reuse your central mysql2/promise pool
const router = Router();

/**
 * Build WHERE + params for analytics queries, mirroring your existing filters:
 * - userID (required)
 * - from/to (date window)
 * - channel (lower-cased)
 * - chainShopID
 */
function buildWhere({ userID, from, to, channel, chainShopID }) {
  const where = [];
  const params = [];
  if (!userID) throw new Error('userID_required');
  where.push('`userID` = ?'); params.push(String(userID));

  if (from) { where.push('DATE(`createdAt`) >= ?'); params.push(String(from)); }
  if (to)   { where.push('DATE(`createdAt`) <= ?'); params.push(String(to)); }
  if (channel) { where.push('LOWER(`channel`) = ?'); params.push(String(channel).toLowerCase()); }
  if (chainShopID) { where.push('`chainShopID` = ?'); params.push(String(chainShopID)); }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return { whereSql, params };
}

function clamp(num, min, max, dflt) {
  const n = parseInt(num ?? String(dflt), 10);
  if (Number.isNaN(n)) return dflt;
  return Math.max(min, Math.min(n, max));
}

/* -------------------------- DAILY (group by DATE) -------------------------- */
/**
 * GET /api/item-input/analytics/daily?userID=...&from=YYYY-MM-DD&to=YYYY-MM-DD&channel=&chainShopID=&limit=&offset=
 * Response: { count, rows: [ { spending_date: 'YYYY-MM-DD', category, total_spent } ] }
 */
router.get('/daily', async (req, res) => {
  try {
    const { userID, from, to, channel, chainShopID } = req.query;
    const limit  = clamp(req.query.limit, 1, 365, 365);
    const offset = clamp(req.query.offset, 0, 1000000, 0);

    const { whereSql, params } = buildWhere({ userID, from, to, channel, chainShopID });

    const sql = `
      SELECT
        DATE(\`createdAt\`) AS spending_date,
        \`category\`       AS category,
        SUM(\`priceValue\`) AS total_spent
      FROM \`itemInput\`
      ${whereSql}
      GROUP BY spending_date, category
      ORDER BY spending_date DESC, total_spent DESC
      LIMIT ? OFFSET ?
    `;
    const [rows] = await pool.query(sql, [...params, limit, offset]);
    res.json({
      count: rows.length,
      rows: rows.map(r => ({
        spending_date: String(r.spending_date),
        category: r.category ?? null,
        total_spent: r.total_spent == null ? null : Number(r.total_spent),
      })),
    });
  } catch (e) {
    if (e.message === 'userID_required') return res.status(400).json({ error: 'userID_required' });
    console.error('GET /api/item-input/analytics/daily error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

/* ------------------------- MONTHLY (group by %Y-%m) ------------------------ */
/**
 * GET /api/item-input/analytics/monthly?userID=...&from=YYYY-MM-DD&to=YYYY-MM-DD&channel=&chainShopID=&limit=&offset=
 * Response: { count, rows: [ { spending_month: 'YYYY-MM', category, total_spent } ] }
 */
router.get('/monthly', async (req, res) => {
  try {
    const { userID, from, to, channel, chainShopID } = req.query;
    const limit  = clamp(req.query.limit, 1, 120, 120);
    const offset = clamp(req.query.offset, 0, 1000000, 0);

    const { whereSql, params } = buildWhere({ userID, from, to, channel, chainShopID });

    const sql = `
      SELECT
        DATE_FORMAT(\`createdAt\`, '%Y-%m') AS spending_month,
        \`category\`                         AS category,
        SUM(\`priceValue\`)                  AS total_spent
      FROM \`itemInput\`
      ${whereSql}
      GROUP BY spending_month, category
      ORDER BY spending_month DESC, total_spent DESC
      LIMIT ? OFFSET ?
    `;
    const [rows] = await pool.query(sql, [...params, limit, offset]);
    res.json({
      count: rows.length,
      rows: rows.map(r => ({
        spending_month: String(r.spending_month),
        category: r.category ?? null,
        total_spent: r.total_spent == null ? null : Number(r.total_spent),
      })),
    });
  } catch (e) {
    if (e.message === 'userID_required') return res.status(400).json({ error: 'userID_required' });
    console.error('GET /api/item-input/analytics/monthly error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

/* -------------------------- YEARLY (group by YEAR) ------------------------- */
/**
 * GET /api/item-input/analytics/yearly?userID=...&from=YYYY-MM-DD&to=YYYY-MM-DD&channel=&chainShopID=&limit=&offset=
 * Response: { count, rows: [ { spending_year: 2026, category, total_spent } ] }
 */
router.get('/yearly', async (req, res) => {
  try {
    const { userID, from, to, channel, chainShopID } = req.query;
    const limit  = clamp(req.query.limit, 1, 50, 10);
    const offset = clamp(req.query.offset, 0, 1000000, 0);

    const { whereSql, params } = buildWhere({ userID, from, to, channel, chainShopID });

    const sql = `
      SELECT
        YEAR(\`createdAt\`) AS spending_year,
        \`category\`        AS category,
        SUM(\`priceValue\`) AS total_spent
      FROM \`itemInput\`
      ${whereSql}
      GROUP BY spending_year, category
      ORDER BY spending_year DESC, total_spent DESC
      LIMIT ? OFFSET ?
    `;
    const [rows] = await pool.query(sql, [...params, limit, offset]);
    res.json({
      count: rows.length,
      rows: rows.map(r => ({
        spending_year: Number(r.spending_year),
        category: r.category ?? null,
        total_spent: r.total_spent == null ? null : Number(r.total_spent),
      })),
    });
  } catch (e) {
    if (e.message === 'userID_required') return res.status(400).json({ error: 'userID_required' });
    console.error('GET /api/item-input/analytics/yearly error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

export default router;
