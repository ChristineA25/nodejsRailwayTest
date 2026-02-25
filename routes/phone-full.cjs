
// routes/phone-full.js (CommonJS)
'use strict';
const express = require('express');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const router = express.Router();

// Reuse your central pool if you already export it: const { pool } = require('../db');
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

// GET /phone/regions/raw
router.get('/regions/raw', async (req, res) => {
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

    const etag = '"' + crypto.createHash('sha1')
      .update(JSON.stringify(rows))
      .digest('hex') + '"';

    if (req.headers['if-none-match'] === etag) {
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

// GET /phone/regions/with-sites
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

    const limit = 8;
    async function fetchOne(url) {
      if (!url) return { ok: false, error: 'no_url' };
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 8000);
        const resp = await fetch(url, { redirect: 'follow', signal: controller.signal });
        clearTimeout(t);
        const text = await resp.text();
        return {
          ok: true,
          status: resp.status,
          finalURL: resp.url,
          preview: text.slice(0, 200)
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
      const results = await Promise.all(chunk.map(r => fetchOne(r.timezoneURL)));
      for (let j = 0; j < chunk.length; j++) {
        enriched.push({ ...chunk[j], website: results[j] });
      }
    }

    res.set('Cache-Control', 'no-store');
    return res.json({ count: enriched.length, rows: enriched });
  } catch (e) {
    console.error('GET /phone/regions/with-sites error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
