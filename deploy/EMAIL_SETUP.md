# Email setup — password reset links (Hostinger SMTP)

The forgot-password / reset-password flow emails a one-time reset link. It
sends through plain SMTP via `nodemailer` (`utils/mailer.js`). Any SMTP
mailbox works; below is the Hostinger path since the domain is on Hostinger.

## 1. Create the mailbox

In **hPanel → Emails → your `baluelastics.com` domain**, create a mailbox,
e.g. `no-reply@baluelastics.com`, and set a password. (Hostinger email
hosting is included with most domain/hosting plans.)

Hostinger SMTP details (confirm under *Email → Connect Apps / Configure*):

| Setting   | Value                       |
|-----------|-----------------------------|
| Host      | `smtp.hostinger.com`        |
| Port      | `465` (SSL) — recommended   |
| Security  | SSL/TLS                     |
| Username  | the full mailbox address    |
| Password  | the mailbox password        |

## 2. Add to the server env (`config/.env`)

```dotenv
SMTP_HOST=smtp.hostinger.com
SMTP_PORT=465
SMTP_USER=no-reply@baluelastics.com
SMTP_PASS=the-mailbox-password
SMTP_FROM=Balu Elastics ERP <no-reply@baluelastics.com>

# Public web origin used to build the reset link target.
# The email links to  <WEB_URL>/reset-password?token=...
WEB_URL=https://erp.baluelastics.com
```

Then restart the API:

```bash
sudo systemctl restart jarvis
```

## 3. Verify

```bash
# From the repo root on the server:
node -e "require('dotenv').config({path:'config/.env'}); \
  require('./utils/mailer').sendMail({to:'you@example.com', \
  subject:'ERP SMTP test', text:'It works.'}).then(r=>console.log(r)).catch(console.error)"
```

You should get `{ skipped:false, messageId: ... }` and an email in the inbox.
If it prints `{ skipped:true }`, the `SMTP_*` vars aren't loaded.

## Behaviour notes

- **Graceful when unconfigured.** If `SMTP_HOST/USER/PASS` are unset the
  mailer logs a warning and no-ops instead of throwing — `forgot-password`
  still returns its generic success, so the endpoint never 500s on a
  half-provisioned box. (It just won't actually deliver mail.)
- **No user enumeration.** `forgot-password` always returns the same
  "if an account exists, a link has been sent" message, and a mail-send
  failure is swallowed, so the response never reveals whether an email is
  registered.
- **Only users with a real email** can self-reset. Shop-floor logins created
  without an email are still reset by an admin from the Users screen or
  `scripts/create-admin.js --update`.
- **Token safety.** Only the SHA-256 *hash* of the reset token is stored;
  it expires in 30 minutes and is single-use (cleared on successful reset).
- **Deliverability.** For inboxing (not spam), add SPF/DKIM DNS records for
  the domain per Hostinger's email DNS guide. Hostinger sets these up
  automatically when the mailbox is created on their nameservers.
