# Memecoin Radar

*[English version](README.md)*

Pipeline temps réel et banc d'essai statistique, appliqués à un cas concret : les nouveaux tokens lancés sur [Pump.fun](https://pump.fun).

Le bot écoute le flux en direct, filtre et note chaque token, envoie des alertes, puis **mesure ce qui s'est réellement passé ensuite**. Le banc d'essai répond à la vraie question : *cette stratégie rapporte-t-elle de l'argent, ou est-ce du hasard ?*

> **Résultat de l'étude : aucune des stratégies testées n'est démontrée rentable.** C'est un résultat utile : l'outil est fait pour mettre à l'épreuve les idées qui ont l'air bonnes, pas pour les confirmer. Voir [les résultats](#résultats).

## Ce que ce projet démontre

| Compétence | Où la voir |
|---|---|
| **Flux temps réel résilient** : WebSocket, reconnexion à backoff exponentiel, souscriptions rejouées après coupure, gestion de la capacité | `src/sources/pumpListener.ts` |
| **Intégration d'API externes fragiles** : file d'attente respectant un quota, passerelles IPFS en parallèle avec relance, dégradation gracieuse quand un service tombe | `src/enrichment/` |
| **Architecture testable** : toutes les dépendances sont injectées, le même code tourne en production et dans les tests | `src/radar.ts` |
| **Rigueur statistique** : contrôle par placebo (test de permutation), intervalles de confiance bootstrap, correction pour tests multiples, graine fixe | `src/analysis/` |
| **Qualité** : TypeScript strict, 118 tests, vérification que les tests détectent les régressions | `tests/` |

## Démarrage en une commande

Aucune clé, aucun compte, aucun réseau nécessaire. Node.js 22 ou plus récent.

```bash
npm ci && npm run demo
```

La démo rejoue le banc d'essai sur les **1 184 tokens réellement suivis** en septembre 2026 (fichier fourni dans `data/sample/`) et affiche le rapport complet en moins d'une seconde. Même graine, mêmes chiffres, à chaque exécution. Les noms et symboles des tokens y sont remplacés par des alias (`Token 0001`, `TK0001`) ; les adresses, prix et scores sont ceux relevés.

## Résultats

Sur 919 candidats avec historique de prix, entrée au prix de l'alerte et exécution **parfaite** (donc optimiste) :

- **Le score classe bien les candidats.** Le pic médian passe de ×1,16 (score < 50) à ×1,42 (score ≥ 90).
- **Mais ce pic n'est pas encaissable.** C'est un maximum mesuré après coup. Dès qu'on simule une vraie sortie (objectif de gain, stop suiveur, vente à heure fixe : 21 règles testées), la moyenne reste sous ×1,00. La meilleure atteint ×0,99, avant frais.
- **Aucune hypothèse n'est démontrée rentable.** Sur 14 idées de stratégie (dont une avec trop peu de données pour être testée), aucune n'a une moyenne nette significativement supérieure à ×1,00.

```
Hypothèse                                         n   Brute   Nette     IC 95 % (net)   p placebo   p rentable*   Démontré
Score ≥ 70 et holders < 80 %, objectif ×1,25    354   ×0,94   ×0,91   [×0,85 ; ×0,97]       0,350         1,000        non
Entrée ≥ 100 SOL, objectif ×1,25                396   ×0,98   ×0,95   [×0,89 ; ×1,01]       0,015         1,000        non
Entrée ≥ 150 SOL + lien X, objectif ×1,25        59   ×1,05   ×1,02   [×0,89 ; ×1,13]       0,052         1,000        non
Achat au franchissement de 40k$, vente à 50k$   271   ×0,88   ×0,85   [×0,79 ; ×0,90]           —         1,000        non
```

`*` = p-value corrigée pour les 14 hypothèses testées (Bonferroni).

**Comment lire ces lignes.** Deux questions différentes, deux colonnes :

- *« Mieux que le hasard ? »* (`p placebo`, non corrigée). Le filtre « entrée ≥ 100 SOL » fait mieux que des sous-groupes aléatoires de même taille (p ≈ 0,015) : trier selon la taille d'entrée aide donc un peu. Après correction pour les 14 tests (et les dizaines d'essais de l'exploration), ce résultat n'est plus significatif.
- *« Rentable ? »* (`IC` et `p rentable`). Même le meilleur filtre reste sous ×1,00 après frais (×0,95). **Mieux trié ne veut pas dire rentable.** Le sous-groupe « lien X, ×1,05 » (59 candidats) *a l'air* gagnant, mais son intervalle de confiance va de ×0,89 à ×1,13 : rien ne permet de dire qu'il gagne de l'argent.

- **Simulation de trading (papier) sur 223 trades** : moyenne ×0,943 avant frais, ×0,913 après frais, soit −1,93 SOL simulés. Certaines sessions sont positives, d'autres lourdement négatives : c'est ce qu'on attend d'un avantage nul.

## Architecture

```
Flux PumpPortal (WebSocket)
        │  nouveau token + chaque trade
        ▼
  Observation 45 s          ← le token est suivi, ses trades sont accumulés
        │
        ▼
  Étage 1 : filtre gratuit  ← ≥ 5 acheteurs uniques et market cap ×1,5 (zéro appel API)
        │  ne passe qu'une petite fraction
        ▼
  Étage 2 : enrichissement  ← holders et autorités (Helius), liens sociaux (IPFS)
        │
        ▼
  Score /100 ──────────────► Alerte Telegram (si ≥ 70)
        │                    Position papier (si holders < 80 %)
        ▼
  Suivi du prix ───────────► outcomes.jsonl   (ce qui s'est vraiment passé)
                                   │
                                   ▼
                    Banc d'essai : calibration, règles de sortie,
                    hypothèses + placebo + correction multiple
```

Le filtre en deux étages a une raison précise : le plan gratuit Helius est limité en débit, alors que des milliers de tokens sont créés par jour. L'étage 1 n'utilise que les données déjà reçues et écarte l'essentiel avant le premier appel payant.

| Dossier | Rôle |
|---|---|
| `src/radar.ts` | Orchestrateur du pipeline (dépendances injectées) |
| `src/sources/` | Flux WebSocket, reconnexion, souscriptions |
| `src/enrichment/` | Client Helius à file d'attente, métadonnées IPFS, prix du SOL |
| `src/scoring/` | Filtre gratuit, barème sur 100 (fonction pure), collecte des signaux |
| `src/tracking/` | Suivi du prix après notation, détection de vagues de noms |
| `src/execution/` | Gestion des positions et courtier **papier** |
| `src/notify/` | Alertes Telegram (repli sur la console sans configuration) |
| `src/analysis/` | Statistiques, règles de sortie, batterie d'hypothèses, rapport |
| `scripts/backtest.ts` | Ligne de commande du banc d'essai |
| `data/sample/` | Jeu de données réel, noms anonymisés : 1 185 candidats suivis, 464 ordres papier |

## Lancer le bot en direct

```bash
cp .env.example .env     # puis remplir les clés souhaitées
npm run dev
```

Toutes les clés sont optionnelles : sans Helius, les critères on-chain ne rapportent aucun point ; sans Telegram, les alertes s'affichent dans la console. Les résultats s'écrivent dans `logs/outcomes.jsonl` et `logs/paper-trades.jsonl`. Pour une exécution longue : `npm run build && npm start`.

Les trades du flux sont facturés au volume par le fournisseur (environ 0,01 SOL pour 10 000 messages), y compris en simulation.

## Le banc d'essai

```bash
npm run backtest                        # sur logs/outcomes.jsonl (sinon l'échantillon fourni)
npm run backtest -- --input mon-fichier.jsonl --trades logs/paper-trades.jsonl
npm run backtest -- --json              # sortie exploitable par un autre outil
npm run backtest -- --seed 7 --iterations 20000 --sol-usd 150
```

**Méthode.** Pour chaque idée de stratégie, le banc d'essai pose deux questions distinctes :

1. **Est-ce rentable ?** Intervalle de confiance bootstrap sur le multiplicateur moyen *après frais* ; la moyenne doit dépasser ×1,00. La médiane est affichée mais ne suffit pas : un objectif de ×1,25 affiche une médiane de ×1,13 alors que la moyenne reste à ×0,93, à cause de pertes rares et lourdes.
2. **Est-ce mieux que le hasard ?** Contrôle par placebo : on tire des milliers de sous-groupes aléatoires de même taille dans la même population, avec la même règle de sortie, et on regarde dans quelle proportion ils font au moins aussi bien. Un filtre qui ne bat pas ses placebos ne capte rien.

Les p-values sont ensuite corrigées par la méthode de Bonferroni pour le nombre d'hypothèses testées (méthode sévère, volontairement : ces idées sont corrélées entre elles), et un sous-groupe de moins de 20 candidats n'est jamais testé. Une hypothèse n'est « démontrée » que si les deux conditions tiennent.

## Tests

```bash
npm test          # 118 tests
npm run check     # contrôle de types + tests
```

Le pipeline complet est testé de bout en bout avec un faux flux, de faux services d'enrichissement et un planificateur manuel (le temps n'avance que quand le test le décide). Les règles de sortie, le barème, le placebo et les statistiques sont testés sur des cas calculés à la main. Les tests ont aussi été vérifiés par mutation : casser volontairement un comportement clé (seuil du barème, limite de positions, correctif des vagues de noms) fait échouer au moins un test.

