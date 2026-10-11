# compendlore-cms

Socle du CMS Compendlore : Core, CMS Registry, API et interfaces séparées.

Le dossier `backend/` est la racine de l'application Encore. `core`, `cms-registry` et `api` sont
des services Encore distincts ; le Core possède les accès aux infrastructures protégées.

## Statut

Core, CMS Registry, moteur déclaratif de schéma, passerelle API, connecteurs externes et fondation
frontend opérationnels. Aucun module historique non audité ni aucune logique métier ne sont
présents.

Le contrat, la configuration et les limites du Core sont documentés dans
[`docs/CORE.md`](docs/CORE.md).

Le modèle déclaratif, le cycle de vie et la frontière du Registry sont documentés dans
[`docs/CMS_REGISTRY.md`](docs/CMS_REGISTRY.md).

Le DSL de tables, la planification et les garanties d'exécution sont documentés dans
[`docs/SCHEMA_ENGINE.md`](docs/SCHEMA_ENGINE.md).

Les audiences, contrats, contrôles et communications sont documentés dans
[`docs/API_GATEWAY.md`](docs/API_GATEWAY.md).

Les contrats sortants, flux OAuth et règles réseau sont documentés dans
[`docs/CONNECTORS.md`](docs/CONNECTORS.md).

Le design system, les shells séparés et la livraison administrative sont documentés dans
[`docs/FRONTEND_FOUNDATION.md`](docs/FRONTEND_FOUNDATION.md).

La stack cible React, Encore.ts, Sass/SCSS et TypeScript 6 est définie dans
[`docs/TECHNOLOGY_STACK.md`](docs/TECHNOLOGY_STACK.md).

## Commandes

- `npm run dev:backend` : démarre Encore.ts sur le port 4000 ;
- `npm run dev:site` : démarre le point d'entrée frontend sur le port 5173 ;
- `npm run dev:administration` : démarre l'administration interne sur `127.0.0.1:5174` ;
- `npm run check:backend` : analyse le graphe de l'application Encore.ts ;
- `npm run pretty` : formate le dépôt ;
- `npm run lint` : vérifie le code et la documentation ;
- `npm run typecheck` : vérifie TypeScript en mode strict ;
- `npm run test` : construit et exécute les tests ;
- `npm run build` : produit un build local non versionné ;
- `npm run bundles:check` : vérifie la séparation et la sûreté des bundles frontend ;
- `npm run ci` : exécute tous les contrôles d'intégration.

Les builds locaux, artefacts, secrets et données runtime sont exclus de Git.

En développement, le navigateur utilise une seule origine : le site est disponible sur `/` et
l'administration sur `/admin`, tous deux via le port 5173. Le port 5174 est exclusivement un détail
interne du relais Vite et n'est pas exposé sur le réseau.

## Docker

Le `Dockerfile` fournit trois cibles : `site`, `administration` et `quality`. Le backend Encore
n'utilise pas un Dockerfile artisanal : son image est produite par la commande officielle
`encore build docker` avec `docker/encore-infra.docker.json`.

L'orchestration complète reste définie par le fichier `compose.yaml` placé à la racine du workspace.
Les fichiers `.env` locaux sont générés depuis les exemples avec `make env` et ne doivent jamais
être versionnés.
