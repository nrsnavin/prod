'use strict';
// ══════════════════════════════════════════════════════════════════
//  A MODULE THAT ALSO SHOWS PEOPLE THEIR OWN RECORDS
//
//  Payroll, attendance, leave and bonus each serve two kinds of reader
//  from one router: the office, which needs the module's feature, and a
//  worker reading their own payslip or leave, who answers to who they
//  are and not to a tick-box. Each router let the worker's PATHS through
//  ahead of its feature gate — whoever's records were being asked for.
//  The route's own selfOrAdmin then lets finance read anyone's. So a
//  finance login with Payroll, Attendance, Leave and Bonus all unticked
//  could still read every employee's pay ledger, attendance and leave.
//
//  ownRecordsOr(...) is that gate, written once:
//
//    • a read of the caller's OWN employee id passes on identity;
//    • a read of anyone else's needs the module's feature — or one of
//      `alsoRead`, for the screens that show a person's record beside
//      their own (the Employees page shows pay and leave);
//    • everything else goes through the module's write and read gates,
//      with the same per-path widening requireFeatureReadPaths takes.
//
//  Use after isAuthenticated. The routes keep their own selfOrAdmin: this
//  decides whether the MODULE is open to the caller, that decides whose
//  records they may see.
// ══════════════════════════════════════════════════════════════════

const auth = require('./auth');

/**
 * @param {object} o
 * @param {string[]} o.features       keys that open the module
 * @param {string[]} [o.ownPrefixes]  read paths whose next segment is an employee id ('/slip/')
 * @param {string[]} [o.alsoRead]     other keys that may read someone else's records under those prefixes
 * @param {(req) => boolean} [o.open] requests that are a person's own business however addressed
 *                                    (asking for an advance, cancelling one's leave) — the route
 *                                    resolves the employee from the login
 * @param {object} [o.readPaths]      per-path read widening, as requireFeatureReadPaths
 */
function ownRecordsOr({ features, ownPrefixes = [], alsoRead = [], open = () => false, readPaths = {} }) {
  return function moduleGate(req, res, next) {
    if (open(req)) return next();

    const isRead = req.method === 'GET' || req.method === 'HEAD';
    const prefix = isRead ? ownPrefixes.find((p) => req.path.startsWith(p)) : undefined;
    if (prefix) {
      const asked = req.path.slice(prefix.length).split('/')[0];
      const mine = req.user?.employee && String(req.user.employee) === asked;
      if (mine) return next();
      return auth.requireFeatureRead(...features, ...alsoRead)(req, res, next);
    }

    return auth.requireFeature(...features)(req, res, (err) => {
      if (err) return next(err);
      return auth.requireFeatureReadPaths(features, readPaths)(req, res, next);
    });
  };
}

module.exports = { ownRecordsOr };