## Limites assumées

- **Exécution supposée parfaite.** Les simulations achètent et vendent au dernier prix connu, sans latence ni glissement. Un vrai trade ferait moins bien. Les frais sont estimés (2 % aller-retour + frais de priorité), jamais mesurés sur de vrais ordres.
- **Les hypothèses sont testées sur les mêmes 919 candidats**, et plusieurs dizaines de combinaisons ont été explorées avant d'écrire la batterie finale : le nombre réel d'essais est supérieur aux 14 comptés. Une vraie validation exigerait des tokens nouveaux, avec une hypothèse figée à l'avance.
- **Pump.fun seulement**, et prix de la *bonding curve* uniquement : après migration vers un autre marché, le vrai pic peut être plus haut.
- **Fenêtre de suivi courte** (5 à 15 minutes) : les mouvements plus lents ne sont pas vus.
- **Le suivi en cours vit en mémoire.** Si le processus s'arrête avant la fin d'une fenêtre, ce résultat est perdu.
- **Données d'exemple** : les noms de tokens sont saisis librement par leurs créateurs et peuvent contenir n'importe quoi ; ils ont été remplacés par des alias. Deux noms identiques une fois normalisés (casse, espaces) ont le même alias, donc les vagues de copies restent visibles ; la sortie du banc d'essai est identique à celle obtenue avec les noms d'origine.

