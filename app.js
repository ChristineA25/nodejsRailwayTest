
// Only load .env during local development
if (process.env.NODE_ENV !== 'production') {
  try { require('dotenv').config(); } catch (_) {}
}

// app.js
'use strict';

const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { pool } = require('./db');

const app = express();
app.use(express.json({ limit: '10kb' }));

/* ------------------------------------------------------------------ */
/*                          Key Management                             */
/* ------------------------------------------------------------------ */
function loadKeyFromEnv(envName, expectedLen) {
  const b64 = process.env[envName];
  if (!b64) throw new Error(`${envName}_missing`);
  const buf = Buffer.from(b64, 'base64');
  if (buf.length !== expectedLen) {
    throw new Error(`${envName}_must_be_${expectedLen}_bytes_base64`);
  }
  return buf;
}

let DET_KEY;
try {
  DET_KEY = loadKeyFromEnv('DETERMINISTIC_KEY', 32);
} catch (e) {
  console.warn('⚠️ Key load warning:', e.message);
}

/* ------------------------------------------------------------------ */
/*                   Deterministic Tokenization                        */
/* ------------------------------------------------------------------ */
function detTokenBase64(plain) {
  if (plain === null || plain === undefined) return null;
  if (!DET_KEY) throw new Error('DETERMINISTIC_KEY_missing');
  const mac = crypto.createHmac('sha256', DET.createHmac)
    .update(String(plain), 'utf8')
    .digest();
  return mac.toString('base64');
}

/* ------------------------------------------------------------------ */
/*                        Email Normalization                          */
/* ------------------------------------------------------------------ */
function normalizeEmail(email) {
  if (!email) return null;
  return String(email).trim().toLowerCase();
}

/* ------------------------------------------------------------------ */
/*                        Build E164                                   */
/* ------------------------------------------------------------------ */
function buildE164({ phoneE164, phone_country_code, phone_number }) {
  const isValidE164 = (v) => typeof v === 'string' && /^\+\d{6,15}$/.test(v);

  if (isValidE164(phoneE164)) return phoneE164;

  const ccRaw = (phone_country_code || '').toString().trim();
  const localRaw = (phone_number || '').toString().trim();

  if (!ccRaw.startsWith('+')) throw new Error('invalid_country_code');

  const ccDigits = ccRaw.replace(/[^\d]/g, '');
  const localDigits = localRaw.replace(/\D+/g, '');

  const combined = `+${ccDigits}${localDigits}`;
  if (!isValidE164(combined)) throw new Error('invalid_e164_combination');

  return combined;
}

/* ------------------------------------------------------------------ */
/*                          Health & Static                            */
/* ------------------------------------------------------------------ */
app.get('/health', (req, res) => res.status(200).send('ok'));
app.use(express.static(path.join(__dirname, 'public')));

let indexRouterMounted = false;
try {
  const indexRouter = require('./routes/index');
  app.use('/', indexRouter);
  indexRouterMounted = true;
} catch (err) {
  console.error('❌ Failed to load ./routes/index:', err.message);
}

/* ------------------------------------------------------------------ */
/*                             API: Signup                             */
/* ------------------------------------------------------------------ */
app.post('/api/signup', async (req, res) => {
  try {
    const {
      userID,
      identifierType,
      username, password, email,
      phone_country_code, phone_number, phoneE164,
      secuQuestion1, secuAns1, secuQuestion2, secuAns2, secuQuestion3, secuAns3
    } = req.body || {};

    if (!userID) return res.status(400).json({ error: 'userID_required' });
    if (!password) return res.status(400).json({ error: 'password_required' });

    if (identifierType === 'username' && !username) {
      return res.status(400).json({ error: 'username_required' });
    }
    if (identifierType === 'email' && !email) {
      return res.status(400).json({ error: 'email_required' });
    }
    if (identifierType === 'phone' && !phone_number && !phoneE164) {
      return res.status(400).json({ error: 'phone_number_required' });
    }

    const passwordHash = await bcrypt.hash(String(password), 12);

    // email & phone tokenization
    let emailEnc = null;
    let phoneEnc = null;
    let phoneE164Final = null;

    try {
      if (email) {
        const normEmail = normalizeEmail(email);
        emailEnc = normEmail ? detTokenBase64(normEmail) : null;
      }

      if (identifierType === 'phone' || phoneE164) {
        phoneE164Final = buildE164({
          phoneE164,
          phone_country_code,
          phone_number,
        });
        phoneEnc = detTokenBase64(phoneE164Final);
      }
    } catch (errTok) {
      return res.status(500).json({ error: errTok.message || 'tokenization_failed' });
    }

    // Insert in DB
    const sql = `
      INSERT INTO loginTable
        (userID, username, password, phone_country_code,
         secuQuestion1, secuAns1, secuQuestion2, secuAns2, secuQuestion3, secuAns3,
         email_enc, phone_number_enc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
      userID,
      username ?? null,
      passwordHash,
      phone_country_code ?? null,
      secuQuestion1 ?? null,
      secuAns1 ?? null,
      secuQuestion2 ?? null,
      secuAns2 ?? null,
      secuQuestion3 ?? null,
      secuAns3 ?? null,
      emailEnc,
      phoneEnc
    ];

    await pool.execute(sql, params);
    return res.status(201).json({ userID });

  } catch (err) {
    const msg = err?.message || 'unknown_error';
    const code = err?.code || null;

    if (code === 'ER_DUP_ENTRY') {
      const raw = (err.sqlMessage || err.message || '').toLowerCase();
      let field = 'identifier';

      if (raw.includes('email_enc')) field = 'email';
      else if (raw.includes('phone_number_enc')) field = 'phone';
      else if (raw.includes('username')) field = 'username';
      else if (raw.includes('secuans1') || raw.includes('secuans2') || raw.includes('secuans3')) field = 'security answer';

      // Default
      return res.status(409).json({
        error: 'duplicate_identifier',
        field,
        message: `${field} already in use. Please use another.`
      });
    }

    return res.status(500).json({ error: msg });
  }
});

/* ------------------------------------------------------------------ */
/*                           404                                       */
/* ------------------------------------------------------------------ */
app.use((req, res) => {
  const fallback404 = path.join(__dirname, 'views', '404.html');
  res.status(404).sendFile(fallback404, (err) => {
    if (err) res.status(404).type('text').send('404 – Not Found');
  });
});

/* ------------------------------------------------------------------ */
/*                           Server Listen                             */
/* ------------------------------------------------------------------ */
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server on ${PORT}`);
});
