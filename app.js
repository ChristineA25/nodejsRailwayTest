
// app.js
// Unifies: static + /health + phone validation + /api/signup
// Works with your Flutter signup_page.dart which calls /phone/regions, /phone/validate,
// then POSTs to /api/signup including client-supplied userID.  (See signup_page.dart) 

const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool } = require('./db');          // use the single pool from ./db
const { encryptField } = require('./encrypt'); // <<< add this
// const cors = require('cors'); // optional

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

// /api/signup
const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { pool } = require('./db');

const app = express();
app.use(express.json());

// ---------- small crypto helpers (AES-256-GCM) ----------
function getFieldKey() {
  const b64 = process.env.FIELD_ENC_KEY || '';
  // Expect exactly 32 bytes after base64 decode
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) {
    throw new Error('FIELD_ENC_KEY must be a base64-encoded 32-byte key (AES-256)');
  }
  return key;
}
function encryptField(plain) {
  if (plain == null) return null;
  const key = getFieldKey();
  const iv = crypto.randomBytes(12); // GCM nonce
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Store as iv:tag:ciphertext (base64)
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

// ---------- health + static ----------
app.get('/health', (req, res) => res.status(200).send('ok'));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- POST /api/signup ----------
/**
 * Expected JSON:
 * {
 *   "userID": "client-supplied id",
 *   "identifierType": "username" | "email" | "phone",
 *   // username mode:
 *   "username": "chris",
 *   // email mode:
 *   "email": "me@example.com",
 *   // phone mode (local only and country code separate):
 *   "phone_country_code": "+44",
 *   "phone_number": "7123456789",         // local digits only (no '+' and no spaces)
 *   // Password (required in all modes):
 *   "password": "Passw0rd!123",
 *   // Optional security questions:
 *   "secuQuestion1": "...", "secuAns1": "...",
 *   "secuQuestion2": "...", "secuAns2": "...",
 *   "secuQuestion3": "...", "secuAns3": "..."
 * }
 */
app.post('/api/signup', async (req, res) => {
  try {
    const {
      userID,
      identifierType,
      username,
      email,
      phone_country_code,
      phone_number, // local
      password,
      secuQuestion1, secuAns1,
      secuQuestion2, secuAns2,
      secuQuestion3, secuAns3,
    } = req.body || {};

    // ---------- basic validation ----------
    if (!userID && userID !== 0) {
      return res.status(400).json({ error: 'userID_required' });
    }
    if (!password) {
      return res.status(400).json({ error: 'password_required' });
    }
    if (!identifierType || !['username', 'email', 'phone'].includes(String(identifierType))) {
      return res.status(400).json({ error: 'identifierType_invalid' });
    }

    // ---------- mode-specific validation ----------
    let usernameToStore = null;
    let emailEnc = null;
    let phoneCodeToStore = null;
    let phoneLocalEnc = null;

    if (identifierType === 'username') {
      if (!username) return res.status(400).json({ error: 'username_required' });
      usernameToStore = String(username);
    } else if (identifierType === 'email') {
      if (!email) return res.status(400).json({ error: 'email_required' });
      emailEnc = encryptField(String(email).trim());
    } else if (identifierType === 'phone') {
      if (!phone_country_code) return res.status(400).json({ error: 'phone_country_code_required' });
      if (!phone_number || !/^\d{1,20}$/.test(String(phone_number))) {
        return res.status(400).json({ error: 'phone_number_digits_only' });
      }
      phoneCodeToStore = String(phone_country_code).trim();     // plain
      phoneLocalEnc = encryptField(String(phone_number).trim()); // encrypted
    }

    // ---------- hash password ----------
    const hashed = await bcrypt.hash(String(password), 12);

    // ---------- insert (write only correct columns) ----------
    const sql = `
      INSERT INTO loginTable
        (userID, username, password, email, phone_country_code, phone_number,
         secuQuestion1, secuAns1, secuQuestion2, secuAns2, secuQuestion3, secuAns3)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const params = [
      userID,
      usernameToStore,
      hashed,
      emailEnc,
      phoneCodeToStore,
      phoneLocalEnc,
      secuQuestion1 ?? null, secuAns1 ?? null,
      secuQuestion2 ?? null, secuAns2 ?? null,
      secuQuestion3 ?? null, secuAns3 ?? null,
    ];

    await pool.execute(sql, params);
    return res.status(201).json({ userID });
  } catch (err) {
    const code = err && err.code ? err.code : null;
    if (code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'duplicate_identifier' });
    }
    console.error('signup error:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// ---------- 404 fallback ----------
app.use((req, res) => {
  res.status(404).type('text').send('404 – Not Found');
});

// ---------- start ----------
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server listening on http://0.0.0.0:${PORT}`);
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