## Choix de conception

**Pas de trading réel, volontairement.** Le dépôt n'embarque que le courtier papier : aucun wallet, aucune clé privée, aucune transaction. Les mesures ci-dessus montrent que la stratégie perd de l'argent ; y brancher des fonds n'aurait aucun sens. L'interface `Broker` (`src/execution/broker.ts`) reste le point d'extension si un autre cas d'usage le justifie.

**Un barème pur, séparé des appels réseau.** `scoreInputs()` ne fait aucune I/O : c'est ce qui permet de tester chaque seuil du barème. La collecte des signaux (`Scorer`) est isolée et remplaçable.

**Défauts corrigés lors de la mise au propre** : un suivi « vague de noms » écrasait l'historique et le score d'un token déjà suivi (la ligne perdait son prix d'entrée d'origine et ne déclenchait plus de rapport) ; la limite de positions ouvertes pouvait être dépassée si deux candidats étaient évalués en même temps (la place est désormais réservée avant l'achat).

## Avertissement

Ce projet est un outil d'analyse, pas un conseil financier. Les marchés de memecoins sont extrêmement spéculatifs et, d'après les données ci-dessus, aucune des stratégies testées n'y a montré d'avantage.

## Licence

© 2026 Samuel Mateo. Tous droits réservés.

Le code et les données d'exemple sont publiés pour être lus et évalués. Sans accord écrit de l'auteur, ils ne peuvent être ni copiés, ni modifiés, ni redistribués.
