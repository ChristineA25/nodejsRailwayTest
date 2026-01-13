
// app.js
// Unifies: static + /health + DB-backed phone validation + /api/signup
// Works with your Flutter signup_page.dart which calls /phone/regions, /phone/validate,
// then POSTs to /api/signup including client-supplied userID.  (See signup_page.dart)

const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool } = require('./db'); // db.js should export a mysql2/promise pool
// Optional: enable if you deploy behind proxies or need CORS
// const cors = require('cors');

const app = express();

// ---- Middleware ----
app.use(express.json());
// app.use(cors()); // uncomment if you call from a different origin (e.g., Flutter web)
app.use(express.static(path.join(__dirname, 'public')));

// Simple health endpoint (Railway/uptime)
app.get('/health', (req, res) => res.status(200).send('ok'));

// ---- Optional index router (don't crash if missing) ----
try {
  const indexRouter = require('./routes/index');
  app.use('/', indexRouter);
  console.log('✅ indexRouter mounted');
} catch (err) {
  console.warn('⚠️ indexRouter not found (./routes/index). Static files + APIs only.');
}

// ============================================================================
// Phone metadata + validation endpoints (DB-backed)
// ============================================================================

/**
 * Normalize a "+ code" value into "+<digits>" (e.g., "+ 1-264" -> "+1264").
 */
const NORMALIZE_CODE = (code) =>
  String(code || '')
    .trim()
    .replace(/\s+/g, '')  // remove spaces
    .replace(/-/g, '')    // remove hyphens
    .replace(/^(\+)?(\d+)$/, '+$2'); // ensure single leading '+'

const DIGITS_ONLY = /^\d+$/;

/**
 * GET /phone/regions — returns the country dropdown dataset from DB.
 * Maps:
 *   phoneInfo.countryFlag  -> iso2 (alpha-2)
 *   phoneInfo.regionName   -> name
 *   phoneInfo.regionPhoneCode -> code (normalized)
 *   phoneInfo.minRegionPhoneLength / maxRegionPhoneLength -> min/max
 */
