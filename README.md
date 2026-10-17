# Panettone Lab v0.5.0

PWA local en català per observar la fermentació del lievito madre. El servei és autònom i no depèn de Cuinetes: parla directament amb la Tapo C210 i el Shelly Plus UNI a la xarxa local.

## Arquitectura

```text
Tapo C210 --RTSP /stream1--┐
                           ├--> Panettone Lab (Flask + FFmpeg) --> SQLite + /data/photos
Shelly Plus UNI --RPC------┘                  │
                                              └--> Dashboard PWA + API autenticada
GitHub Actions --> GHCR (amd64 + arm64) --> Portainer Stack des d'aquest repositori
```

- Un contenidor i un procés Gunicorn amb un worker: els treballs periòdics s’executen una sola vegada.
- Fotografia cada 120 segons; temperatura i humitat cada 30 segons.
- El seguiment es pot iniciar i aturar des del dashboard. Aturat, no es fan lectures ni es capturen fotos; l’estat es conserva a SQLite i també després de reiniciar el contenidor. En una instal·lació nova queda aturat fins que s’inicia manualment.
- Base SQLite, fotografies i estat preparats dins d’un volum persistent. A l'actualització a v0.4.0 s'afegeixen taules i enllaços opcionals amb `ALTER TABLE` només quan falten; cap lectura/foto antiga no s'esborra ni es reescriu. Fes còpia del volum abans d'actualitzar.
- L’anàlisi visual estima l’alçada de la massa dins una zona del pot que es pot calibrar des del dashboard. Es pot marcar un nivell inicial i seguir-ne la variació al llarg del temps. És una estimació d’alçada visible, no del pes ni del volum real.
- En obrir «Configura la zona del pot», es captura una imatge actual i se’n prova la detecció provisional amb la zona seleccionada; no s’afegeix a l’historial de fotografies. Es pot repetir la prova després d’ajustar el rectangle.
- Els fotogrames sense una transició prou clara es desen sense mesura. La càmera i el pot han de quedar fixos; cal revisar la zona calibrada després de moure’ls.
- Pillow redimensiona les captures abans de l’anàlisi per mantenir baix el cost de CPU a la Raspberry Pi.
- El service worker desa només l’esquelet estàtic. Dades, captures i sessió requereixen connexió i autenticació.
- **Control de fermentadora v0.5.0 en simulació:** llegeix el DHT22 i l’estat de les dues sortides del Shelly cada 5 s; mostra temperatura, consigna, mode, programa horari, demandes simulades, gràfica i alarmes. El control automàtic fa servir histèresi, límit de temps ON, temps mínim entre canvis, detecció de lectures invàlides i tall virtual per sobretemperatura. La configuració i el registre s’afegeixen a SQLite sense reescriure les dades antigues.
- **No acciona la resistència.** Els modes Automàtic i Manual són simulacions; cap ruta d’API no envia una ordre de canvi d’estat al Shelly. Després de reiniciar, el simulador torna a Aturat. No activar control real fins a identificar el canal i validar cablejat, relé/contactor, tall tèrmic físic i un watchdog local independent. Vegeu [l’auditoria de la fermentadora](docs/fermenter-audit.md).

## Execució local

```sh
cp .env.example .env
```

Canvia `APP_SECRET_KEY` per una clau aleatòria d’almenys 32 caràcters i configura credencials d’accés i de dispositius. Després:

```sh
docker compose up -d --build
```

Obre `http://<IP-Raspberry-Pi>:8088`. La primera arrencada crea la base de dades i inicia els cicles de captura/lectura. L’aplicació exigeix usuari, contrasenya i clau de sessió; no hi ha credencial per defecte.

En producció amb HTTPS, defineix `SESSION_COOKIE_SECURE=true`. Mantén el servei en una VLAN/LAN de confiança o posa’l darrere del proxy HTTPS que ja gestioni la xarxa; el contenidor no publica ni reutilitza cap port o volum d’un altre servei.

## Portainer i GitOps

