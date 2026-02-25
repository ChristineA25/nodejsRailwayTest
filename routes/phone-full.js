
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

// routes/phone-full.js (ESM) — improved /with-sites
router.get('/regions/with-sites', async (req, res) => {
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

    // --- Config (with safe defaults) ---
    const timeoutMs   = Math.max(1000, Math.min(parseInt(req.query.timeoutMs ?? '12000', 10), 60000)); // default 12s
    const concurrency = Math.max(1,     Math.min(parseInt(req.query.concurrency ?? '6', 10), 16));     // default 6
    const overallMs   = Math.max(timeoutMs, Math.min(parseInt(req.query.overallMs ?? '60000', 10), 180000)); // default 60s

    // --- Global deadline so the endpoint never hangs forever ---
    const parent = new AbortController();
    const overallTimer = setTimeout(() => parent.abort(), overallMs);

    // Per-site fetch with its own timer, tied to the parent controller
    async function fetchOne(url) {
      if (!url) return { ok: false, error: 'no_url' };
      const ctl = new AbortController();

      // If parent aborts, abort child too
      const onAbort = () => ctl.abort();
      parent.signal.addEventListener('abort', onAbort, { once: true });

      const perTimer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const resp = await fetch(url, { redirect: 'follow', signal: ctl.signal });
        const text = await resp.text();
        return {
          ok: true,
          status: resp.status,
          finalURL: resp.url,
          preview: text.slice(0, 200),
          timeMs: undefined // add timing if you want (see previous message)
        };
      } catch (err) {
        const isAbort = err && (err.name === 'AbortError' || /aborted/i.test(String(err.message)));
        return { ok: false, error: isAbort ? 'timeout' : String(err.message || err) };
      } finally {
        clearTimeout(perTimer);
        parent.signal.removeEventListener('abort', onAbort);
      }
    }

    // Simple concurrency limiter
    async function mapLimited(items, limit, fn) {
      const out = new Array(items.length);
      let next = 0;
      const workers = Array.from({ length: limit }, async () => {
        while (true) {
          const i = next++;
          if (i >= items.length) break;
          out[i] = await fn(items[i], i);
        }
      });
      await Promise.race([Promise.all(workers), new Promise((_, rej) => {
        parent.signal.addEventListener('abort', () => rej(new Error('overall-timeout')), { once: true });
      })]);
      return out;
    }

    let enriched, partial = false;
    try {
      enriched = await mapLimited(rows, concurrency, async (r) => {
        const site = await fetchOne(r.timezoneURL);
        return { ...r, website: site };
      });
    } catch (e) {
      // overall timeout fired: return whatever we have so far
      partial = true;
      // Fill the remainder if needed
      enriched = (enriched ?? []).concat(rows.slice((enriched?.length ?? 0)).map((r) => ({
        ...r, website: { ok: false, error: 'timeout' }
      })));
    } finally {
      clearTimeout(overallTimer);
    }

    res.set('Cache-Control', 'no-store');
    return res.json({ count: enriched.length, partial, rows: enriched });
  } catch (e) {
    console.error('GET /phone/regions/with-sites error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

export default router;
