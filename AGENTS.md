# Repository guidance

## README audience

- Keep `README.md` focused on people installing, configuring, using, updating, and backing up SeaDex Companion.
- Never add developer-only or maintainer-only information to the README. This includes CI or GitHub Actions setup, repository secrets, registry publishing credentials, release publishing procedures, development servers, source-build or test commands, and internal implementation details.
- Put development and release instructions in `docs/development.md`, and other technical details in an appropriate document under `docs/`.
- Keep installation commands, service connection guidance, persistent-volume instructions, and operational security advice in the README when users need them to run the application.
- When documenting a feature or release in the README, explain user-visible behavior and required user actions. Keep implementation notes, test results, and release engineering elsewhere.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for `hiranaka99/SeaDex-Companion` (via `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the five default triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Replaying SeaDex entries

When a title's releases, scoping, or targets look wrong, or when a change touches season assessment or target picking, replay real SeaDex entries with `npm run replay:seadex` and read its listing. See `docs/development.md`.

### Running tests

Run test files by name with `npm test -- <name>`: it builds first and gives the tests a temporary `DATA_DIR`, away from live data. See `docs/development.md`.
