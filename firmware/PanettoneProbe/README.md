# Panettone Probe v0.1.0

Firmware de fase 2 per a l'ESP32-C3 SuperMini. No modifica Panettone Lab ni
controla cap sortida. Les lectures continuen encara que no hi hagi Wi-Fi.

## Hardware verificat

| Fil Loxone | ESP32-C3 |
|---|---|
| Blanc, DQ | GPIO4 |
| Verd, VDD | 3V3 |
| Marró, GND | GND |
| Pull-up 4,7 kΩ | Entre GPIO4 i 3V3 |

Sonda vinculada explícitament a `28:19:94:2E:10:00:00:54`. El muntatge soldat ha
superat la prova USB T2 segons les comprovacions de l'usuari. Aquesta prova no
acredita l'aptitud de la sonda o la beina per al contacte alimentari.

## Configuració i compilació

Dependències: core ESP32 d'Espressif, OneWire i DallasTemperature. Seleccionar
`ESP32C3 Dev Module`, `USB CDC On Boot: Enabled`, flash de 4 MB i una partició
amb OTA (la partició per defecte de la placa seleccionada en disposa).

Copiar `config.example.h` a `config.h` i configurar el Wi-Fi. El fitxer privat
`config.h` està exclòs de Git. En aquest Mac està configurat l'SSID `MG_gurb`
amb les credencials facilitades per l'usuari, per substituir el Wi-Fi anterior
que assignava a la sonda una IP de la xarxa `172.31.99.x`.

El firmware Wi-Fi és independent de `../ProbeTest/ProbeTest.ino`. El backup
complet de la flash original s'ha fet abans de carregar ProbeTest; no s'ha
provat una restauració. Cap firmware de fase 2 s'ha carregat automàticament.

## Primer inici

1. Carregar el firmware per USB.
2. Obrir el monitor sèrie a 115200 bauds i prémer RESET per veure l'inici.
3. Anotar privadament la IP, l'usuari `admin`, la contrasenya web/OTA i el token
   de l'API. No enganxar credencials en captures ni converses.
4. Obrir `http://<IP>/`. El navegador demana usuari i contrasenya amb HTTP Digest.
5. Si la xarxa permet mDNS i OTA està activat, també es pot provar
   `http://panettone-probe-01.local/`; la IP continua sent la via principal.

La contrasenya web/OTA i el token es generen a l'ESP32 i es desen a la NVS,
dins de `panettoneprobe`. Es mantenen en reinicis i actualitzacions que no
esborrin aquesta partició. S'imprimeixen per USB en cada arrencada per facilitar
la posada en marxa. Cap endpoint web no els retorna.

## Comunicació

No cal MQTT, broker, accés a Internet ni sincronització NTP per llegir la sonda.
La xarxa Wi-Fi ha de ser compatible amb 2,4 GHz. Hi ha reconnexió automàtica i
un intent explícit cada 15 segons quan està desconnectat. No s'obre cap punt
d'accés de configuració sense autenticació.

- Conversió de temperatura cada 5 s, esperant almenys 800 ms sense bloquejar
  deliberadament el bucle principal durant aquesta espera.
- La sonda s'identifica per ROM. No es canvia automàticament a una altra.
- Les lectures invàlides i els 85 °C exactes s'assenyalen com a error. Aquest
  últim criteri és específic de la fermentació: no és un termòmetre per a forn.
- La lectura deixa de ser vàlida si té més de 15 s. Un error de la mostra més
  recent invalida immediatament la temperatura publicada.
- No s'amaga un error substituint-lo per l'última lectura bona.
- No hi ha històric a l'ESP32 en aquesta fase. SQLite i l'associació a una
  fermentació es faran després a Panettone Lab. Durant una caiguda del Wi-Fi
  aquesta versió no pot recuperar retrospectivament les mostres perdudes.

### API de lectura

`GET /api/status`, amb `Authorization: Bearer <TOKEN_API>` per a Panettone Lab,
o autenticació Digest per al navegador. Retorna JSON amb `Cache-Control: no-store`.
Una petició autenticada amb error de sensor continua retornant HTTP 200:
el consumidor ha de comprovar `valid`, `error` i l'edat de la mostra.

| Camp | Significat |
|---|---|
| `schema_version` | `1` |
| `firmware_version` | `0.1.0` |
| `device_id` | `panettone-probe-01` |
| `boot_id` | Identificador aleatori de l'arrencada |
| `sensor_rom` | Adreça de la sonda esperada |
| `valid` | Validesa actual de la lectura |
| `temperature_c` | Temperatura corregida o `null` |
| `raw_temperature_c` | Temperatura bruta o `null` |
| `offset_c` | Correcció persistent, entre −1 i +1 °C |
| `error` | `null` o codi d'error |
| `sample_sequence` | Comptador de mostres intentades, inclosos errors |
| `sample_age_ms` | Edat de l'última mostra intentada; `null` abans de la primera |
| `last_good_age_ms` | Edat de l'última mostra bona; `null` si encara no n'hi ha |
| `error_count` | Errors des de l'arrencada |
| `sample_interval_ms` | `5000` |
| `stale_after_ms` | `15000` |
| `uptime_s` | Temps des de l'arrencada |
| `wifi_connected`, `rssi_dbm`, `ip` | Diagnòstic de xarxa |
| `ota_enabled` | Servei OTA iniciat |

Errors possibles: `starting`, `sensor_missing_or_crc_error`,
`conversion_start_failed`, `sensor_read_failed`, `suspect_85c`, `stale`.
El parell `boot_id` + `sample_sequence` permet distingir mostres noves i reinicis.
En una integració posterior, la Raspberry ha de datar la recepció i detectar
també la pèrdua de comunicació; no pot confiar només en l'estat rebut anteriorment.

### Correcció

La web permet canviar l'offset, aplicat un sol cop sobre la lectura bruta.
`POST /api/config` exigeix autenticació Digest d'administració, el header
`X-Probe-Action: calibrate` i el camp de formulari `offset_c`. Rebutja text
invàlid, valors no finits i valors fora de ±1 °C abans de desar-los.
El token Bearer no autoritza canvis de configuració.

### Seguretat i OTA

HTTP i ArduinoOTA són per a una LAN de confiança: l'autenticació no xifra les
lectures ni el token de l'API. No publicar ports al router. La contrasenya OTA
és la mateixa que la web; es pot desactivar OTA amb `ENABLE_OTA = false` a
`config.h`. No hi ha canvis de credencials via web ni endpoint de reinici.

El firmware compilat conté les credencials Wi-Fi. Tractar els binaris i els
backups de flash com a fitxers privats.

## Proves físiques pendents de fase 2

- Verificar lectures, IP i autenticació des del mòbil.
- Desconnectar/reconnectar el Wi-Fi: la lectura USB ha de continuar i el servei
  ha de tornar quan la xarxa es recuperi, sense reiniciar manualment.
- Amb USB desconnectat, separar el cable de dades de la sonda i tornar a
  alimentar: l'API ha de retornar temperatura `null`; després reconnectar
  sempre sense alimentació i verificar la recuperació.
- Canviar temporalment l'offset, comprovar la diferència brut/corregit i la
  persistència després d'un reinici; tornar a zero fins al calibratge real.
- Verificar token incorrecte i token de lectura en una petició d'escriptura.
- Provar OTA amb contrasenya, amb la còpia de seguretat conservada.
- Fer una prova prolongada de funcionament abans de la integració.

La compilació comprova compatibilitat del codi amb les eines locals. No valida
per si sola la reconnexió real, l'OTA o la resposta del sensor en aquest firmware.
