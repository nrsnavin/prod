// ══════════════════════════════════════════════════════════════════
//  LOOM SENSOR — ESP32 firmware (Arduino core 2.x / 3.x)
//
//  Counts the seconds the loom runs, from a 24 V "running" signal taken
//  through an optocoupler (see README.md for the wiring), and optionally
//  the picks, from a proximity sensor on the main shaft. Every minute it
//  posts the RUNNING TOTALS to the app:
//
//    POST https://<server>/api/v2/loom-sensor/reading
//    X-Device-Key: <the key shown once when the sensor was added>
//    { "runSecondsTotal": 123456, "picksTotal": 789012, "running": true,
//      "at": 1793862000, "firmware": "loom-sensor 1.0" }
//
//  Totals, not amounts since the last post: a lost post loses nothing.
//  The totals are kept in flash (NVS) every minute, so a power cut costs
//  at most a minute. With no Wi-Fi, posts are kept in memory (up to
//  BUFFER_MAX) and sent together as { "readings": [...] } when it is
//  back. The clock comes from NTP; until it is set, posts carry no "at"
//  and the server stamps them.
//
//  Fill secrets.h (from secrets.example.h) before flashing.
// ══════════════════════════════════════════════════════════════════

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <time.h>

// Wi-Fi, the server, this board's key and the CA that signed the
// server's certificate: copy secrets.example.h to secrets.h and fill it.
// secrets.h is never committed.
#include "secrets.h"
#ifndef SERVER_CA
#error "Set SERVER_CA in secrets.h: the PEM of the CA that signed the server's certificate"
#endif

#define FIRMWARE        "loom-sensor 1.0"
#define PIN_RUN         27      // optocoupler output: LOW while the loom runs
#define PIN_PICK        26      // proximity sensor pulse per pick (optional)
#define RUN_ACTIVE_LOW  true
#define USE_PICKS       false
#define POST_EVERY_MS   60000UL
#define SAVE_EVERY_MS   60000UL
#define BUFFER_MAX      720     // 12 hours of minute posts
#define DEBOUNCE_MS     200     // the run signal must hold this long to count

struct Reading { uint32_t at; uint32_t runSeconds; uint32_t picks; bool running; };

Preferences prefs;
Reading buffer[BUFFER_MAX];
size_t buffered = 0;

volatile uint32_t pickCount = 0;
uint32_t runSecondsTotal = 0;
uint32_t picksTotalBase = 0;

bool runState = false;
uint32_t runChangedAt = 0;
uint32_t lastSecondTick = 0;
uint32_t lastPost = 0;
uint32_t lastSave = 0;

void IRAM_ATTR onPick() { pickCount++; }

bool runningNow() {
  bool raw = digitalRead(PIN_RUN) == (RUN_ACTIVE_LOW ? LOW : HIGH);
  uint32_t now = millis();
  if (raw != runState && now - runChangedAt >= DEBOUNCE_MS) { runState = raw; runChangedAt = now; }
  else if (raw == runState) runChangedAt = now;
  return runState;
}

uint32_t picksTotal() {
  noInterrupts(); uint32_t p = pickCount; interrupts();
  return picksTotalBase + p;
}

void saveTotals() {
  prefs.putUInt("run", runSecondsTotal);
  prefs.putUInt("picks", picksTotal());
}

void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) delay(250);
}

uint32_t epochNow() {
  time_t t = time(nullptr);
  return t > 1700000000 ? (uint32_t)t : 0;  // 0 until NTP has set the clock
}

void keep(const Reading& r) {
  if (buffered == BUFFER_MAX) {                 // full: drop the oldest
    memmove(buffer, buffer + 1, sizeof(Reading) * (BUFFER_MAX - 1));
    buffered--;
  }
  buffer[buffered++] = r;
}

String readingJson(const Reading& r) {
  String s = "{\"runSecondsTotal\":" + String(r.runSeconds);
  if (USE_PICKS) s += ",\"picksTotal\":" + String(r.picks);
  s += ",\"running\":" + String(r.running ? "true" : "false");
  if (r.at) s += ",\"at\":" + String(r.at);
  return s + "}";
}

// Sends what is buffered, at most 100 a post; keeps what did not go.
void flush() {
  connectWifi();
  if (WiFi.status() != WL_CONNECTED || buffered == 0) return;
  WiFiClientSecure tls;
  // The server's certificate is always checked: against SERVER_CA. Never
  // setInsecure() — the key would go to whoever answered.
  tls.setCACert(SERVER_CA);
  while (buffered > 0) {
    size_t n = buffered < 100 ? buffered : 100;
    String body = "{\"firmware\":\"" FIRMWARE "\",\"readings\":[";
    for (size_t i = 0; i < n; i++) { if (i) body += ","; body += readingJson(buffer[i]); }
    body += "]}";
    HTTPClient http;
    if (!http.begin(tls, SERVER_URL)) return;
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-Device-Key", DEVICE_KEY);
    http.setTimeout(10000);
    int code = http.POST(body);
    http.end();
    if (code == 200) {
      memmove(buffer, buffer + n, sizeof(Reading) * (buffered - n));
      buffered -= n;
    } else if (code == 401) {
      // The key was replaced or the sensor removed: nothing to retry.
      buffered = 0;
      return;
    } else {
      return;                                   // try again next minute
    }
  }
}

void setup() {
  pinMode(PIN_RUN, INPUT_PULLUP);
  if (USE_PICKS) { pinMode(PIN_PICK, INPUT_PULLUP); attachInterrupt(digitalPinToInterrupt(PIN_PICK), onPick, FALLING); }
  prefs.begin("loom", false);
  runSecondsTotal = prefs.getUInt("run", 0);
  picksTotalBase = prefs.getUInt("picks", 0);
  connectWifi();
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  lastSecondTick = lastPost = lastSave = millis();
}

void loop() {
  uint32_t now = millis();
  bool running = runningNow();
  // One second of running counted per second the signal holds.
  while (now - lastSecondTick >= 1000) {
    lastSecondTick += 1000;
    if (running) runSecondsTotal++;
  }
  if (now - lastSave >= SAVE_EVERY_MS) { lastSave = now; saveTotals(); }
  if (now - lastPost >= POST_EVERY_MS) {
    lastPost = now;
    keep({ epochNow(), runSecondsTotal, picksTotal(), running });
    flush();
  }
  delay(20);
}
