'use strict';
// ══════════════════════════════════════════════════════════════════
//  A REQUEST ANOTHER SITE'S PAGE MAKES FROM SOMEONE'S BROWSER
//
//  The session cookie goes with every request a browser makes to this
//  API, whichever site's page caused it (SameSite=None, so that a web
//  app on another site can sign in at all). CORS stops that page READING
//  the answer, and refuses a request that names a foreign Origin — but
//  an <img>, a <script> or a hidden frame names none, and still arrives
//  signed in as whoever is looking at the page.
//
//  Browsers say where a request came from in Sec-Fetch-Site. One that
//  says "cross-site" is refused unless
//
//    • it comes from a web app this server was told about (CORS_ORIGINS)
//      — named by its Origin, or by its Referer for a link it opened; or
//    • it is a person opening a link: a top-level page load, GET only.
//      That request is let through marked `req.fromAnotherSite`, so the
//      few GETs that do more than read can decline it — and it is why
//      nothing new behind a GET may change anything.
//
//  The mobile apps, the Tally connector, Twilio, cron and the loom
//  boards are not browsers and send no such header: they pass untouched.
//  So does a browser too old to send it; for those, CORS and the
//  cookie's own SameSite setting (SESSION_SAMESITE) are what there is.
// ══════════════════════════════════════════════════════════════════

/** The origin of a URL, or null when it is not one. */
function originOf(url) {
  try {
    return url ? new URL(String(url)).origin : null;
  } catch (_) {
    return null;
  }
}

/**
 * @param {(origin: string) => boolean} isAllowedOrigin  the CORS allow-list
 */
function crossSiteGuard(isAllowedOrigin) {
  return function crossSite(req, res, next) {
    if (String(req.get('Sec-Fetch-Site') || '').toLowerCase() !== 'cross-site') return next();

    const from = req.get('Origin') || originOf(req.get('Referer'));
    if (from && isAllowedOrigin(from)) return next();

    const openedByAPerson = (req.method === 'GET' || req.method === 'HEAD')
      && req.get('Sec-Fetch-Mode') === 'navigate'
      && req.get('Sec-Fetch-Dest') === 'document';
    if (openedByAPerson) {
      req.fromAnotherSite = true;
      return next();
    }

    return res.status(403).json({
      success: false,
      code: 'CROSS_SITE',
      message: 'This request came from another site and was refused.',
    });
  };
}

module.exports = { crossSiteGuard, originOf };
