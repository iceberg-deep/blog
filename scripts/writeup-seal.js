#!/usr/bin/env node
// Convert an HTB write-up between ACTIVE (sealed) and RETIRED (plaintext) form.
// The two directions are exact inverses.
//
//   WRITEUP_PASS='...' node scripts/writeup-seal.js unseal _posts/2026-07-16-....md
//   WRITEUP_PASS='...' node scripts/writeup-seal.js seal   _posts/2026-07-16-....md
//   node scripts/writeup-seal.js selfcheck        # round-trip proof, no files touched
//
// Flags: --redate=YYYY-MM-DD  (unseal only) re-date to retire+7; renames the file and
//        rewrites the yml url/date. CHANGES THE PUBLIC URL — off by default to keep SEO.
//
// A plaintext (retired) post keeps its body between two invisible HTML-comment markers:
//     ...teaser...
//     <!-- seal:body -->
//     ## 0x01 · ...            (the full chain)
//     <!-- seal:end -->
//     ---
//     *footer*
// `seal` encrypts everything between the markers into the gate block; `unseal` restores it.
// Crypto params MUST match _includes/locked-writeup.html and scripts/lock-writeup.js:
//   PBKDF2-HMAC-SHA256, 250k iters, AES-256-GCM, 16-byte salt, 12-byte iv, tag appended to ct.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ITER = 250000;
const GATE_RE = /<script type="application\/json" id="lock-data">[\s\S]*?<\/script>\s*\{%\s*include\s+locked-writeup\.html\s*%\}/;
const BODY_RE = /<!--\s*seal:body\s*-->\s*([\s\S]*?)\s*<!--\s*seal:end\s*-->/;

