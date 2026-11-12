# UIDAI certificates

The public certificates UIDAI publishes for checking the signature on an
Aadhaar card's Secure QR code (`utils/aadhaarQr.js`). They are downloaded
on each server rather than kept in git:

    node scripts/fetch-uidai-certs.js

The server also fetches them by itself the first time a QR code is read
with none here. Any `.cer`, `.crt` or `.pem` file in this folder is tried;
`AADHAAR_QR_CERT_DIR` points the server at another folder.