app.get('/phone/regions', async (_req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT countryFlag AS iso2,
             regionName AS name,
             regionPhoneCode AS code,
             minRegionPhoneLength AS min,
             maxRegionPhoneLength AS max
      FROM phoneInfo
      ORDER BY name ASC
    `);

    // Normalize for the client
    const regions = rows.map((r) => ({
      iso2: String(r.iso2 || '').toUpperCase(), // e.g., 'GB'
      name: String(r.name || ''),
      code: NORMALIZE_CODE(r.code),              // e.g., '+44'
      displayCode: NORMALIZE_CODE(r.code),
      min: Number(r.min || 0),
      max: Number(r.max || 0),
      trunkPrefix: '' // optional future support; not present in your table now
    }));

    res.json({ regions });
  } catch (err) {
    console.error('GET /phone/regions error:', err);
    // Fallback keeps the screen usable if DB query fails
    res.status(200).json({
      regions: [
        { iso2: 'GB', name: 'United Kingdom', code: '+44', displayCode: '+44', min: 10, max: 10, trunkPrefix: '0' }
      ]
    });
  }
});

/**
 * POST /phone/validate
 * Body: { iso2: 'GB'|'HK'|'US'... , local: 'digits only' (no spaces) }
 * Uses DB (phoneInfo) as the source of truth.
 * Returns: { valid: boolean, e164?: string, reason?: string }
 */
app.post('/phone/validate', async (req, res) => {
  try {
    const { iso2, local } = req.body || {};
    if (!iso2 || typeof iso2 !== 'string') {
      return res.status(400).json({ valid: false, reason: 'iso2_required' });
    }
    if (!local || typeof local !== 'string' || !DIGITS_ONLY.test(local)) {
      return res.status(200).json({ valid: false, reason: 'digits_only' });
    }

    const iso2Up = iso2.toUpperCase().trim();

    const [rows] = await pool.execute(
      `
      SELECT regionPhoneCode AS code,
             minRegionPhoneLength AS min,
             maxRegionPhoneLength AS max
      FROM phoneInfo
      WHERE countryFlag = ?
      LIMIT 1
      `,
      [iso2Up]
    );

    if (!rows || rows.length === 0) {
      return res.status(400).json({ valid: false, reason: 'unsupported_country' });
    }

    const code = NORMALIZE_CODE(rows[0].code);
    const min = Number(rows[0].min || 0);
    const max = Number(rows[0].max || 0);

    // Length check for the local (national) number, excluding country code.
    if (local.length < min || local.length > max) {
      return res.status(200).json({ valid: false, reason: `expected_${min}_${max}_digits` });
    }

    // NOTE: No trunk handling here because your table doesn't include it.
    // If you later add a trunk column, strip/handle it here per-country.
    const national = local;

    // Build canonical E.164
    const e164 = `${code}${national}`;

    return res.json({ valid: true, e164 });
  } catch (err) {
    console.error('phone/validate error:', err);
    return res.status(500).json({ valid: false, reason: 'server_error' });
  }
});

// ============================================================================
// POST /api/signup — expects a client-supplied userID (from Flutter)
// ============================================================================

/**
 * Expected JSON (any one of username/email/phone can be present):
 * {
 *   "userID": "123456789012345" | "hex-64",
 *   "username": "chris",              // optional
 *   "email": "me@example.com",        // optional
 *   // New phone-style keys (preferred from Flutter):
 *   "phoneCountryISO2": "GB",
 *   "phoneCountryCode": "+44",
 *   "phoneLocal": "7123456789",
 *   "phoneE164": "+447123456789",
 *   // Legacy keys (still accepted):
 *   "phone_country_code": "+44",
 *   "phone_number": "7123456789",
 *   // Secrets:
 *   "password": "Passw0rd!123",
 *   "secuQuestion1": "...", "secuAns1": "...",
 *   "secuQuestion2": "...", "secuAns2": "...",
 *   "secuQuestion3": "...", "secuAns3": "..."
 * }
 */
app.post('/api/signup', async (req, res) => {
  try {
    const {
      userID,
      username,
      email,
      password,
      // Preferred (new) keys coming from Flutter
      phoneCountryISO2,
      phoneCountryCode,
      phoneLocal,
      phoneE164,
      // Legacy keys (older client)
      phone_country_code,
      phone_number,
      // Security Q&As
      secuQuestion1, secuAns1,
      secuQuestion2, secuAns2,
      secuQuestion3, secuAns3,
    } = req.body || {};

    // -------- Basic validation --------
    if (userID === undefined || userID === null || userID === '') {
      return res.status(400).json({ error: 'userID_required' });
    }
    if (!password) {
      return res.status(400).json({ error: 'password_required' });
    }

    // Normalize phone fields (support both new + legacy keys)
    const normISO2 =
      typeof phoneCountryISO2 === 'string' && phoneCountryISO2.trim()
        ? phoneCountryISO2.toUpperCase().trim()
        : null;

    const normPhoneCode =
      (typeof phoneCountryCode === 'string' && phoneCountryCode.trim()) ||
      (typeof phone_country_code === 'string' && phone_country_code.trim()) ||
      null;

    const normPhoneLocal =
      (typeof phoneLocal === 'string' && phoneLocal.trim()) ||
      (typeof phone_number === 'string' && phone_number.trim()) ||
      null;

    // (Optional) sanity: ensure digits-only for local if provided
    if (normPhoneLocal && !/^\d{1,20}$/.test(normPhoneLocal)) {
      return res.status(400).json({ error: 'phone_local_digits_only' });
    }

    let codeFromDB = null;
    let computedE164 = null;

    // If phone fields are present, re-validate against DB (source of truth).
    if (normISO2 && normPhoneLocal) {
      const [rows] = await pool.execute(
        `
        SELECT regionPhoneCode AS code,
               minRegionPhoneLength AS min,
               maxRegionPhoneLength AS max
        FROM phoneInfo
        WHERE countryFlag = ?
        LIMIT 1
        `,
        [normISO2]
      );

      if (!rows || rows.length === 0) {
        return res.status(400).json({ error: 'unsupported_country' });
      }

      codeFromDB = NORMALIZE_CODE(rows[0].code);
      const min = Number(rows[0].min || 0);
      const max = Number(rows[0].max || 0);

      if (normPhoneLocal.length < min || normPhoneLocal.length > max) {
        return res.status(400).json({ error: `expected_${min}_${max}_digits` });
      }

      computedE164 = `${codeFromDB}${normPhoneLocal}`;

      // If the client supplied a code, ensure it matches the DB's code.
      if (normPhoneCode && NORMALIZE_CODE(normPhoneCode) !== codeFromDB) {
        return res.status(400).json({ error: 'country_code_mismatch' });
      }

      // If the client supplied phoneE164, ensure it matches our computed one.
      if (typeof phoneE164 === 'string' && phoneE164.trim() && phoneE164.trim() !== computedE164) {
        return res.status(400).json({ error: 'e164_mismatch' });
      }
    }

    // Hash password
    const hashed = await bcrypt.hash(String(password), 12);

    // Build final params for DB insert
    const sql = `
      INSERT INTO loginTable
        (userID, username, password, email, phone_country_code, phone_number,
         secuQuestion1, secuAns1, secuQuestion2, secuAns2, secuQuestion3, secuAns3)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const codeToStore =
      codeFromDB
        ? codeFromDB
        : (normPhoneCode ? NORMALIZE_CODE(normPhoneCode) : null);

    const params = [
      userID,
      username ?? null,
      hashed,
      email ?? null,
      codeToStore ?? null,
      normPhoneLocal ?? null,
      secuQuestion1 ?? null,
      secuAns1 ?? null,
      secuQuestion2 ?? null,
      secuAns2 ?? null,
      secuQuestion3 ?? null,
      secuAns3 ?? null,
    ];

    await pool.execute(sql, params);

    // You could also store computedE164 into a dedicated column if your schema has one.

    return res.status(201).json({ userID });
  } catch (err) {
    const msg = (err && err.message) ? err.message : 'unknown_error';

    if (err && err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'duplicate_identifier' });
    }
    console.error('signup error:', err);
    return res.status(500).json({ error: msg });
  }
});

// ---- 404 fallback after routes + static ----
app.use((req, res) => {
  const fallback404 = path.join(__dirname, 'views', '404.html');
  res.status(404).sendFile(fallback404, (sendErr) => {
    if (sendErr) {
      res.status(404).type('text').send('404 – Not Found');
    }
  });
});

// ---- Start server (Railway sets PORT) ----
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server listening on http://0.0.0.0:${PORT}`);
});
