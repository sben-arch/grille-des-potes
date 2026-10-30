# Grille des potes

Page de pronostics du jour (foot) : les amis cochent 1 / N / 2 et envoient leur grille par WhatsApp.
Les matchs et les cotes Betclic sont relevés chaque matin par `build.mjs` (source : The Odds API).

## Réglages (facultatifs)

Dans le dépôt : Settings > Secrets and variables > Actions > onglet Variables.

- `WHATSAPP_PHONE` : ton numéro WhatsApp au format international, sans le + (ex. 33612345678).
- `DAILY_BUDGET` : nombre maximum d'appels de cotes par jour (un appel = un championnat).

Le secret `ODDS_API_KEY` (onglet Secrets) contient ta clé The Odds API.

## Relancer à la main

Onglet Actions > « Mise à jour de la grille » > Run workflow.
