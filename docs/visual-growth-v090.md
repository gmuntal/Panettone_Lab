# Panettone Lab v0.9.0 anàlisi visual de fermentacions

La càmera utilitza un únic interval des de la referència calibrada fins a la fotografia final seleccionada. La fotografia inicial queda fixa; la final, el percentatge, el factor i la gràfica avancen junts. El selector de miniatures no filtra l’anàlisi ni modifica la captura.

## Causes corregides

El detector anterior limitava el llindar de brillantor a 205. Amb la il·luminació infraroja real, el vidre buit ja superava aquest valor: el filtre de brillantor per sobre de la superfície rebutjava moltes captures baixes i intermèdies. Les finestres fixes de 14 files i les comprovacions d’alçada/coordenades prèvies també depenien massa de la fase de creixement. Desar un calibratge només recalculava la darrera fotografia; les anteriors conservaven resultats d’altres zones d’anàlisi.

La interfície combinava un període independent amb la referència seleccionada. Això truncava la gràfica i complicava la sincronització. La mètrica de contrast limitada a 1 no era una confiança estadística validada.

## Detector i càlcul

`app/calibrated_growth.py` analitza set franges interiors del recipient, excloent-ne les parets laterals. Estima el contrast respecte de la massa propera al fons calibrat, busca una transició sostinguda i exigeix acord espacial entre franges. Rebutja imatges sense contrast, geometria canviada o superfície ambigua. Una preferència temporal suau i simètrica permet tant creixement com baixada; no força una sèrie monòtona.

Una petita diferència entre la detecció de referència i la línia manual pot corregir sistemàticament la vora detectada. Correccions superiors a 0,04 de l’alçada de la imatge no s’apliquen. El resultat segueix sent una estimació d’alçada visible, aproximació al volum només amb una secció interior constant.

El factor és `(fons − superfície actual) / (fons − superfície inicial)`. El percentatge és `(factor − 1) × 100`. La referència manual és 0%. No es reutilitza un percentatge anterior si la imatge actual és invàlida, pendent o encara no s’ha carregat.

## Evidència real del 18 d’octubre de 2026

Tall de l’auditoria: fermentació 2, de **14:06:07 a 18:49:12 Europe/Madrid**, referència 677 i quatre coordenades guardades per l’usuari. El registre detallat és a [visual-growth-2026-10-18.csv](visual-growth-2026-10-18.csv); les hores d’aquest CSV són UTC.

- 140 registres: 139 fotografies disponibles i una captura fallida, a les 15:26:27.
- 139 deteccions vàlides incloent la referència manual: **99,3% de cobertura dels registres**, 139/139 sobre les fotografies disponibles.
- Els resultats antics persistits tenien 32 deteccions vàlides; 107 indicaven `no_surface_transition`. No és una comparació controlada a calibratge constant, perquè els resultats antics podien correspondre a altres ajustos.
- Primera fotografia vàlida observada sobre +100%: **16:44:38**, 2 h 38 min 31 s després de la referència, +100,2%, ×2,002.
- A les **16:46:41**: +100,2%, ×2,002; a les **17:06:42**: +115,1%, ×2,151.
- No s’observa +200% en aquest interval. No es publica cap hora de triplicació inventada.
- L’anàlisi local del lot va durar aproximadament 1,1 s al Mac, excloent la pausa voluntària del treballador. No és una mesura del rendiment de la Raspberry.

La cobertura no mesura exactitud. No hi ha etiquetatge manual independent de totes les superfícies ni una precisió estadística calibrada. Els perfils numèrics de tres fotografies reals formen una prova de regressió, no una validació independent de precisió. Les imatges originals continuen al volum; no s’afegeixen al repositori.

## Interfície i persistència

La secció s’organitza en comparació, reproducció, gràfica i historial. Manté les quatre guies fines i normalitzades; el polling no substitueix ajustos en edició. El recipient conserva les coordenades laterals/fons reutilitzables, i cada fermentació conserva versions del seu calibratge i referència.

L’indicador de la fotografia dreta mostra percentatge i factor. Els estats ×2 i ×3 descriuen el fotograma actual i desapareixen si baixa el creixement; els marcadors històrics conserven la primera fotografia vàlida sobre cada llindar. No s’interpola una hora de creuament entre fotografies. La gràfica usa temps real, manté els buits i mostra cobertura, sense anunciar confiança del 100%.

`visual_calibrations` i `visual_estimates` són taules additives. La primera migració crea una còpia SQLite consistent a `/data/backups/`, al mateix volum, i importa el calibratge anterior. Les dades originals no es reescriuen. La memòria cau depèn del calibratge, l’algoritme, el fitxer de referència i tota la seqüència temporal precedent; els resultats incompatibles no es reutilitzen.

Un sol treballador d’anàlisi processa els lots fora dels fils de captura i control. Limita la cua a quatre lots, cedeix 25 ms entre imatges recalculades i reutilitza els resultats persistits. L’endpoint autenticat `/api/growth/sequence` retorna resultats pendents immediatament i utilitza `Cache-Control: no-store`.

## Proves i operació

La suite local completa té 61 proves Python, inclosa la que executa 14 proves JavaScript del controlador real amb DOM i càrrega d’imatges controlables. Inclou curses entre imatges i peticions, edició durant polling, timelapse a totes les velocitats, llindars, buits, fórmules, dades reals, migració i invalidació de memòria cau. La prova opcional amb `PANETTONE_REAL_PHOTOS` ha recorregut les fotografies exportades de la seqüència real. Les proves utilitzen bases temporals.

La comprovació de navegador a 390 × 844 i en escriptori confirma el comparador i l’indicador, sense desbordament horitzontal ni errors de consola. S’ha provat el timelapse amb fotografies reals. No equival a una prova en un iPhone físic.

El build ARM64 complet ha acabat correctament i la suite dins de la imatge ha executat 61 proves en 22,6 s, amb una omesa perquè Node no forma part de la imatge de producció. Les 14 proves JavaScript han passat al Mac. El constructor ARM local requereix una variant temporal amb `RUN --security=insecure` pel problema de syscall 159 del seu perfil seccomp; el Dockerfile del repositori no es modifica. El constructor de prova està separat i limitat a 768 MB.

Els mòduls de dispositius, scheduler i control tèrmic es mantenen intactes. Un redeploy reinicia l’únic procés que allotja també els pollers: no s’ha d’activar durant un control tèrmic real ni sense comprovar la continuïtat del seguiment. No s’ha d’iniciar una segona instància amb aquests treballadors.
