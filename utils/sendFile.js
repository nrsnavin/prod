'use strict';
// ══════════════════════════════════════════════════════════════════
//  SENDING A STORED FILE BACK, AND NAMING A DOWNLOAD
//
//  Eight routes send back a file somebody uploaded or mailed in, and a
//  dozen more name a download after a person or a party. Each wrote its
//  own headers, and they disagreed in two ways that mattered:
//
//    • The name. A header may only carry Latin-1, and Node refuses the
//      whole response otherwise — so a payslip for an employee whose
//      name is written in Tamil, a statement for "Sri Lakshmi & Co — New"
//      (the dash pasted from a letter), an attachment called
//      "பில்.pdf", each failed with a 500. Some routes stripped quotes,
//      some replaced everything unusual with "_", most did neither.
//
//    • The type. A stored file was sent with whatever type it was
//      stored under, to be shown in the browser. Seven of the eight
//      only ever store an image or a PDF; the slips that arrive over
//      WhatsApp kept whatever the sender attached. A page of HTML shown
//      from this address would run as this site.
//
//  contentDisposition() names a download so that any name works, and
//  sendStoredFile() sends bytes back: shown in the browser only when
//  they are an image or a PDF, handed over as a download otherwise.
// ══════════════════════════════════════════════════════════════════

/** The only types a browser is asked to SHOW. Nothing here can run. */
const SHOWN_INLINE = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif',
  'application/pdf',
]);

/**
 * A Content-Disposition value for a file called `name`, whatever is in it.
 *
 * `filename=` carries a plain-ASCII version every client understands;
 * `filename*=` carries the real name (RFC 6266), which every current
 * browser prefers. Slashes are never part of a name.
 *
 * @param {'inline'|'attachment'} kind
 */
function contentDisposition(kind, name, fallback = 'download') {
  const text = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[\\/]/g, '-').trim().slice(0, 150) || fallback;
  const ascii = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')      // é → e
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["%]/g, '_')
    .replace(/_{2,}/g, '_')
    .trim() || fallback;
  // A name that is nothing but placeholders says nothing: use the fallback's
  // stem and keep the extension.
  const meaningless = /^[_. -]*(\.[A-Za-z0-9]{1,5})?$/.exec(ascii);
  const plain = meaningless ? `${fallback}${meaningless[1] && !fallback.endsWith(meaningless[1]) ? meaningless[1] : ''}` : ascii;
  const encoded = encodeURIComponent(text).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind === 'inline' ? 'inline' : 'attachment'}; filename="${plain}"; filename*=UTF-8''${encoded}`;
}

/**
 * Send stored bytes back.
 * @param {object} file
 * @param {Buffer} file.buffer
 * @param {string} file.contentType  as stored
 * @param {string} [file.filename]
 * @param {string} [file.fallbackName] when there is no usable name
 * @param {number} [file.maxAge]      seconds a browser may keep it (private)
 */
function sendStoredFile(res, { buffer, contentType, filename, fallbackName = 'file', maxAge = 0 }) {
  const type = String(contentType || '').toLowerCase().split(';')[0].trim();
  const shown = SHOWN_INLINE.has(type);
  res.setHeader('Content-Type', shown ? type : 'application/octet-stream');
  res.setHeader('Content-Length', buffer.length);
  res.setHeader('Content-Disposition', contentDisposition(shown ? 'inline' : 'attachment', filename, fallbackName));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (maxAge > 0) res.setHeader('Cache-Control', `private, max-age=${Math.floor(maxAge)}`);
  res.end(buffer);
}

module.exports = { contentDisposition, sendStoredFile, SHOWN_INLINE };
