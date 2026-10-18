# Panettone Lab · redisseny i auditoria de desplegament

## Abast i estat

La versió local preparada és **v0.7.0**. Reorganitza el dashboard en cinc àrees (Inici, Fermentadora, Fermentacions, Càmera i Configuració), adapta la navegació a mòbil i escriptori, mostra les dades i esdeveniments de cada fermentació, permet descarregar-ne un ZIP autenticat i facilita explorar, comparar i reproduir les captures.

La base de dades no requereix cap migració per aquest redisseny. El control de la calefacció continua explícitament en simulació: cap ordre d’activació s’ha afegit ni enviat al Shelly.

## Auditoria de només lectura

La Raspberry Pi executa una sola instància de Panettone Lab sobre el volum persistent `panettone_lab_data`, amb SQLite i les fotografies a `/data`. La captura periòdica es desa a SQLite i al volum; el seguiment i l’identificador de la fermentació activa persisteixen després de reiniciar. Un redeploy, però, interrompria breument la lectura del sensor i la captura de fotografies.

Comprovació de producció el 18 d’octubre de 2026, 09:39 Europe/Madrid:

- Seguiment actiu i fermentació **#1** encara en curs, iniciada a les 09:04:32.
- Darrera lectura vàlida: 09:39:21, 28,4 °C i 53,0% HR.
- Darrera fotografia vàlida: 09:38:31.
- Controlador de calefacció en mode `stopped`; demanda simulada OFF; canals Shelly 0 i 1 informats OFF.
- El Shelly Plus UNI exposa `dht22` als canals de temperatura i humitat. No s’ha escrit cap configuració al dispositiu.
- Hi ha dos canals de sortida sense nom. La inspecció no permet identificar quin, si cap, governa la resistència ni si hi ha un contactor intermedi. No hi ha scripts, horaris ni webhooks al Shelly; `auto_off` està desactivat.

Per tant, el control real de la resistència continua bloquejat fins a traçar el cablejat i verificar relé/contactor, protecció tèrmica física i un mecanisme local segur davant pèrdua de comunicació. Aquesta auditoria no demostra que la sortida sigui segura després d’un reinici.

## Còpia de seguretat

Abans de fer canvis s’ha creat una còpia consistent i només de lectura:

- Fitxer: `exports/backups/panettone-lab-pre-redesign-2026-10-18.tar.gz`
- Mida: aproximadament 75 MB (80 MB arrodonits per `du`).
- SHA-256: `7948028e5b256a9570235fcd68e8bec9279b744a30fd26755bf3f5070ad0497e`
- Conté una còpia SQLite i 530 fitxers de fotografia. La verificació va trobar 2.157 lectures, 535 registres de fotografia, 1 esdeveniment, 1 fermentació i 1 registre d’actuació; `PRAGMA integrity_check` retorna `ok`. Totes les fotografies registrades com a correctes tenen fitxer corresponent.
- `gzip -t` i la lectura de tots els membres del TAR han acabat correctament.

La còpia és una salvaguarda, no pas un mecanisme de rollback segur mentre la fermentació continua: restaurar-la substituiria les dades capturades després de les 09:39 del 18 d’octubre. Si cal recuperar-la, primer cal aturar el servei en una finestra acordada, guardar una segona còpia de les dades més recents i comparar-les abans de restaurar.

## Validacions locals

- `node --check app/static/app.js`: correcte.
- Compilació sintàctica dels mòduls Python: correcta.
- 19 proves locals de SQLite/migració additiva, exportació, detecció de creixement i simulador: correctes.
- Les proves d’integració Flask i la prova de lectura HTTP amb `requests` no s’han pogut executar perquè aquests paquets no són instal·lats localment i la xarxa d’aquest entorn no permet descarregar-los.
- L’estructura HTML s’ha analitzat i no té identificadors duplicats; `git diff --check` no reporta errors.

## Desplegament i recuperació

**No s’ha publicat ni desplegat v0.7.0.** Publicar una imatge no aturaria el servei; aplicar-la a Portainer sí que reiniciaria el contenidor i podria obrir un buit de dades dins la fermentació activa. No s’ha forçat aquest risc.

Quan la fermentació hagi acabat o hi hagi una finestra de manteniment acceptada:

1. Fer una nova còpia consistent de SQLite i fotografies immediatament abans del canvi.
2. Executar la suite completa amb les dependències de `requirements.txt` i revisar que l’Action de GitHub publiqui la imatge ARM64 correctament.
3. Desplegar v0.7.0 a Portainer i comprovar `/healthz`, accés, monitoratge, exportació i continuïtat de les fotografies.
4. Si el servei no passa les comprovacions, tornar a la imatge anterior **v0.6.0** sense restaurar la base de dades, ja que v0.7.0 no canvia l’esquema.

No s’ha d’activar el control automàtic real com a part d’aquest desplegament.
