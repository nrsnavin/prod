// Copy to secrets.h (never committed) and fill in.
#define WIFI_SSID     "factory-wifi"
#define WIFI_PASSWORD "change-me"
#define SERVER_URL    "https://your-server.example/api/v2/loom-sensor/reading"
// Shown once in the app (Shift verification → Loom sensors → Add) — "ld_…".
#define DEVICE_KEY    "ld_xxxxxxxxxxxx.paste-the-key-shown-once"
// The PEM of the CA that signed the server's HTTPS certificate (for
// Let's Encrypt, its current root, from letsencrypt.org/certificates).
#define SERVER_CA \
  "-----BEGIN CERTIFICATE-----\n" \
  "...paste the CA certificate here, one line per string...\n" \
  "-----END CERTIFICATE-----\n"
