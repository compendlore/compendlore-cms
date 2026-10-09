# compendlore-cms

Socle du CMS Compendlore : Core, CMS Registry, API et interfaces séparées.

Le dossier `backend/` est la racine de l'application Encore. `core`, `cms-registry` et `api` sont
des services Encore distincts ; le Core possède les accès aux infrastructures protégées.

## Statut

Core minimal de phase 3. Aucun module historique non audité ni aucune logique métier ne sont
présents.

Le contrat, la configuration et les limites du Core sont documentés dans
[`docs/CORE.md`](docs/CORE.md).

La stack cible React, Encore.ts, Sass/SCSS et TypeScript 6 est définie dans
[`docs/TECHNOLOGY_STACK.md`](docs/TECHNOLOGY_STACK.md).

## Commandes

- `npm run dev:backend` : démarre Encore.ts sur le port 4000 ;
- `npm run dev:site` : démarre l'application React publique sur le port 5173 ;
- `npm run dev:administration` : démarre l'administration React sur le port 5174 ;
- `npm run check:backend` : analyse le graphe de l'application Encore.ts ;
- `npm run pretty` : formate le dépôt ;
- `npm run lint` : vérifie le code et la documentation ;
- `npm run typecheck` : vérifie TypeScript en mode strict ;
- `npm run test` : construit et exécute les tests ;
- `npm run build` : produit un build local non versionné ;
- `npm run ci` : exécute tous les contrôles d'intégration.

Les builds locaux, artefacts, secrets et données runtime sont exclus de Git.
