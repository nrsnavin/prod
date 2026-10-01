"use strict";

// ══════════════════════════════════════════════════════════════════
//  WORKER LOGINS — the rules shared by the sign-in and the admin side
//
//  A worker signs in with the phone number on their employee record and
//  a PIN an admin sets. Their login is an ordinary User, linked to the
//  employee and granted only the self-service screens, so every session,
//  gate and route that already works for an employee login works here.
//
//  The User schema requires a unique email, and most workers have none.
//  A worker login therefore carries a placeholder address under the
//  reserved `.invalid` top-level domain (RFC 2606): it can never receive
//  mail, can never collide with a real address, and the apps hide it.
// ══════════════════════════════════════════════════════════════════

const PLACEHOLDER_DOMAIN = "workers.invalid";

/** Wrong PINs allowed before the login locks, and for how long. */
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 15;

const placeholderEmail = (employeeId) => `worker-${employeeId}@${PLACEHOLDER_DOMAIN}`;
const isPlaceholderEmail = (email) =>
  typeof email === "string" && email.toLowerCase().endsWith(`@${PLACEHOLDER_DOMAIN}`);

/**
 * The 10-digit number in whatever was typed: "98765 43210", "+91 98765
 * 43210" and "098765-43210" all mean the same phone. Null when there is
 * no 10-digit number in it.
 */
function normalisePhone(raw) {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  return null;
}

/**
 * Why a PIN is not acceptable, or null when it is. Four to six digits;
 * not one digit repeated, not a run like 1234 or 9876, and not the end
 * of the worker's own phone number — the first things anyone would try.
 */
function pinProblem(pin, phone) {
  if (typeof pin !== "string" || !/^\d{4,6}$/.test(pin)) return "The PIN must be 4 to 6 digits.";
  if (/^(\d)\1+$/.test(pin)) return "Choose a PIN that is not one digit repeated.";
  const d = [...pin].map(Number);
  const step = d[1] - d[0];
  if ((step === 1 || step === -1) && d.every((x, i) => i === 0 || x - d[i - 1] === step)) {
    return "Choose a PIN that is not a run of digits like 1234.";
  }
  if (phone && phone.endsWith(pin)) return "Choose a PIN that is not the end of the phone number.";
  return null;
}

/** The department a worker login gets from its employee record. */
const loginDepartmentFor = (employeeDepartment) =>
  String(employeeDepartment || "").toLowerCase() === "packing" ? "packing" : "production";

module.exports = {
  PLACEHOLDER_DOMAIN,
  PIN_MAX_ATTEMPTS,
  PIN_LOCK_MINUTES,
  placeholderEmail,
  isPlaceholderEmail,
  normalisePhone,
  pinProblem,
  loginDepartmentFor,
};
