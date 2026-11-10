'use strict';
// ══════════════════════════════════════════════════════════════════
//  NAMING A DOWNLOAD, AND SENDING A STORED FILE BACK
//
//  A header may only carry Latin-1; Node refuses the whole response
//  otherwise. So a payslip for an employee whose name is written in
//  Tamil, or a statement for a party with a dash pasted from a letter in
//  its name, failed with a 500. And a stored file was sent with
//  whatever type it was stored under, to be shown in the browser.
// ══════════════════════════════════════════════════════════════════

const http = require('http');
const express = require('express');
const request = require('supertest');
const { contentDisposition, sendStoredFile, SHOWN_INLINE } = require('../../utils/sendFile');

/** Whether Node accepts this as a header value. */
const accepted = (value) => {
  try { http.validateHeaderValue('Content-Disposition', value); return true; } catch (_) { return false; }
};
/** The real name a browser would save under (filename*). */
const realName = (value) => decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(value)[1]);
const plainName = (value) => /filename="([^"]*)"/.exec(value)[1];

describe('a download\'s name', () => {
  const names = [
    'payslip-ரவி_குமார்-Nov-2026.pdf',          // Tamil
    'Statement Sri Lakshmi & Co — New.pdf',       // a dash pasted from a letter
    'Balu’s “final” bill.pdf',                    // curly quotes
    'राम टेक्सटाइल्स.pdf',                          // Hindi
    'bill "copy" 100%.pdf',
    'line\r\nSet-Cookie: x=1.pdf',
    'a/b\\c.pdf',
    '₹ 5,000 advance.pdf',
  ];

  it.each(names)('%s is a header Node will send, and keeps its real name', (name) => {
    const value = contentDisposition('attachment', name);
    expect(accepted(value)).toBe(true);
    expect(value).not.toMatch(/[\r\n]/);
    expect(plainName(value)).toMatch(/^[\x20-\x7e]+$/);
    expect(plainName(value)).not.toMatch(/["%\\/]/);
    // The real name comes through whole, less only what is never part of one.
    expect(realName(value)).toBe(name.replace(/[\r\n]/g, ' ').replace(/[\\/]/g, '-'));
  });

  it('CONTROL: without it, the first of those cannot be sent at all', () => {
    expect(accepted(`attachment; filename="${names[0]}"`)).toBe(false);
  });

  it('says inline or attachment, and nothing else', () => {
    expect(contentDisposition('inline', 'a.pdf')).toMatch(/^inline; /);
    expect(contentDisposition('attachment', 'a.pdf')).toMatch(/^attachment; /);
    expect(contentDisposition('inline; x', 'a.pdf')).toMatch(/^attachment; /);
  });

  it('falls back when there is no name, and when the plain version would say nothing', () => {
    expect(plainName(contentDisposition('inline', '', 'bill'))).toBe('bill');
    expect(plainName(contentDisposition('inline', null, 'bill'))).toBe('bill');
    // All Tamil: the plain name would be underscores. Keep the extension.
    const tamil = contentDisposition('attachment', 'பில்.pdf', 'bill');
    expect(plainName(tamil)).toBe('bill.pdf');
    expect(realName(tamil)).toBe('பில்.pdf');
  });

  it('keeps an ordinary name exactly', () => {
    expect(plainName(contentDisposition('inline', 'INV-26-27-0042.pdf'))).toBe('INV-26-27-0042.pdf');
    expect(plainName(contentDisposition('inline', 'Café Élan.pdf'))).toBe('Cafe Elan.pdf');
  });

  it('is never longer than a name', () => {
    expect(realName(contentDisposition('inline', 'x'.repeat(5000))).length).toBe(150);
  });
});

describe('a stored file', () => {
  const app = express();
  app.get('/f', (req, res) => sendStoredFile(res, {
    buffer: Buffer.from('<script>alert(1)</script>'), contentType: req.query.type, filename: req.query.name, fallbackName: 'file', maxAge: Number(req.query.age) || 0,
  }));
  const get = (type, name = 'x', age = '') => request(app).get('/f').query({ type, name, age });

  it('is shown in the browser only when it is an image or a PDF', async () => {
    for (const type of SHOWN_INLINE) {
      const res = await get(type);
      expect(res.headers['content-type']).toBe(type);
      expect(res.headers['content-disposition']).toMatch(/^inline; /);
    }
  });

  it('is handed over as a download when it is anything that could run', async () => {
    for (const type of ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/xml', 'application/javascript', 'text/html; charset=utf-8', '', 'weird']) {
      const res = await get(type, 'page.html');
      expect(res.headers['content-type']).toBe('application/octet-stream');
      expect(res.headers['content-disposition']).toMatch(/^attachment; /);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    }
  });

  it('reads the type whatever its case or parameters', async () => {
    const res = await get('IMAGE/JPEG; q=1');
    expect(res.headers['content-type']).toBe('image/jpeg');
  });

  it('is kept by the browser only when asked, and privately', async () => {
    expect((await get('image/png')).headers['cache-control']).toBeUndefined();
    expect((await get('image/png', 'x', '3600')).headers['cache-control']).toBe('private, max-age=3600');
  });

  it('with a name in Tamil is sent, not a 500', async () => {
    const res = await get('application/pdf', 'பில்.pdf');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/filename\*=UTF-8''%E0%AE%AA/);
  });
});
