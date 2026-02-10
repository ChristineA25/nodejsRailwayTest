
// encrypt.js
// AES-256-GCM field encryption for PII (email, phone, etc.)
const crypto = require('crypto');

function getFieldKey() {
  const b64 = process.env.FIELD_ENC_KEY || '';
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) {
    throw new Error('FIELD_ENC_KEY must be a base64-encoded 32-byte key (AES-256-GCM)');
  }
  return key;
}

function encryptField(plain) {
  if (plain == null) return null;
  const key = getFieldKey();
  const iv = crypto.randomBytes(12); // 96-bit nonce for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Persist as iv:tag:ciphertext (all base64)
  return `${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

module.exports = { encryptField };
