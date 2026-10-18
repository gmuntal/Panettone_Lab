# Auditoria de la fermentadora i del Shelly

Data de consulta: 17 d’octubre de 2026. Totes les consultes al Shelly s’han fet amb RPC de lectura (`GetStatus`, `GetConfig`, `GetPeripherals`, `Script.List`, `Schedule.List` i `Webhook.List`). No s’ha enviat cap ordre de sortida ni s’ha modificat cap configuració.

## Arquitectura observada

- Panettone Lab és una aplicació Flask/Gunicorn d’un worker, amb cicles de monitoratge gestionats per fils interns i dades persistents a SQLite i `/data/photos`.
- El lector actual consulta `Shelly.GetStatus` cada 30 segons quan el seguiment està actiu. No hi ha cap controlador de temperatura ni cap codi que mani una sortida.
- La interfície es protegeix amb sessió web; els endpoints de consulta externa són independents i de només lectura.
- Loxone no forma part de l’arquitectura ni de l’abast.

## Shelly observat

- Model: **Shelly Plus UNI (SNSN-0043X)**, Gen 2, aplicació `PlusUni`, firmware **1.2.2** (`20240223-142029/1.2.2-g7c39781`).
- `Uni.GetPeripherals` confirma `dht22` connectat a `temperature:100` i `humidity:100`. Els noms configurats són «Temperatura» i «Humitat». Lectura de la consulta: 29,4 °C i 59,1 % RH.
- Hi ha dues sortides: `switch:0` i `switch:1`, ambdues sense nom configurat en la consulta original. Després d'aquesta auditoria, l'usuari ha confirmat que `switch:0=true` encén la manta i `switch:0=false` l'apaga. La confirmació identifica el canal de control, però l'estat RPC no verifica el corrent elèctric ni substitueix la inspecció de les proteccions físiques.
- `switch:0`: `in_mode=follow`, `initial_state=restore_last`; temporitzadors `auto_on` i `auto_off` desactivats.
- `switch:1`: `in_mode=follow`, `initial_state=match_input`; temporitzadors `auto_on` i `auto_off` desactivats.
- Les entrades digitals 0 i 1 estaven a `false`; l’entrada de comptatge 2 està desactivada.
- No hi ha scripts, programacions ni webhooks configurats (`Script.List`, `Schedule.List`, `Webhook.List` buits). MQTT està desactivat.
- La zona horària del Shelly és `Europe/Madrid`.

## Riscos i dades pendents

1. La sortida física que governa la resistència no es pot determinar per RPC: cal seguir els conductors, revisar l’esquema o una fotografia clara del cablejat. No s’ha d’endevinar `switch:0` o `switch:1`.
2. El Shelly Plus UNI té sortides de contacte sec de baixa tensió/corrent. La documentació del fabricant indica un màxim de commutació de 30 V i 300 mA. Per tant, no s’ha de connectar una resistència de xarxa directament a OUT1/OUT2. Cal confirmar si hi ha relé/contactor intermedi i verificar la bobina, protecció, càrrega i instal·lació amb una persona competent.
3. El comportament actual al reinici no és un estat segur garantint OFF: la sortida 0 pot restaurar l’últim estat; la sortida 1 segueix l’entrada. No hi ha un watchdog local, script, programació ni temporitzador d’apagada configurat al Shelly.
4. La comprovació RPC no pot demostrar protecció tèrmica física, fusible tèrmic, contactor, dimensionament del cable, aïllament ni l’estat real de la resistència.

## Arquitectura proposada per al desenvolupament segur

- Afegir una pantalla **Fermentadora** i una capa de controlador en simulació per defecte. S’ha afegit una ruta opcional i tancada per defecte a `Switch.Set` per la sortida 0, després que l’usuari confirmés que governa la manta; cal validar independentment les proteccions físiques abans d’armar-la.
- Modes de simulació: automàtic (histèresi), manual (demanda virtual) i aturat. Qualsevol fallada de sensor, dada caducada, sobretemperatura, temps màxim o finestra horària tanca la sortida **simulada** immediatament.
- Després d’un reinici de l’aplicació, tornar a aturat i demanda virtual OFF; conservar consigna/configuració i historial.
- Desar canvis, transicions i alarmes a SQLite vinculats a la fermentació activa. Reutilitzar lectures existents de 30 s per a la gràfica i consultar l’estat Shelly a l’interval curt del simulador.
- Per al control real futur caldrà primer identificar i validar el camí elèctric, configurar al Shelly un estat segur i un watchdog autònom, i provar el sistema sense càrrega abans d’una activació supervisada. El watchdog ha de continuar apagant la calefacció encara que la Raspberry o la xarxa caiguin.
- El codi només arma l’accionament quan `SHELLY_REAL_CONTROL_ENABLED`, `SHELLY_HEATER_WIRING_VERIFIED`, `SHELLY_THERMAL_CUTOFF_VERIFIED`, `SHELLY_RESTART_OFF_VERIFIED` i `SHELLY_WATCHDOG_VERIFIED` són `true`. Totes són `false` per defecte. Amb demanda ON, cada refresc RPC inclou `toggle_after` perquè el Shelly retorni a OFF si la Raspberry deixa de renovar l’ordre. Aquest lloguer de sortida no protegeix contra reinicis del mateix Shelly i no substitueix un tall tèrmic físic.
- Tot i la confirmació de `switch:0`, el circuit real encara necessita comprovar un relé/contactor adequat, el tall físic independent, el comportament segur després de reiniciar i el watchdog autònom. L’auditoria remota anterior va trobar `initial_state=restore_last`; no s’ha modificat el Shelly ni s’ha enviat cap ordre de sortida durant aquest canvi.

## Fonts del fabricant

- [Shelly Plus UNI: dispositiu, components RPC i perifèrics admesos](https://shelly-api-docs.shelly.cloud/gen2/Devices/Gen2/ShellyPlusUni/)
- [Shelly Switch: estat inicial, temporitzadors i modes d’entrada](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch/)
- [Shelly Schedule: llista i estructura de programacions](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Schedule/)
- [Shelly Plus UNI: característiques elèctriques i sortides](https://www.shelly.com/products/shelly-plus-uni)
