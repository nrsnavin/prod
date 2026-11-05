# Loom sensor

A small board on each loom that counts how long the loom runs and posts it
to the app every minute. The floor then gets the run time without reading a
timer, and auto-verification takes it as evidence for the entered run time.

## Parts (per loom)

| Part | Why |
|---|---|
| ESP32 dev board (ESP32-WROOM-32, any with Wi-Fi) | Counts and posts |
| PC817 optocoupler module, 24 V input | Takes the loom's run signal safely |
| 5 V DIN-rail supply, or a 24 V to 5 V buck converter | Powers the board |
| Optional: NPN inductive proximity sensor, 12–24 V | One pulse per pick, from the main shaft |
| Small DIN-rail enclosure | Inside the loom's panel |

## Wiring

The run signal is the coil of the main-motor contactor, or the "running"
lamp. It is live only while the loom runs.

- **Run signal.** Wire it through the optocoupler: contactor auxiliary (NO contact, 24 V) to the optocoupler input, and the optocoupler output to **GPIO 27** and GND. GPIO 27 then reads LOW while the loom runs.
- **Picks (optional).** Wire the proximity sensor's output through a second optocoupler to **GPIO 26**. Set `USE_PICKS true` in the sketch.
- **Mains.** Never wire mains or 24 V directly to the ESP32. The optocoupler is the isolation.

Have the plant electrician make the panel connections.

## Setting up a board

1. **Add the sensor in the app.** Go to Shift verification, then Loom sensors, then Add. Choose the loom. The device key is shown **once**. Copy it now.
2. **Fill in the secrets.** Copy `loom_sensor/secrets.example.h` to `loom_sensor/secrets.h`. Fill in the Wi-Fi name and password, the server address, the key, and the CA certificate that signed the server's HTTPS certificate. `secrets.h` is ignored by git.
3. **Flash the board.** In the Arduino IDE, add the ESP32 boards package (Espressif). Open `loom_sensor/loom_sensor.ino` and upload it.
4. **Check it in the app.** Within two minutes the sensor shows as live.

## How it counts

- **Totals, not differences.** Each post carries the running totals: seconds run, and picks if counted. A lost post loses nothing, because the next post carries it.
- **Saved to flash.** The totals are saved every minute, so a power cut costs at most a minute.
- **Kept while offline.** With no Wi-Fi, up to 12 hours of posts are kept. They are sent together when Wi-Fi is back.
- **Restarts are safe.** If the totals ever start again from zero, for example after a re-flash, the server treats the drop as a restart and counts from zero.
- **Run time per shift.** The server takes the rise in the total across each shift: day 08:00–20:00, night 20:00–08:00, factory time.

## A lost or stolen board

Replace the key in the app with Loom sensors, then New key. The old key stops working at once. Flash the new key, or remove the sensor.
