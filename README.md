# Panettone Lab v0.2.0

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
- Base SQLite, fotografies i estat preparats dins d’un volum persistent.
- L’anàlisi visual estima l’alçada de la massa dins una zona del pot que es pot calibrar des del dashboard. Es pot marcar un nivell inicial i seguir-ne la variació al llarg del temps. És una estimació d’alçada visible, no del pes ni del volum real.
- Els fotogrames sense una transició prou clara es desen sense mesura. La càmera i el pot han de quedar fixos; cal revisar la zona calibrada després de moure’ls.
- Pillow redimensiona les captures abans de l’anàlisi per mantenir baix el cost de CPU a la Raspberry Pi.
- El service worker desa només l’esquelet estàtic. Dades, captures i sessió requereixen connexió i autenticació.

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
6. Portainer crea el volum `panettone_lab_data`. Abans d’actualitzar, mantén còpia de seguretat d’aquest volum; un deploy de Stack no l’esborra.

Per a un deploy reproduïble, canvia `IMAGE_TAG` a un tag semàntic (`v0.2.0`, per exemple) i fes que el commit de GitOps apunti a aquell tag. `latest` simplifica la primera instal·lació però és mutable.

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
| `SESSION_COOKIE_SECURE` | `false` | Activa-ho darrere d’HTTPS |
| `CONTAINER_PLATFORM` | `linux/arm64` | Plataforma d’imatge; Pi 4 per defecte, usa `linux/amd64` en un host Intel/AMD |

## Dades i API

- `GET /healthz`: estat del procés, sense autenticació, per healthcheck Docker.
- `GET /api/state`, `/api/readings?hours=24`, `/api/photos?limit=48`: requereixen sessió autenticada.
- `GET /photos/<fitxer>` també requereix sessió.
- El volum `panettone_lab_data` conté `panettone.db` i `photos/`.

Les fallades de dispositius es desen com a mostres d’estat amb l’error i no aturen els altres cicles. Els intervals parteixen en iniciar el contenidor i tornen a començar després d’un reinici.

## Comprovacions

```sh
python -m unittest discover -s tests -v
```

Les comprovacions automatitzades cobreixen login, API, lectura de valors Shelly amb resposta simulada i detecció del canvi de nivell amb perfils sintètics. La validació d’RTSP/Shelly i l’ajust final de la zona de creixement requereixen desplegar en la LAN on són els dispositius.