function encrypt(plaintext, pass) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(pass, salt, ITER, 32, 'sha256');
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(plaintext, 'utf8')), c.final(), c.getAuthTag()]);
  return JSON.stringify({ v: 1, iter: ITER, salt: salt.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64') });
}
function decrypt(blobJson, pass) {
  const b = JSON.parse(blobJson);
  const key = crypto.pbkdf2Sync(pass, Buffer.from(b.salt, 'base64'), b.iter, 32, 'sha256');
  const ct = Buffer.from(b.ct, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(b.iv, 'base64'));
  d.setAuthTag(ct.slice(-16));
  return Buffer.concat([d.update(ct.slice(0, -16)), d.final()]).toString('utf8');
}

// --- pure string transforms (no fs/yml) so selfcheck can round-trip them ---
function toSealed(content, pass) {
  const m = content.match(BODY_RE);
  if (!m) throw new Error('no <!-- seal:body -->...<!-- seal:end --> markers found — already sealed?');
  const head = content.slice(0, m.index).replace(/\s+$/, '');
  const tail = content.slice(m.index + m[0].length).replace(/^\s+/, '');
  const gate = `<script type="application/json" id="lock-data">${encrypt(m[1].trim(), pass)}</script>\n\n{% include locked-writeup.html %}`;
  return `${head}\n\n${gate}\n\n${tail}`.replace(/\s*$/, '\n');
}
function toUnsealed(content, pass) {
  const m = content.match(GATE_RE);
  if (!m) throw new Error('no lock-data gate found — already unsealed?');
  const blob = content.match(/id="lock-data">([\s\S]*?)<\/script>/)[1];
  const body = decrypt(blob, pass);
  const head = content.slice(0, m.index).replace(/\s+$/, '');
  const tail = content.slice(m.index + m[0].length).replace(/^\s+/, '');
  return `${head}\n\n<!-- seal:body -->\n\n${body.trim()}\n\n<!-- seal:end -->\n\n${tail}`.replace(/\s*$/, '\n');
}

// --- yml: toggle `sealed: true` on the entry whose url matches this post ---
function postUrl(file) {
  const m = path.basename(file).match(/^(\d{4})-(\d{2})-(\d{2})-(.+)\.md$/);
  if (!m) throw new Error('post filename must be YYYY-MM-DD-slug.md');
  return { url: `/${m[1]}/${m[2]}/${m[3]}/${m[4]}.html`, date: `${m[1]}-${m[2]}-${m[3]}`, slug: m[4] };
}
function setSealedFlag(ymlPath, url, sealed) {
  if (!fs.existsSync(ymlPath)) return 'no writeups.yml';
  let y = fs.readFileSync(ymlPath, 'utf8');
  const blocks = y.split(/(?=\n- box:)/);
  let touched = false;
  const out = blocks.map(b => {
    if (!b.includes(`url: ${url}`)) return b;
    touched = true;
    b = b.replace(/\n[ \t]*sealed:\s*true[ \t]*(?=\n|$)/g, '');           // strip any existing flag
    if (sealed) b = b.replace(/(\n[ \t]*date:[^\n]*)/, '$1\n  sealed: true'); // add after date:
    return b;
  });
  fs.writeFileSync(ymlPath, out.join(''));
  return touched ? (sealed ? 'sealed: true set' : 'sealed flag removed') : 'no matching yml entry';
}

function reviewLines(content) {  // teaser/footer prose a human should re-word at retirement (skips the body)
  const KW = /sealed|still active|while the box is live|unseals|passphrase/i;
  const hits = [];
  let inBody = false;
  content.split('\n').forEach((l, i) => {
    if (/<!--\s*seal:body\s*-->/.test(l)) { inBody = true; return; }
    if (/<!--\s*seal:end\s*-->/.test(l)) { inBody = false; return; }
    if (!inBody && KW.test(l)) hits.push(`  L${i + 1}: ${l.trim().slice(0, 90)}`);
  });
  return hits;
}

function main() {
  const [cmd, file] = process.argv.slice(2);
  if (cmd === 'selfcheck') return selfcheck();
  if (!['seal', 'unseal'].includes(cmd) || !file) {
    console.error("usage: WRITEUP_PASS='...' node scripts/writeup-seal.js <seal|unseal> <post.md> [--redate=YYYY-MM-DD]");
    process.exit(1);
  }
  const pass = process.env.WRITEUP_PASS;
  if (!pass) { console.error('set WRITEUP_PASS in the environment'); process.exit(1); }
  const redate = (process.argv.find(a => a.startsWith('--redate=')) || '').split('=')[1];

  const repo = path.resolve(__dirname, '..');
  const ymlPath = path.join(repo, '_data', 'writeups.yml');
  let content = fs.readFileSync(file, 'utf8');
  const before = postUrl(file);

  if (cmd === 'seal') {
    fs.writeFileSync(file, toSealed(content, pass));
    console.log(`sealed  ${file}  |  yml: ${setSealedFlag(ymlPath, before.url, true)}`);
  } else {
    const out = toUnsealed(content, pass);
    fs.writeFileSync(file, out);
    let msg = setSealedFlag(ymlPath, before.url, false);
    let finalFile = file;
    if (redate) {
      const nf = path.join(path.dirname(file), `${redate}-${before.slug}.md`);
      let t = fs.readFileSync(file, 'utf8').replace(/^(date:\s*)\d{4}-\d{2}-\d{2}/m, `$1${redate}`);
      fs.writeFileSync(file, t);
      fs.renameSync(file, nf);
      const [Y, M, D] = redate.split('-');
      const newUrl = `/${Y}/${M}/${D}/${before.slug}.html`;
      let y = fs.readFileSync(ymlPath, 'utf8')
        .replace(`url: ${before.url}`, `url: ${newUrl}`)
        .replace(new RegExp(`(url: ${newUrl}[\\s\\S]*?)date: ${before.date}`), `$1date: ${redate}`);
      fs.writeFileSync(ymlPath, y);
      finalFile = nf;
      msg += `  |  re-dated -> ${redate} (URL CHANGED to ${newUrl})`;
    }
    console.log(`unsealed  ${finalFile}  |  yml: ${msg}`);
    const rev = reviewLines(out);
    if (rev.length) console.log('  REVIEW these "sealed"-era lines by hand (prose, not automated):\n' + rev.join('\n'));
  }
}

function selfcheck() {
  const sample = [
    '---', 'layout: post', 'title: "T"', 'date: 2026-01-01 12:00:00 +0000', '---', '',
    'Intro teaser, sealed while the box is live.', '', '<!-- seal:body -->', '',
    '## 0x01 · in', 'body with a `---` line inside:', '', '---', '', 'more.', '',
    '## 0x02 · outro', '```', 'EOF', '```', '', '<!-- seal:end -->', '', '---', '', '*footer*', ''
  ].join('\n');
  const pass = 'test-pass';
  const sealed = toSealed(sample, pass);
  if (GATE_RE.test(sealed) === false) throw new Error('selfcheck: seal produced no gate');
  if (/## 0x01/.test(sealed)) throw new Error('selfcheck: plaintext body leaked into sealed form');
  const back = toUnsealed(sealed, pass);
  const body = s => s.match(BODY_RE)[1].trim();
  if (body(back) !== body(sample)) throw new Error('selfcheck: round-trip body mismatch');
  if (decrypt(sealed.match(/id="lock-data">([\s\S]*?)<\/script>/)[1], pass) !== body(sample))
    throw new Error('selfcheck: blob does not decrypt to body');
  console.log('selfcheck PASS — seal/unseal round-trips (incl. a `---` line inside the body), blob decrypts, no leak');
}

main();
