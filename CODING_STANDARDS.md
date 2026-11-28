# Coding standards

Rules a reviewer applies to a diff. Formatting, lint and types are enforced by `npm run format:check`, `npm run lint` and `npm run typecheck`; these are the judgement calls no check can make. Apply every rule to every hunk.

## Documentation stays true

`docs/maintainability.md` records how the code is put together and why. A change that makes any of its statements false updates that statement in the same change, and a new mechanism the doc's sections would cover gets its paragraph there. Do the same for `docs/development.md` when a command, test helper or listing rule changes, and for `README.md` when user-visible behaviour changes (within the audience rules in `AGENTS.md`).

## One eligibility policy

Whether a release is owned, settles its part, is offered, is wanted, or may be downloaded at all is answered by the predicates in `shared/download-plan.ts` (`releaseOwned`, `releaseSatisfies`, `releaseOffered`, `wantedParts`, `releaseForbidden`, `unwantedReason`). Server, frontend, scripts and tests call those predicates. A new answer becomes a new predicate there; a field test such as `release.excluded_kind === …` written at the call site is a second policy.

## Domain vocabulary

Names of types, functions, variables and tests, and interface copy, use the terms in `GLOSSARY.md` with their glossary meaning, and leave out its _Avoid_ terms ("cour" only as a part's label). A new domain concept gets a glossary entry in the same change.
