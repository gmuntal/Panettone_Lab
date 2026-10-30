/* Panettone Lab Wi-Fi probe v0.1.0
 * GPIO4: white DQ; 3V3: green VDD; GND: brown. 4.7k pull-up DQ -> 3V3.
 * Local dependencies: OneWire, DallasTemperature, ESP32 Arduino core.
 */
#include <WiFi.h>
#include <WebServer.h>
#include <ArduinoOTA.h>
#include <Preferences.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <esp_system.h>
#include <esp_timer.h>
#include <math.h>
#include "config.h"

constexpr char VERSION[] = "0.1.0";
constexpr uint8_t DATA_PIN = 4;
constexpr uint32_t SAMPLE_MS = 5000;
constexpr uint32_t CONVERSION_MS = 800;
constexpr uint32_t STALE_MS = 15000;
constexpr uint32_t WIFI_RETRY_MS = 15000;
// Bind to the actual probe; a replacement sensor requires an explicit change.
DeviceAddress sensorRom = {0x28, 0x19, 0x94, 0x2E, 0x10, 0x00, 0x00, 0x54};
constexpr char SENSOR_ROM[] = "28:19:94:2E:10:00:00:54";

OneWire wire(DATA_PIN);
DallasTemperature sensors(&wire);
WebServer server(80);
Preferences preferences;
String adminPassword, apiToken, bootId;
bool securityReady = false, wasConnected = false, converting = false;
bool otaBusy = false, otaReady = false;
uint32_t lastWifiAttempt = 0, conversionStarted = 0, lastSampleStarted = 0;
uint32_t lastAttempt = 0, lastGood = 0, samples = 0, errors = 0;
bool haveAttempt = false, haveGood = false, latestOk = false;
float rawTemperature = NAN, offsetC = 0;
const char *sampleError = "starting";

String randomHex(size_t bytes) {
  static const char digits[] = "0123456789abcdef";
  String value;
  value.reserve(bytes * 2);
  for (size_t i = 0; i < bytes; ++i) {
    uint8_t b = uint8_t(esp_random());
    value += digits[b >> 4];
    value += digits[b & 15];
  }
  return value;
}

bool adminAuthenticated() {
  if (!securityReady) {
    server.send(503, "application/json", "{\"error\":\"credentials_unavailable\"}");
    return false;
  }
  if (server.authenticate("admin", adminPassword.c_str())) return true;
  server.requestAuthentication(DIGEST_AUTH, "PanettoneProbe");
  return false;
}

bool readAuthenticated() {
  if (!securityReady) {
    server.send(503, "application/json", "{\"error\":\"credentials_unavailable\"}");
    return false;
  }
  const String auth = server.header("Authorization");
  if (auth.startsWith("Bearer ")) {
    const String supplied = auth.substring(7);
    uint8_t difference = 0;
    if (supplied.length() == apiToken.length()) {
      for (size_t i = 0; i < apiToken.length(); ++i) difference |= supplied[i] ^ apiToken[i];
      if (difference == 0) return true;
    }
    server.send(401, "application/json", "{\"error\":\"unauthorized\"}");
    return false;
  }
  return adminAuthenticated();
}

bool readingValid() {
  return latestOk && haveGood && uint32_t(millis() - lastGood) <= STALE_MS;
}

String statusJson() {
  const bool valid = readingValid();
  const bool wifiOk = WiFi.status() == WL_CONNECTED;
  const char *error = latestOk && !valid ? "stale" : sampleError;
  String result;
  result.reserve(1000);
  result = "{\"schema_version\":1,\"firmware_version\":\"";
  result += VERSION;
  result += "\",\"device_id\":\"";
  result += DEVICE_NAME;
  result += "\",\"boot_id\":\"" + bootId;
  result += "\",\"sensor_rom\":\"";
  result += SENSOR_ROM;
  result += "\",\"valid\":";
  result += valid ? "true" : "false";
  result += ",\"temperature_c\":";
  result += valid ? String(rawTemperature + offsetC, 2) : "null";
  result += ",\"raw_temperature_c\":";
  result += valid ? String(rawTemperature, 2) : "null";
  result += ",\"offset_c\":" + String(offsetC, 2);
  result += ",\"error\":";
  result += valid ? "null" : String('"') + error + '"';
  result += ",\"sample_sequence\":" + String(samples);
  result += ",\"sample_age_ms\":";
  result += haveAttempt ? String(uint32_t(millis() - lastAttempt)) : "null";
  result += ",\"last_good_age_ms\":";
  result += haveGood ? String(uint32_t(millis() - lastGood)) : "null";
  result += ",\"error_count\":" + String(errors);
  result += ",\"sample_interval_ms\":" + String(SAMPLE_MS);
  result += ",\"stale_after_ms\":" + String(STALE_MS);
  result += ",\"uptime_s\":" + String(uint64_t(esp_timer_get_time() / 1000000));
  result += ",\"wifi_connected\":";
  result += wifiOk ? "true" : "false";
  result += ",\"rssi_dbm\":";
  result += wifiOk ? String(WiFi.RSSI()) : "null";
  result += ",\"ip\":\"" + (wifiOk ? WiFi.localIP().toString() : String(""));
  result += "\",\"ota_enabled\":";
  result += otaReady ? "true}" : "false}";
  return result;
}