1. Crea el repositori GitHub `panettone-lab` i puja aquesta branca `main`.
2. A GitHub, activa Actions. El workflow publica `ghcr.io/<propietari>/panettone-lab:latest` per a `main`, i tags `v*` per a versions, en `linux/amd64` i `linux/arm64`.
3. Publica la imatge del paquet GHCR per permetre a la Raspberry Pi descarregar-la; si és privada, crea un registry credential a Portainer.
4. A Portainer crea una Stack des del repositori GitHub, branca `main`, compose path `docker-compose.yml`; activa GitOps/polling segons la política d’actualització desitjada i configura «re-pull image» en redeploy perquè recarregui `latest`.
5. Afegeix a la configuració de variables d’entorn de la Stack `APP_SECRET_KEY`, `AUTH_USERNAME` i `AUTH_PASSWORD` (obligatòries); introdueix-hi també les credencials de dispositius si en fas servir. No pugis `.env` ni secrets a Git. Ajusta `GHCR_IMAGE` al camí real del paquet. Per a `docker compose` local, copia `.env.example` a `.env`.
6. Per activar les consultes externes de només lectura, crea un token llarg i aleatori i desa'l com a `READONLY_API_TOKEN` a Portainer. Si el deixes buit, l'API v1 respon amb 401. El token és independent del login web i no permet canviar el monitoratge ni controlar dispositius.
7. Portainer crea el volum `panettone_lab_data`. Abans d’actualitzar, mantén còpia de seguretat d’aquest volum; un deploy de Stack no l’esborra.

Per a un deploy reproduïble, canvia `IMAGE_TAG` a un tag semàntic (`v0.5.0`, per exemple) i fes que el commit de GitOps apunti a aquell tag. `latest` simplifica la primera instal·lació però és mutable.

Amb `latest`, GitOps pot detectar un commit abans que GitHub Actions acabi de publicar la imatge corresponent. Comprova que el workflow «Build and publish container» ha acabat correctament abans de forçar un redeploy amb «re-pull image»; si el redeploy s’ha avançat, torna’l a executar quan la publicació sigui verda. Amb tags immutables, actualitza `IMAGE_TAG` després que el tag s’hagi publicat.

## Configuració

| Variable | Per defecte | Ús |
|---|---|---|
| `CAMERA_RTSP_URL` | `rtsp://10.85.3.237:554/stream1` | URI de vídeo de la Tapo C210 |
| `CAMERA_USERNAME`, `CAMERA_PASSWORD` | buit | Credencials RTSP opcionals |
| `SHELLY_URL` | `http://10.85.3.202/rpc/Shelly.GetStatus` | RPC JSON |
| `SHELLY_USERNAME`, `SHELLY_PASSWORD` | buit | HTTP Digest opcional |
| `TEMPERATURE_KEY`, `HUMIDITY_KEY` | `temperature:100.tC`, `humidity:100.rh` | Ruta als valors del JSON Shelly |
| `SENSOR_INTERVAL_SECONDS` | `30` | Període de lectura |
| `PHOTO_INTERVAL_SECONDS` | `120` | Període de captura |
| `AUTH_USERNAME`, `AUTH_PASSWORD` | obligatori | Protecció del dashboard |
| `APP_SECRET_KEY` | obligatori | Signatura de sessió, mínim 32 caràcters |
| `READONLY_API_TOKEN` | buit | Token Bearer independent de només lectura; buit desactiva `/api/v1` |
| `SESSION_COOKIE_SECURE` | `false` | Activa-ho darrere d’HTTPS |
| `CONTAINER_PLATFORM` | `linux/arm64` | Plataforma d’imatge; Pi 4 per defecte, usa `linux/amd64` en un host Intel/AMD |

## Sessions, esdeveniments, exportació i API

