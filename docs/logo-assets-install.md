# Panettone Lab — instal·lació del logotip v0.6.0

El paquet `exports/panettone-lab-logo-assets.zip` conté les icones i el màster oficial. El màster PNG es conserva sense canvis; les mides web s'han generat a partir de la mateixa imatge i amb el fons blanc exterior transparent. La font és raster, així que no s'ha traçat ni redibuixat cap versió vectorial.

## Actualització del servidor

Desplega la imatge Panettone Lab `v0.6.0` amb el procediment habitual de Portainer/GitOps i espera que el contenidor estigui en execució. Les URL de les icones, el manifest, el CSS i el JavaScript porten `?v=0.6.0`; el service worker té una memòria cau nova i elimina la memòria cau anterior quan s'activa. El manifest conserva `start_url` i `scope` a `/` i el nom instal·lat `Panettone Lab`.

## Actualització a iPhone/iPad

1. Obre l'adreça actual de Panettone Lab a Safari amb connexió i inicia sessió.
2. Actualitza la pàgina i espera uns segons perquè s'activi el service worker nou.
3. Si la icona de la pantalla d'inici continua sent l'antiga, elimina només la icona de Panettone Lab de la pantalla d'inici i torna a afegir el web app des de Safari: **Compartir → Afegir a la pantalla d'inici → Obre com a app web → Afegir**. Això torna a registrar la icona amb l'`apple-touch-icon` nou. La guia d'Apple descriu aquest procés a [Convertir un lloc web en una app a Safari](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios).

No canviïs l'adreça de Panettone Lab. En altres navegadors, torna a carregar la pàgina; les icones noves tenen URL versionades.