void finishSample(float value, const char *error) {
  samples++;
  haveAttempt = true;
  lastAttempt = millis();
  sampleError = error;
  latestOk = error == nullptr;
  rawTemperature = latestOk ? value : NAN;
  if (latestOk) {
    haveGood = true;
    lastGood = lastAttempt;
    Serial.printf("[sensor] %.2f C (raw %.2f, offset %.2f)\n", value + offsetC, value, offsetC);
  } else {
    errors++;
    Serial.printf("[sensor] ERROR: %s\n", error);
  }
}

void sensorTick() {
  if (otaBusy) return;
  const uint32_t now = millis();
  if (converting) {
    if (uint32_t(now - conversionStarted) < CONVERSION_MS) return;
    converting = false;
    const float value = sensors.getTempC(sensorRom);
    if (!isfinite(value) || value == DEVICE_DISCONNECTED_C || value < -55 || value > 125)
      finishSample(NAN, "sensor_read_failed");
    else if (value == 85.0f)
      finishSample(NAN, "suspect_85c");
    else
      finishSample(value, nullptr);
    return;
  }
  if (samples > 0 && uint32_t(now - lastSampleStarted) < SAMPLE_MS) return;
  lastSampleStarted = now;
  if (!sensors.isConnected(sensorRom)) {
    finishSample(NAN, "sensor_missing_or_crc_error");
    return;
  }
  if (!sensors.requestTemperaturesByAddress(sensorRom).result) {
    finishSample(NAN, "conversion_start_failed");
    return;
  }
  conversionStarted = millis();
  converting = true;
}