- `GET /healthz`: estat del procés, sense autenticació, per healthcheck Docker.
- `GET /api/state`, `/api/readings?hours=24`, `/api/photos?limit=48`: requereixen sessió autenticada.
- `GET /photos/<fitxer>` també requereix sessió.
- El bloc «Sessions i anotacions» permet iniciar/finalitzar una fermentació i registrar refrescos (massa mare, farina, aigua i farina), pH, temperatura de massa, entrada/sortida de nevera, consignes, observacions i incidències. Les captures noves s'associen a la sessió activa; les històriques no s'alteren.
- Les rutes de `/api/sessions` són una compatibilitat anterior que infereix finestres a partir de buits de dades. Per a fermentacions reals usa `/api/v1/fermentations`.
- `GET /api/v1/status`, `/readings`, `/photos`, `/photos/{id}`, `/photos/{id}/image`, `/events`, `/fermentations`, `/fermentations/{id}`, `/fermentations/{id}/export` i `/export` són de només lectura i requereixen `Authorization: Bearer <READONLY_API_TOKEN>`. Les rutes `/readings`, `/photos` i `/events` accepten `start`, `end` (ISO 8601 amb zona horària), `limit`, `offset`; lectures/fotos/esdeveniments també accepten `fermentation_id`. L'exportació requereix inici i final i retorna CSV, metadades i JPEG originals. L'API limita a 120 peticions/minut per IP.
- L'especificació està a [openapi.yaml](openapi.yaml). `/api/v1/export?start=2026-10-16T20:00:00%2B02:00&end=2026-10-17T09:00:00%2B02:00` permet baixar un interval concret amb el token configurat.
- Les lectures anteriors a una sessió explícita resten sense sessió associada; no s'assignen retrospectivament per preservar els fets registrats.
- Per analitzar ara les dades des de qualsevol conversa, adjunta el ZIP exportat. ChatGPT no pot consultar una API REST privada només perquè existeixi. Per a consulta directa cal un adaptador MCP de només lectura i un Secure MCP Tunnel cap a aquesta xarxa privada, configurats dins d'un espai/compte ChatGPT compatible. El túnel necessita credencials de plataforma i manté una connexió sortint cap a OpenAI; no s'ha iniciat ni configurat en aquest canvi. No cal obrir ports del router ni exposar la càmera o SQLite.
- El volum `panettone_lab_data` conté `panettone.db` i `photos/`.

Les fallades de dispositius es desen com a mostres d’estat amb l’error i no aturen els altres cicles. Els intervals parteixen en iniciar el contenidor i tornen a començar després d’un reinici.

## Fermentadora — estat de seguretat

La lectura real observada és un DHT22 connectat al Shelly Plus UNI (firmware 1.2.2). Hi ha dues sortides, però la inspecció de programari no identifica quina està connectada al circuit de calefacció ni si hi ha un relé/contactor intermedi. Les sortides apareixen sense nom; no hi ha scripts, horaris, webhooks ni temporitzadors automàtics locals configurats. L’estat inicial observat no garanteix un OFF segur després d’un reinici. **No s’ha alterat la configuració del Shelly.**

La pantalla de fermentadora permet canviar consigna, histèresi, mínim entre commutacions, màxim ON, límit d’alarma i horari per a l’experimentació amb la simulació. Les lectures de supervisió del DHT22 es desen al runtime; la gràfica reutilitza les lectures històriques de 30 s existents quan el seguiment està actiu. Les actuacions del simulador i alarmes s’associen a la fermentació activa si n’hi ha una. Això no demostra que les proteccions físiques funcionin ni és un substitut d’un termòstat/fusible tèrmic independent.

Abans de cap activació real cal que una persona competent traçi el cablejat, identifiqui el canal correcte, comprovi l’etapa de potència i la protecció tèrmica, i configuri/provi una desconnexió autònoma local al Shelly si el controlador deixa de comunicar. Després cal fer proves sense càrrega i una activació supervisada explícitament autoritzada. Les sortides són contactes secs de baixa tensió/corrent segons [les especificacions del Shelly Plus UNI](https://www.shelly.com/products/shelly-plus-uni); no s’hi ha de connectar directament una resistència de xarxa.

## Comprovacions

```sh
python -m unittest discover -s tests -v
```

Les comprovacions automatitzades cobreixen exportació ZIP i creixement. L'API web també té proves d'integració quan Flask i requests són instal·lats; la validació d’RTSP/Shelly i l’ajust final de la zona de creixement requereixen la LAN dels dispositius. Abans d'actualitzar la Raspberry, executa les proves completes i fes una còpia de seguretat del volum.
