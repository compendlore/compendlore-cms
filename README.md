# compendlore-cms

## English

Compendlore CMS foundation: Core, CMS Registry, versioned API, public site, and separately delivered
administration interface. `backend/` is the Encore application root. Protected infrastructure is
owned by the Core; native business modules and future addons contribute through the Registry.

### Status

The Core, Registry, declarative schema engine, API gateway, external connectors, Security Kernel,
and frontend foundation are operational. Historical modules are not imported without an explicit
audit. Architecture and planning documents are maintained in the workspace documentation tree.

### Commands

- `npm run dev:backend`: start Encore on port 4000;
- `npm run dev:site`: serve the public site and administration through port 5173;
- `npm run check:backend`: validate the Encore application graph;
- `npm run pretty`: format the repository;
- `npm run lint`: check code and repository documentation;
- `npm run typecheck`: run strict TypeScript checks;
- `npm run test`: build and execute tests;
- `npm run build`: produce a non-versioned local build;
- `npm run ci`: run the complete integration checks.

Local builds, artifacts, secrets, runtime data, and workspace documentation are excluded from this
repository. In development, `/` serves the public site and `/admin` serves the protected interface
from one Vite server. Production bundles remain separate.

### Docker

The `Dockerfile` provides `site`, `administration`, and `quality` targets. The Encore backend image
is produced with the official `encore build docker` workflow. Workspace orchestration and local
environment generation are managed from the workspace root.

## Français

Socle du CMS Compendlore : Core, CMS Registry, API et interfaces séparées.

Le dossier `backend/` est la racine de l'application Encore. `core`, `cms-registry` et `api` sont
des services Encore distincts ; le Core possède les accès aux infrastructures protégées.

### Statut

Core, CMS Registry, moteur déclaratif de schéma, passerelle API, connecteurs externes et fondation
frontend opérationnels. Aucun module historique non audité ni aucune logique métier ne sont
présents. La documentation d’architecture et de planification est maintenue dans l’arborescence
documentaire du workspace.

### Commandes

- `npm run dev:backend` : démarre Encore.ts sur le port 4000 ;
- `npm run dev:site` : démarre le site et l'administration sur le port 5173 ;
- `npm run dev:administration` : alias du serveur frontend unique ;
- `npm run check:backend` : analyse le graphe de l'application Encore.ts ;
- `npm run pretty` : formate le dépôt ;
- `npm run lint` : vérifie le code et la documentation ;
- `npm run typecheck` : vérifie TypeScript en mode strict ;
- `npm run test` : construit et exécute les tests ;
- `npm run build` : produit un build local non versionné ;
- `npm run bundles:check` : vérifie la séparation et la sûreté des bundles frontend ;
- `npm run ci` : exécute tous les contrôles d'intégration.

Les builds locaux, artefacts, secrets et données runtime sont exclus de Git.

En développement, un seul serveur Vite est lancé. Le site est disponible sur `/` et l'administration
sur `/admin`, tous deux via le port 5173. Les applications conservent néanmoins des points d'entrée
et des builds de production distincts.

### Docker

Le `Dockerfile` fournit trois cibles : `site`, `administration` et `quality`. Le backend Encore
n'utilise pas un Dockerfile artisanal : son image est produite par la commande officielle
`encore build docker` avec `docker/encore-infra.docker.json`.

L'orchestration complète reste définie par le fichier `compose.yaml` placé à la racine du workspace.
Les fichiers `.env` locaux sont générés depuis les exemples avec `make env` et ne doivent jamais
être versionnés.