const char PAGE[] PROGMEM = R"HTML(<!doctype html>
<html lang="ca"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Panettone Probe</title>
<style>body{font:17px system-ui;background:#122024;color:#edf6f4;max-width:650px;margin:35px auto;padding:18px}section{background:#203137;padding:22px;border-radius:16px;margin:16px 0}h1{font-size:25px}#temperature{font-size:60px;color:#83dfca}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}input,button{font:inherit;padding:10px;border-radius:8px;max-width:130px}button{background:#83dfca;border:0;cursor:pointer}small{color:#bacdce}</style>
<h1>Panettone Lab · Sonda de massa</h1><small id="identity"></small>
<section><div id="temperature">—</div><p id="state">Connectant…</p><small>Lectura cada 5 s · sense control de calefacció</small></section>
<section><h2>Correcció</h2><form id="calibration"><label>Offset °C <input id="offset" type="number" min="-1" max="1" step="0.01" required value="0"></label> <button>Desar</button></form><p id="message"></p><small>S'aplica una sola vegada a la temperatura bruta. Rang ±1 °C.</small></section>
<section><h2>Diagnòstic</h2><pre id="diagnostic"></pre></section>
<script>
const identity=document.getElementById('identity'),temperature=document.getElementById('temperature');
const state=document.getElementById('state'),diagnostic=document.getElementById('diagnostic');
const offset=document.getElementById('offset'),message=document.getElementById('message');
const calibration=document.getElementById('calibration');
let busy=false;
async function refresh(){
 if(busy)return;busy=true;
 const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),3500);
 try{
  const r=await fetch('/api/status',{cache:'no-store',signal:controller.signal});if(!r.ok)throw Error('HTTP '+r.status);
  const j=await r.json();
  identity.textContent=j.device_id+' · v'+j.firmware_version;
  temperature.textContent=j.valid?j.temperature_c.toFixed(2)+' °C':'—';
  state.textContent=j.valid?'Lectura vàlida':'Sense lectura vàlida: '+j.error;
  diagnostic.textContent=JSON.stringify(j,null,2);
  if(!offset.dataset.edited)offset.value=j.offset_c.toFixed(2);
 }catch(e){temperature.textContent='—';state.textContent='Sense comunicació amb la sonda';}
 finally{clearTimeout(timeout);busy=false;}
}
offset.addEventListener('input',()=>offset.dataset.edited='1');
calibration.addEventListener('submit',async e=>{
 e.preventDefault();message.textContent='Desant…';
 try{
  const r=await fetch('/api/config',{method:'POST',headers:{'X-Probe-Action':'calibrate','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({offset_c:offset.value})});
  if(!r.ok)throw Error('HTTP '+r.status);
  delete offset.dataset.edited;message.textContent='Correcció desada';refresh();
 }catch(e){message.textContent='No s’ha pogut desar: '+e.message;}
});
refresh();setInterval(refresh,2000);
</script></html>)HTML";

void setupWeb() {
  const char *headers[] = {"Authorization", "X-Probe-Action"};
  server.collectHeaders(headers, 2);
  server.on("/", HTTP_GET, []() {
    if (!adminAuthenticated()) return;
    server.sendHeader("Cache-Control", "no-store");
    server.sendHeader("X-Frame-Options", "DENY");
    server.send_P(200, "text/html; charset=utf-8", PAGE);
  });
  server.on("/api/status", HTTP_GET, []() {
    if (!readAuthenticated()) return;
    server.sendHeader("Cache-Control", "no-store");
    server.send(200, "application/json", statusJson());
  });
  server.on("/api/config", HTTP_POST, []() {
    if (!adminAuthenticated()) return;
    // Custom header prevents ordinary cross-origin forms from changing calibration.
    if (server.header("X-Probe-Action") != "calibrate" || !server.hasArg("offset_c")) {
      server.send(400, "application/json", "{\"error\":\"invalid_request\"}");
      return;
    }
    String input = server.arg("offset_c");
    input.trim();
    char *end = nullptr;
    const float value = strtof(input.c_str(), &end);
    if (input.isEmpty() || end == input.c_str() || *end != '\0' || !isfinite(value) || value < -1 || value > 1) {
      server.send(400, "application/json", "{\"error\":\"offset_out_of_range\"}");
      return;
    }
    if (preferences.putFloat("offset", value) != sizeof(float)) {
      server.send(500, "application/json", "{\"error\":\"save_failed\"}");
      return;
    }
    offsetC = value;
    server.send(200, "application/json", "{\"ok\":true}");
  });
  server.onNotFound([]() { server.send(404, "application/json", "{\"error\":\"not_found\"}"); });
  server.begin();
}

void wifiTick() {
  const bool connected = WiFi.status() == WL_CONNECTED;
  if (connected && !wasConnected) {
    Serial.printf("[wifi] IP: %s\n", WiFi.localIP().toString().c_str());
    if (ENABLE_OTA && securityReady) {
      ArduinoOTA.setHostname(DEVICE_NAME);
      ArduinoOTA.setPassword(adminPassword.c_str());
      ArduinoOTA.onStart([]() { otaBusy = true; converting = false; });
      ArduinoOTA.onError([](ota_error_t error) {
        otaBusy = false;
        Serial.printf("[ota] error %u\n", unsigned(error));
      });
      ArduinoOTA.begin();
      otaReady = true;
    }
  }
  if (!connected && wasConnected) {
    Serial.println("[wifi] Desconnectat; les lectures continuen per USB.");
    if (otaReady) ArduinoOTA.end();
    otaReady = false;
    otaBusy = false;
  }
  wasConnected = connected;
  if (!connected && uint32_t(millis() - lastWifiAttempt) >= WIFI_RETRY_MS) {
    lastWifiAttempt = millis();
    Serial.printf("[wifi] Reconnectant (estat %d)...\n", int(WiFi.status()));
    WiFi.reconnect();
  }
}

void setup() {
  Serial.begin(115200);
  delay(1500);
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(DEVICE_NAME);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  const bool opened = preferences.begin("panettoneprobe", false);
  if (opened) {
    adminPassword = preferences.getString("admin", "");
    apiToken = preferences.getString("api", "");
    bool saved = true;
    if (adminPassword.length() != 24) {
      adminPassword = randomHex(12);
      saved = preferences.putString("admin", adminPassword) == adminPassword.length();
    }
    if (apiToken.length() != 64) {
      apiToken = randomHex(32);
      saved = (preferences.putString("api", apiToken) == apiToken.length()) && saved;
    }
    securityReady = saved;
    offsetC = preferences.getFloat("offset", 0);
    if (!isfinite(offsetC) || offsetC < -1 || offsetC > 1) offsetC = 0;
  }
  bootId = randomHex(8);
  Serial.printf("\nPanettone Probe v%s - %s\n", VERSION, DEVICE_NAME);
  if (securityReady) {
    Serial.printf("[local USB] Usuari web: admin\n[local USB] Contrasenya web/OTA: %s\n", adminPassword.c_str());
    Serial.printf("[local USB] Token API (privat): %s\n", apiToken.c_str());
  } else Serial.println("ERROR: credencials no desades; web i OTA bloquejats.");

  sensors.begin();
  sensors.setWaitForConversion(false);
  sensors.setResolution(sensorRom, 12);
  setupWeb();
}

void loop() {
  wifiTick();
  if (otaReady) ArduinoOTA.handle();
  server.handleClient();
  sensorTick();
  delay(2);
}
