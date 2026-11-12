#!/usr/bin/env node
'use strict';
// ══════════════════════════════════════════════════════════════════
//  UIDAI'S CERTIFICATES, FOR CHECKING AADHAAR QR CODES
//
//    node scripts/fetch-uidai-certs.js
//
//  Downloads the public certificates UIDAI publishes for checking the
//  signature on Aadhaar Secure QR codes and offline e-KYC
//  (uidai.gov.in → Data and Downloads → UIDAI Certificates Details)
//  into config/uidai/, and prints each one's validity and SHA-256
//  fingerprint. Run it on the server: UIDAI's site answers from India.
//  Every certificate is kept, expired ones too: a card signed in 2021
//  verifies against the key UIDAI used then.
//
//  The server also fetches them by itself the first time a QR code is
//  read with none in place; this script is for doing it now, and for
//  seeing what was saved.
// ══════════════════════════════════════════════════════════════════

const { downloadCertificates, certDir } = require('../utils/aadhaarQr');

(async () => {
  console.log(`Saving UIDAI's certificates to ${certDir()}`);
  const { saved, failed } = await downloadCertificates({ log: (line) => console.log(`  ${line}`) });
  console.log(`${saved.length} saved, ${failed.length} not.`);
  if (!saved.length) {
    console.log('None could be downloaded. Check that this server can reach backend.uidai.gov.in, or');
    console.log('download them from uidai.gov.in (Data and Downloads) and copy the .cer files there.');
    process.exit(1);
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
