'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE FIELDS OF AN UPLOAD FORM ARE CLEANED LIKE ANY OTHER BODY
//
//  sanitizeMongo and blankRefs run app-wide, before the routers — when a
//  multipart request has no body yet. Its fields are read later, by the
//  route's own upload middleware. So on every upload route a field named
//  `supplier[$ne]` reached the handler as { $ne: … }, a query operator.
//
//  keepRequestContext (middleware/userContext.js), which every upload is
//  wrapped in, now cleans the body once it exists. Held here: that it
//  does, through a real multipart request — and that no upload in api/
//  is left unwrapped.
// ══════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const request = require('supertest');
const mongoose = require('mongoose');

// A model with a reference, so "a reference field" means something here.
mongoose.models.UploadCleanProbe || mongoose.model('UploadCleanProbe', new mongoose.Schema({
  probeSupplierRef: { type: mongoose.Types.ObjectId, ref: 'Supplier' },
}));
require('../../utils/blankRefs')._resetCache();

const { keepRequestContext } = require('../../middleware/userContext');

function probe(wrap) {
  const upload = multer({ storage: multer.memoryStorage() });
  const app = express();
  app.post('/up', wrap(upload.single('file')), (req, res) => res.json({ body: req.body, hasFile: Boolean(req.file) }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(400).json({ error: err.code || err.message }));
  return app;
}
const post = (app) => request(app).post('/up')
  .field('note', 'two cones short')
  .field('supplier[$ne]', 'x')
  .field('filter[$where]', 'sleep(1000)')
  .field('nested[a.b]', '1')
  .field('nested[ok]', 'kept')
  .field('probeSupplierRef', '')
  .attach('file', Buffer.from('%PDF-1.4 test'), 'bill.pdf');

describe('a multipart form', () => {
  it('CONTROL: unwrapped, the operators arrive as the upload middleware parsed them', async () => {
    const res = await post(probe((m) => m));
    expect(res.body.body.supplier).toEqual({ $ne: 'x' });
    expect(res.body.body.probeSupplierRef).toBe('');
  });

  it('wrapped, they are gone before the handler runs', async () => {
    const res = await post(probe(keepRequestContext));
    expect(res.status).toBe(200);
    expect(res.body.hasFile).toBe(true);
    expect(res.body.body.note).toBe('two cones short');
    expect(res.body.body.supplier).toEqual({});
    expect(res.body.body.filter).toEqual({});
    expect(res.body.body.nested).toEqual({ ok: 'kept' });
    expect(JSON.stringify(res.body.body)).not.toMatch(/\$ne|\$where|a\.b/);
  });

  it('wrapped, an unpicked reference is null rather than ""', async () => {
    const res = await post(probe(keepRequestContext));
    expect(res.body.body.probeSupplierRef).toBeNull();
  });

  it('an upload error is still the upload\'s to report', async () => {
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 } });
    const app = express();
    app.post('/up', keepRequestContext(upload.single('file')), (_req, res) => res.json({ ok: true }));
    // eslint-disable-next-line no-unused-vars
    app.use((err, _req, res, _next) => res.status(400).json({ error: err.code }));
    const res = await request(app).post('/up').attach('file', Buffer.from('much more than four bytes'), 'big.bin');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('LIMIT_FILE_SIZE');
  });
});

describe('every upload in api/ is wrapped', () => {
  it('no multer middleware is used bare', () => {
    const dir = path.join(__dirname, '../../api');
    const files = [];
    (function walk(d) {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        if (f.isDirectory()) walk(path.join(d, f.name));
        else if (f.name.endsWith('.js')) files.push(path.join(d, f.name));
      }
    })(dir);

    const bare = [];
    let seen = 0;
    const multerNames = (src) => [...src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*multer\(/g)].map((m) => m[1]);
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      // Every name bound to a multer instance in this file…
      const names = multerNames(src);
      // …or imported from a sibling that binds it: an upload several
      // route files share is defined once (api/accountsCommon.js).
      for (const m of src.matchAll(/const\s*\{([^}]*)\}\s*=\s*require\(\s*["'](\.\/[\w.]+?)(?:\.js)?["']\s*\)/g)) {
        const sibling = path.join(path.dirname(file), `${m[2]}.js`);
        if (!fs.existsSync(sibling)) continue;
        const bound = multerNames(fs.readFileSync(sibling, 'utf8'));
        for (const n of m[1].split(',').map((s) => s.trim().split(/\s*:\s*/).pop())) {
          if (bound.includes(n) && !names.includes(n)) names.push(n);
        }
      }
      for (const name of names) {
        // …and every place it is turned into middleware.
        const uses = [...src.matchAll(new RegExp(`(keepRequestContext\\(\\s*)?\\b${name}\\.(single|array|fields|any|none)\\(`, 'g'))];
        for (const u of uses) {
          seen += 1;
          if (!u[1]) bare.push(`${path.relative(dir, file)}: ${name}.${u[2]}(…)`);
        }
      }
    }
    expect(seen).toBeGreaterThan(20); // the scan is really finding them
    expect(bare).toEqual([]);
  });
});
