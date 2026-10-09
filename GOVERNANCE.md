# Governance / Gouvernance

## English

### Roles

- **Founder:** safeguards the project mission, appoints maintainers, resolves exceptional governance
  disputes, and authorizes official releases.
- **Maintainers:** review changes, protect security and compatibility, moderate project spaces, and
  integrate accepted contributions.
- **Contributors:** propose documented, tested changes that respect project policies.

Named owners and maintainers are managed through the GitHub organization and its protected teams.
Repository ownership rules must identify the relevant maintainer team before public contributions
open.

### Decisions and reviews

Normal changes require a pull request, successful automated checks, resolved review discussions, and
at least one maintainer approval. Security, authentication, licensing, releases, Core behavior, and
public contracts require two qualified approvals when the organization has enough maintainers.

Architectural decisions with long-term compatibility impact must be recorded before implementation.
The founder may make a temporary decision when an urgent security or operational issue prevents the
normal process; the decision must then be documented and reviewed.

### Official versions

An official version must originate from the protected `main` branch, use an immutable version tag,
include its changelog and release metadata, and provide verifiable provenance. Stable releases must
be signed when the signing infrastructure is available. Published artifacts must never be replaced
in place.

Forks and local builds remain permitted by the project license but are not official Compendlore
releases and must follow `TRADEMARK.md`.

### Policy changes

Changes to governance, licensing, the code of conduct, or trademark rules require an explicit pull
request and founder approval. Their effect must be stated clearly and may not be applied
retroactively to already accepted contributions or published versions unless legally required.

## Français

### Rôles

- **Fondateur :** protège la mission du projet, désigne les mainteneurs, tranche les conflits de
  gouvernance exceptionnels et autorise les versions officielles.
- **Mainteneurs :** examinent les changements, protègent la sécurité et la compatibilité, modèrent
  les espaces du projet et intègrent les contributions acceptées.
- **Contributeurs :** proposent des changements documentés et testés qui respectent les politiques
  du projet.

Les propriétaires et mainteneurs nominatifs sont gérés dans l’organisation GitHub et ses équipes
protégées. Les règles de propriété du dépôt doivent désigner l’équipe de maintenance concernée avant
l’ouverture des contributions publiques.

### Décisions et revues

Un changement normal exige une pull request, des contrôles automatisés réussis, la résolution des
discussions de revue et au moins une validation de mainteneur. La sécurité, l’authentification, la
licence, les releases, le comportement du Core et les contrats publics exigent deux validations
qualifiées dès que l’organisation dispose de suffisamment de mainteneurs.

Les décisions d’architecture ayant un impact durable sur la compatibilité doivent être consignées
avant leur implémentation. Le fondateur peut prendre une décision temporaire lorsqu’un problème
urgent de sécurité ou d’exploitation empêche le processus normal ; la décision doit ensuite être
documentée et revue.

### Versions officielles

Une version officielle doit provenir de la branche protégée `main`, utiliser un tag de version
immuable, inclure son changelog et ses métadonnées de release, et fournir une provenance vérifiable.
Les versions stables doivent être signées lorsque l’infrastructure de signature est disponible. Un
artefact publié ne doit jamais être remplacé sur place.

Les forks et builds locaux restent autorisés par la licence du projet, mais ne constituent pas des
versions officielles de Compendlore et doivent respecter `TRADEMARK.md`.

### Modification des politiques

Toute modification de la gouvernance, de la licence, du code de conduite ou des règles de marque
exige une pull request explicite et l’approbation du fondateur. Son effet doit être clairement
décrit et ne peut pas être appliqué rétroactivement aux contributions déjà acceptées ou aux versions
déjà publiées, sauf obligation légale.
