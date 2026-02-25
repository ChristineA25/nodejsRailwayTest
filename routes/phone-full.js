
// routes/phone-full.js (ESM)
import express from 'express';
import crypto from 'crypto';

// IMPORTANT: reuse the same mysql2/promise pool your app already uses.
// If you already export it from a central db module, import from there:
// import { pool } from '../db.js';
import mysql from 'mysql2/promise';

const router = express.Router();

// If you already have a shared pool, delete this and import that instead.
const pool = mysql.createPool({
  host: process.env.MYSQLHOST,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  port: Number(process.env.MYSQLPORT || 3306),
  ssl: { rejectUnauthorized: false },
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000
});

/**
 * GET /phone/regions/raw
 * Returns all columns from phoneInfo (admin/export).
 */
router.get('/regions/raw', async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        regionID,
        regionName,
        regionPhoneCode,
        minRegionPhoneLength,
        maxRegionPhoneLength,
        countryFlag,
        recordDate,
        offsetHrsVsUtc,
        timezoneURL
      FROM phoneInfo
      ORDER BY regionName ASC
    `);

    // Optional: ETag to help clients cache the unchanging data
    const etag = '"' + crypto.createHash('sha1')
      .update(JSON.stringify(rows))
      .digest('hex') + '"';

    if (_req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }
    res.set('ETag', etag);
    res.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');

    return res.json({ count: rows.length, rows });
  } catch (e) {
    console.error('GET /phone/regions/raw error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

/**
 * GET /phone/regions/with-sites
 * For each record, fetch timezoneURL (if present) and return status + finalURL + preview.
 */
router.get('/regions/with-sites', async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        regionID,
        regionName,
        regionPhoneCode,
        minRegionPhoneLength,
        maxRegionPhoneLength,
        countryFlag,
        recordDate,
        offsetHrsVsUtc,
        timezoneURL
      FROM phoneInfo
      ORDER BY regionName ASC
    `);

    // Limit parallelism to avoid hammering external sites
    const limit = 8;
    let i = 0;

    async function fetchOne(url) {
      if (!url) return { ok: false, error: 'no_url' };
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 20000);
        const resp = await fetch(url, { redirect: 'follow', signal: controller.signal });
        clearTimeout(t);

        // Small preview to keep payload reasonable
        const text = await resp.text();
        const preview = text.slice(0, 200);

        return {
          ok: true,
          status: resp.status,
          finalURL: resp.url,
          preview
        };
      } catch (err) {
        return { ok: false, error: String(err.message || err) };
      }
    }

    async function* chunked(arr, n) {
      for (let k = 0; k < arr.length; k += n) {
        yield arr.slice(k, k + n);
      }
    }

    const enriched = [];
    for await (const chunk of chunked(rows, limit)) {
      const results = await Promise.all(
        chunk.map(r => fetchOne(r.timezoneURL))
      );
      for (let j = 0; j < chunk.length; j++) {
        const r = chunk[j];
        const site = results[j];
        enriched.push({
          ...r,
          website: site
        });
      }
    }

    // Optional ETag for the enriched payload (exclude volatile site previews if you prefer)
    res.set('Cache-Control', 'no-store'); // site response changes frequently; disable caching by default
    return res.json({ count: enriched.length, rows: enriched });
  } catch (e) {
    console.error('GET /phone/regions/with-sites error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

export default router;
