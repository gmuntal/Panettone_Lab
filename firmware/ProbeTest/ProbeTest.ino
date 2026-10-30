/* Panettone Lab: prova USB de la sonda 1-Wire, sense Wi-Fi.
 * DQ blanc -> GPIO4; GND marro -> GND; VDD verd -> 3V3.
 * Pull-up de 4,7 kohm entre GPIO4 i 3V3.
 * Dependencies: OneWire (Paul Stoffregen), DallasTemperature.
 */
#include <OneWire.h>
#include <DallasTemperature.h>
#include <math.h>

constexpr uint8_t ONE_WIRE_PIN = 4;
OneWire oneWire(ONE_WIRE_PIN);
DallasTemperature sensors(&oneWire);

void setup() {
  Serial.begin(115200);
  delay(2000);
  sensors.begin();
  Serial.println("\nPanettone Lab - prova 1-Wire T2 a GPIO4 (espera fixa 800 ms)");
}

void loop() {
  // Tornem a explorar per detectar desconnexions i reconnexions.
  sensors.begin();
  const int count = sensors.getDeviceCount();
  Serial.print("Sensors compatibles detectats: ");
  Serial.println(count);
  if (count != 1) {
    Serial.println(count == 0
      ? "ERROR: cap sensor. Revisa fils, pull-up i alimentacio."
      : "ERROR: connecta nomes una sonda per a aquesta prova.");
    delay(2000);
    return;
  }

  DeviceAddress address;
  if (!sensors.getAddress(address, 0) ||
      OneWire::crc8(address, 7) != address[7]) {
    Serial.println("ERROR: adreca 1-Wire invalida.");
    delay(2000);
    return;
  }

  Serial.print("ROM: ");
  for (uint8_t i = 0; i < 8; ++i) {
    if (address[i] < 16) Serial.print('0');
    Serial.print(address[i], HEX);
    if (i < 7) Serial.print(':');
  }
  Serial.println();
  if (address[0] != 0x28) {
    Serial.println("ERROR: familia diferent de DS18B20 (0x28). Cal identificar-la.");
    delay(2000);
    return;
  }

  sensors.setResolution(address, 12);
  // Prova diagnostica: no confiem en el polling del bit de final de conversio.
  // Esperem 800 ms complets abans de llegir, tambe amb resolucio de 12 bits.
  sensors.setWaitForConversion(false);
  sensors.requestTemperatures();
  delay(800);
  const float temperature = sensors.getTempC(address);
  if (!isfinite(temperature) || temperature == DEVICE_DISCONNECTED_C ||
      temperature < -55.0f || temperature > 125.0f) {
    Serial.println("ERROR: lectura invalida o sonda desconnectada.");
  } else if (temperature == 85.0f) {
    Serial.println("AVIS: 85 C exactes; possible valor d'arrencada. Revisa abans d'acceptar.");
  } else {
    Serial.print("Temperatura sense correccio: ");
    Serial.print(temperature, 2);
    Serial.println(" C");
  }
  delay(2000);
}
