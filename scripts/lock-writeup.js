#!/usr/bin/env node
// Seal a write-up body behind a passphrase for the "public SEO shell, private
// content" pattern: the page indexes (title + teaser stay plaintext) but the
// solution to a still-active HTB box is AES-encrypted and unreadable without the
// passphrase. Native Node crypto in, browser crypto.subtle out (_includes/locked-writeup.html).
//
//   node scripts/lock-writeup.js body.md 'passphrase'  > blob.json
//
// Params below MUST match the decryptor: PBKDF2-HMAC-SHA256 / AES-256-GCM,
// ciphertext carries the 16-byte GCM tag appended (what SubtleCrypto expects).
const crypto = require('crypto');
const fs = require('fs');

const [, , file, passphrase] = process.argv;
if (!file || !passphrase) {
  console.error("usage: node scripts/lock-writeup.js <body.md> '<passphrase>'");
  process.exit(1);
}
const ITER = 250000;
const plaintext = fs.readFileSync(file);
const salt = crypto.randomBytes(16);
const iv = crypto.randomBytes(12);
const key = crypto.pbkdf2Sync(passphrase, salt, ITER, 32, 'sha256');
const c = crypto.createCipheriv('aes-256-gcm', key, iv);
const ct = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);

process.stdout.write(JSON.stringify({
  v: 1, iter: ITER,
  salt: salt.toString('base64'),
  iv: iv.toString('base64'),
  ct: ct.toString('base64'),
}));

// ponytail: self-check — round-trips the ciphertext back to the source bytes.
const dsalt = Buffer.from(salt), div = Buffer.from(iv), dct = Buffer.from(ct);
const dkey = crypto.pbkdf2Sync(passphrase, dsalt, ITER, 32, 'sha256');
const d = crypto.createDecipheriv('aes-256-gcm', dkey, div);
d.setAuthTag(dct.slice(dct.length - 16));
const round = Buffer.concat([d.update(dct.slice(0, dct.length - 16)), d.final()]);
if (!round.equals(plaintext)) { console.error('\nself-check FAILED'); process.exit(1); }
