
// app.js
// Unifies: static + /health + phone validation + /api/signup
// Works with your Flutter signup_page.dart which calls /phone/regions, /phone/validate,
// then POSTs to /api/signup including client-supplied userID.  (See signup_page.dart) 

const express = require('express');
const path = require('path');
const crypto = require('crypto'); // for encryption
const mysql = require('mysql2/promise'); // MySQL connection
const indexRouter = require('./routes/index');
const bcrypt = require('bcryptjs');
const { pool } = require('./db'); // db.js should export a mysql2/promise pool
// Optional: enable if you deploy behind proxies or need CORS
// const cors = require('cors');

const app = express();
const PORT = 3000;

// Middleware
app.use(express.json()); // parse JSON bodies
// ---- Middleware ----
app.use(express.json());
// app.use(cors()); // uncomment if you call from a different origin (e.g., Flutter web)
app.use(express.static(path.join(__dirname, 'public')));
app.use('/', indexRouter);

// MySQL connection pool
const pool = mysql.createPool({
    host: 'YOUR_MYSQL_HOST',
    user: 'YOUR_MYSQL_USER',
    password: 'YOUR_MYSQL_PASSWORD',
    database: 'YOUR_DATABASE',

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
// Phone metadata + validation endpoints (kept simple; enough for your Flutter)
// ============================================================================
/**
 * Minimal region dataset (extend as needed). min/max = expected local digits
 * EXCLUDING the country code. For GB we expect 10 digits (e.g., '7123456789').
 */
const PHONE_REGIONS = [
  { iso2: 'GB', name: 'United Kingdom', code: '+44', displayCode: '+44', min: 10, max: 10, trunkPrefix: '0' },
  { iso2: 'HK', name: 'Hong Kong',     code: '+852',                   min: 8,  max: 8,  trunkPrefix: ''  },
  { iso2: 'US', name: 'United States', code: '+1',                     min: 10, max: 10, trunkPrefix: ''  },
];

const DIGITS_ONLY = /^\d+$/;

/** GET /phone/regions — what the Flutter page loads into the country dropdown. */
app.get('/phone/regions', (_req, res) => {
  res.json({ regions: PHONE_REGIONS });
});

/**
 * POST /phone/validate
 * Body: { iso2: 'GB'|'HK'|'US'... , local: 'digits only' (no spaces), optional: { allowLoose: boolean } }
 * Returns: { valid: boolean, e164?: string, reason?: string }
 */
app.post('/phone/validate', (req, res) => {
  try {
    const { iso2, local } = req.body || {};
    if (!iso2 || typeof iso2 !== 'string') {
      return res.status(400).json({ valid: false, reason: 'iso2_required' });
    }
    const region = PHONE_REGIONS.find(r => r.iso2.toUpperCase() === iso2.toUpperCase());
    if (!region) {
      return res.status(400).json({ valid: false, reason: 'unsupported_country' });
    }
    if (!local || typeof local !== 'string' || !DIGITS_ONLY.test(local)) {
      return res.status(200).json({ valid: false, reason: 'digits_only' });
    }

    // length check (expects local length excluding country code, usually without trunk '0')
    if (local.length < region.min || local.length > region.max) {
      return res.status(200).json({
        valid: false,
        reason: `expected_${region.min}_${region.max}_digits`,
      });
    }

    // Build E.164 (very light rules)
    let national = local;
    // If user mistakenly included a trunk '0' in the local (rare with your UI), strip one leading '0' for GB.
    if (region.trunkPrefix === '0' && national.startsWith('0')) {
      national = national.replace(/^0/, '');
    }
    const e164 = `${region.code}${national}`;

    return res.json({ valid: true, e164 });
  } catch (err) {
    console.error('phone/validate error:', err);
    return res.status(500).json({ valid: false, reason: 'server_error' });
  }
});

// Signup route
app.post('/signup', async (req, res) => {
    try {
        const { identifier, password, questions, answers } = req.body;

        // Generate encrypted userID from current time + identifier
        const rawString = `${Date.now()}-${identifier}`;
        const userID = crypto.createHash('sha256').update(rawString).digest('hex');

        // Insert into MySQL
        const sql = `INSERT INTO users (userID, identifier, password, q1, a1, q2, a2, q3, a3)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        await pool.execute(sql, [
            userID,
            identifier,
            password,
            questions[0],
            answers[0],
            questions[1],
            answers[1],
            questions[2],
            answers[2],
        ]);

        res.json({ success: true, userID });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: 'Server error' });
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
    const normPhoneCode =
      (typeof phoneCountryCode === 'string' && phoneCountryCode.trim()) ||
      (typeof phone_country_code === 'string' && phone_country_code.trim()) ||
      null;

    const normPhoneLocal =
      (typeof phoneLocal === 'string' && phoneLocal.trim()) ||
      (typeof phone_number === 'string' && phone_number.trim()) ||
      null;

    // (Optional) sanity: ensure digits-only for local if provided
    const localDigitsOnly = normPhoneLocal && /^\d{1,20}$/.test(normPhoneLocal);
    if (normPhoneLocal && !localDigitsOnly) {
      return res.status(400).json({ error: 'phone_local_digits_only' });
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
    const params = [
      userID,
      username ?? null,
      hashed,
      email ?? null,
      normPhoneCode ?? null,
      normPhoneLocal ?? null,
      secuQuestion1 ?? null,
      secuAns1 ?? null,
      secuQuestion2 ?? null,
      secuAns2 ?? null,
      secuQuestion3 ?? null,
      secuAns3 ?? null,
    ];

    await pool.execute(sql, params);

    // You could also store phoneE164 in another column if your schema has one.

    return res.status(201).json({ userID });
  } catch (err) {
    const msg = (err && err.message) ? err.message : 'unknown_error';
    const code = (err && err.code) ? err.code : null;

    if (code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'duplicate_identifier' });
    }
    console.error('signup error:', err);
    return res.status(500).json({ error: msg });
  }
});

// 404 handler
app.use((req, res, next) => {
    res.status(404).sendFile(path.join(__dirname, 'views', '404.html'));
// ---- 404 fallback after routes + static ----
app.use((req, res) => {
  const fallback404 = path.join(__dirname, 'views', '404.html');
  res.status(404).sendFile(fallback404, (sendErr) => {
    if (sendErr) {
      res.status(404).type('text').send('404 – Not Found');
    }
  });
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
// ---- Start server (Railway sets PORT) ----
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server listening on http://0.0.0.0:${PORT}`);
});
``
