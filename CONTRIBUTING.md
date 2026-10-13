# Contributing / Contribuer

## English

Compendlore welcomes proposals to the community-facing repository covered by this file. The project
uses a proprietary source-available model, not an OSI-approved open-source license.

### Before starting

1. Open or reference a request describing the problem and expected observable result.
2. Work in a short-lived branch created from `dev`, target `dev` in the pull request, and use forks
   only as permitted by LICENSE.md.
3. Never commit secrets, credentials, personal data, confidential material, runtime data, generated
   builds, or local configuration.
4. Identify third-party material, its source, and its license. Obtain any necessary employer,
   client, co-author, or other rights-holder authorization.
5. Disclose AI assistance when project policy requires it and review provenance, licensing,
   confidentiality, security, and correctness yourself.
6. Add or update tests and useful repository documentation.
7. Run `npm run ci` before submitting the change. Resolve errors, warnings, deprecated API usage,
   lint findings, and static-analysis findings before requesting integration.
8. Complete and record manual validation when the change has a user-visible or environment-specific
   acceptance path.

### Scope

Contributions here are changes proposed to the official project maintained in this repository. They
are not independent addons merely listed or sold on Compendlore Hub. Independent addon creators
retain their rights and use the separate Hub terms when applicable.

### Review and moderation

Changes are integrated through pull requests. The branch must be current, automated checks must
pass, and at least one maintainer must approve it. Security, licensing, release, Core, and public
contract changes may require two approvals.

Maintainers may accept, reject, edit, revert, or remove a proposal. Proportionate conduct measures
may include a warning, temporary restriction, or permanent exclusion. A temporary restriction caused
by suspected account compromise is a preventive security measure and should be reassessed when
reasonably possible.

### CLA status and recognition

CLA.md is a draft pending legal review. It is not active, no acceptance mechanism has been enabled,
and submission of a pull request does not by itself record acceptance of that draft. Historical
contributions are not automatically covered by a future CLA.

If a legally approved CLA is activated later, acceptance records must identify the signatory,
represented entity where applicable, CLA version, date, scope, and linked contributions.

Accepted contributors are normally listed publicly under their GitHub handle or chosen name after
being informed. A contributor may decline, change, or remove that displayed name. Such removal does
not erase Git history, archives, mirrors, or forks and does not revoke rights already granted.

`dev` is the integration branch. `main` only receives an explicitly validated promotion from `dev`
for a stable release or an approved hotfix.

### Documentation

Repository documentation is English first and French second. Preserve copyright, attribution, and
third-party license notices. Long-form architecture, planning, audits, and cross-repository
decisions belong in the workspace documentation tree.

## Français

Compendlore accueille les propositions destinées au dépôt communautaire concerné par ce fichier. Le
projet utilise un modèle propriétaire à code source accessible, et non une licence open source
approuvée par l’OSI.

### Avant de commencer

1. Ouvrir ou rattacher une demande décrivant le problème et le résultat observable attendu.
2. Travailler dans une branche courte issue de `dev`, cibler `dev` dans la pull request et
   n’utiliser les forks que dans les limites de LICENSE.md.
3. Ne jamais ajouter de secret, identifiant, donnée personnelle, élément confidentiel, donnée
   runtime, build généré ou configuration locale.
4. Identifier les éléments tiers, leur source et leur licence. Obtenir toute autorisation nécessaire
   d’un employeur, client, coauteur ou autre titulaire de droits.
5. Signaler l’assistance par IA lorsque la politique du projet l’exige et vérifier soi-même la
   provenance, les licences, la confidentialité, la sécurité et l’exactitude.
6. Ajouter ou adapter les tests et la documentation utile.
7. Exécuter `npm run ci` avant de proposer le changement. Corriger les erreurs, avertissements,
   usages d’API obsolètes et résultats du lint ou de l’analyse statique avant l’intégration.
8. Effectuer et consigner la validation manuelle lorsqu’un parcours visible ou dépendant de
   l’environnement doit être accepté.

### Périmètre

Les contributions concernent ici les changements proposés au projet officiel maintenu dans ce dépôt.
Elles ne sont pas des addons indépendants simplement référencés ou vendus sur Compendlore Hub. Les
créateurs d’addons indépendants conservent leurs droits et utilisent, le cas échéant, les conditions
distinctes du Hub.

### Revue et modération

Les changements sont intégrés par pull request. La branche doit être à jour, les contrôles
automatiques doivent réussir et au moins un mainteneur doit approuver. Les changements relatifs à la
sécurité, aux licences, aux releases, au Core et aux contrats publics peuvent exiger deux
approbations.

Les mainteneurs peuvent accepter, refuser, modifier, annuler ou retirer une proposition. Des mesures
de conduite proportionnées peuvent comprendre un avertissement, une restriction temporaire ou une
exclusion définitive. Une restriction temporaire liée à une suspicion de compromission de compte
constitue une mesure préventive de sécurité et doit être réévaluée lorsque cela est raisonnablement
possible.

### Statut du CLA et reconnaissance

CLA.md est un projet soumis à validation juridique. Il n’est pas actif, aucun mécanisme
d’acceptation n’a été activé et le dépôt d’une pull request n’enregistre pas, à lui seul,
l’acceptation de ce projet. Les contributions historiques ne sont pas automatiquement couvertes par
un futur CLA.

Si un CLA juridiquement validé est activé à l’avenir, les enregistrements d’acceptation doivent
identifier le signataire, l’entité représentée le cas échéant, la version du CLA, la date, le
périmètre et les contributions rattachées.

Les contributeurs acceptés sont normalement inscrits publiquement sous leur pseudonyme GitHub ou
leur nom choisi, après en avoir été informés. Un contributeur peut refuser, modifier ou retirer ce
nom affiché. Ce retrait n’efface pas les historiques Git, archives, miroirs ou forks et ne révoque
pas les droits déjà concédés.

`dev` est la branche d’intégration. `main` reçoit uniquement une promotion explicitement validée
depuis `dev` pour une version stable ou un correctif urgent approuvé.

### Documentation

La documentation du dépôt présente l’anglais avant le français. Les mentions de droit d’auteur,
d’attribution et de licences tierces doivent être conservées. L’architecture longue, la
planification, les audits et les décisions inter-dépôts appartiennent à l’arborescence documentaire
du workspace.

En cas de divergence entre les versions linguistiques de règles contractuelles, la version française
prévaut, sous réserve des règles impératives applicables.
