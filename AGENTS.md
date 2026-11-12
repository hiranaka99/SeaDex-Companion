# Repository guidance

## README audience

- Keep `README.md` focused on people installing, configuring, using, updating, and backing up SeaDex Companion.
- Never add developer-only or maintainer-only information to the README. This includes CI or GitHub Actions setup, repository secrets, registry publishing credentials, release publishing procedures, development servers, source-build or test commands, and internal implementation details.
- Put development and release instructions in `docs/development.md`, and other technical details in an appropriate document under `docs/`.
- Keep installation commands, service connection guidance, persistent-volume instructions, and operational security advice in the README when users need them to run the application.
- When documenting a feature or release in the README, explain user-visible behavior and required user actions. Keep implementation notes, test results, and release engineering elsewhere.
