# Development and releases

This guide covers source builds, local development, testing, and release publication. For installation and everyday use, see the [README](../README.md).

## Run from source

Requires **Node.js 26+**.

```bash
npm ci
npm --prefix frontend ci
npm start
```

`npm start` builds the server and frontend, then starts SeaDex Companion at [http://localhost:8080](http://localhost:8080).

The repository's `docker-compose.yml` builds from the current source:

```bash
docker compose up -d --build
```

The published-image Compose example in the README is for users who do not need a source build.

## Local development

Start the backend and frontend together:

```bash
npm run dev
```

Open the Vite URL printed in the terminal, normally [http://localhost:5173](http://localhost:5173). Frontend edits update automatically, and backend edits restart the API server. Vite proxies `/api` requests to the backend on port `8080`; opening port `8080` directly serves the last compiled frontend without live updates. Press Ctrl+C to stop both servers.

To run either server separately, use `npm run dev:server` or `npm run dev:frontend`.

## Formatting

Source code is formatted with [Prettier](https://prettier.io) using the repository's `.prettierrc.json`. Run `npm run format` before committing, or `npm run format:check` to verify without writing. Documentation, JSON, and YAML files are not formatted.

## Linting

Source code is linted with [Oxlint](https://oxc.rs/docs/guide/usage/linter) using the repository's `.oxlintrc.json`. Run `npm run lint` to check the server, shared code, tests, scripts, and frontend, or `npm run lint:fix` to apply safe automatic fixes. Warnings and suppression comments that no longer suppress anything fail the check.

The configuration enables the `correctness` category with the TypeScript, Unicorn, Oxc, import, Node.js, and promise plugins, plus the React and JSX accessibility plugins for the frontend. On top of that it enables `no-empty`, `import/no-duplicates`, `typescript/no-explicit-any`, and the type-aware `no-floating-promises`, `no-misused-promises`, and `no-unnecessary-type-assertion` rules.

Linting runs in type-aware mode (`--type-aware`), which uses the `oxlint-tsgolint` dev dependency and the TypeScript compiler to check rules that need type information. ESLint is not used. Pass an async function to an event handler or callback that expects a void return as `() => void handler()`, so it is clear the promise is deliberately not awaited. Floating promises, unbound methods, and sort comparators are not checked in `tests/`, where `node:test` registers tests without awaiting them and sorting only puts values in a fixed order for comparison.

Rules that conflict with deliberate patterns in this codebase are switched off in the configuration with the reason next to each. Suppress a single finding with `// oxlint-disable-next-line <rule> -- <reason>` only when the code is intentional, and always give the reason.

## Validation

- `npm run format:check` checks the source formatting with Prettier.
- `npm run lint` checks the source with Oxlint.
- `npm run typecheck` type-checks the server, the tests, and the frontend.
- `npm test` builds the server and runs backend, HTTP, scheduling, and frontend utility regressions.
- `npm run build` builds the server and frontend for production.
- `npm run test:browser` builds the frontend and checks browser workflows with isolated local fixtures. It defaults to Microsoft Edge on Windows; set `BROWSER_PATH` to a Chromium executable on other systems.
- `npm run test:docker` builds a fresh image and checks startup, health, assets, authentication, persistence, download recovery, and shutdown in an isolated container.

Tests that look up hashes, search Prowlarr or sweep build their own Usenet runtime with `testUsenetRuntime` from `tests/support/usenet-runtime.ts`, and hand it their fake hash indexers and Prowlarr as its `fetch`. The global `fetch` fakes only the download clients and other services. `restart()` simulates a new process on the same data paths, and `fresh()` one on empty data paths.

Tests that assess a season import `assessSeason` from `tests/support/assessment.ts`. It fails any result that breaks a listing rule from `tests/support/listing-invariants.ts`: a torrent file selected for two parts, or one release listed twice in a part.

### Replaying SeaDex entries

When a title's releases look wrong (listed twice, scoped to the wrong episodes, the wrong target), replay its real SeaDex entries before reading code:

```sh
npm run replay:seadex -- --alid 131518,162670 --episodes 11,11 --season 3 --own sam
```

It fetches the entries from seadex.moe (one AniList ID per part, in order) and assesses them for a one-title library that holds every episode of the season. It then prints each part's releases with the episodes they select, and lists any broken listing rule with exit code 1. Run it with `--help` for every option. `--save <file>` keeps the fetched entries, and `--from <file>` replays them offline. To turn a case into a regression test, save the entries under `tests/fixtures/seadex/` and call `replayCatalog` from `tests/support/seadex-replay.ts`, as `tests/seadex-replay.test.ts` does.

See [maintainability notes](maintainability.md) for runtime ownership, persistence, and compatibility details.

## Dependency updates

[Dependabot](https://docs.github.com/code-security/dependabot) is configured in [`.github/dependabot.yml`](../.github/dependabot.yml). Every Monday it checks for new versions and opens pull requests, which run CI like any other pull request:

- **npm** (`/` and `/frontend`): minor and patch updates are grouped into one pull request per directory for production packages and one for development packages. Each major update gets its own pull request. Releases younger than 3 days (7 for majors) are skipped, which gives the registry time to catch broken or compromised publishes. `@types/node` majors are ignored because they follow the Node.js runtime.
- **GitHub Actions**: all action updates arrive in one pull request, with the pinned SHA and its version comment updated together.
- **Docker**: proposes a new `node:<major>-alpine` base image. Patch and minor Node.js releases already arrive on every image build. A Node.js major update also needs `node-version` in both workflows, `engines` in `package.json`, and `@types/node` changed in the same pull request. Close pull requests for odd-numbered, non-LTS majors; Dependabot then ignores that version.

Dependabot security updates are separate from this schedule. They open a pull request as soon as an advisory affects a locked version, with no cooldown.

A production package update in the root `package-lock.json` changes the container runtime, so the next release needs a new image instead of an in-app update (see [In-app update package](#in-app-update-package)). Batch these updates into one release where possible. Frontend packages and development packages do not affect the runtime.

To control Dependabot from a pull request, comment `@dependabot rebase`, `@dependabot recreate`, `@dependabot ignore this major version`, or `@dependabot ignore this dependency`.

## Publishing a release

The [Publish Docker image workflow](../.github/workflows/docker-release.yml) builds and pushes Linux amd64 and arm64 images when a GitHub release is published.

Configure these repository secrets under **Settings → Secrets and variables → Actions**:

- `DOCKERHUB_USERNAME`: the Docker Hub account with push access to `hiranaka/seadex-companion`.
- `DOCKERHUB_TOKEN`: a Docker Hub access token with write permission for that repository.

Before publishing:

1. Update `package.json` and `frontend/package.json`, including the root package versions in both lockfiles. The UI reads its installed version from `frontend/package.json`.
2. Write release notes in `docs/releases/v<version>.md`.
3. Run the relevant validation commands above and review the changes.
4. Commit the changes and push the commit and matching version tag, such as `v2.6.1`.
5. Publish the GitHub release using that tag and the release notes, then verify the Docker publishing workflow completes successfully.

The release tag must match both package versions. A stable release such as `v2.6.1` publishes `:2.6.1`, `:2.6`, and `:latest`; prereleases publish only their full version tag. The workflow validates the package versions, runs the linter and the server tests, and builds the production Dockerfile before pushing images.

To rerun publication, use **Actions → Publish Docker image → Run workflow** with an existing release tag and the prerelease option when appropriate. Publishing an image does not update running containers. Users either install the release in-app or pull the image and recreate their containers.

### In-app update package

After the images are pushed, the workflow attaches two assets to the GitHub release with the built-in `GITHUB_TOKEN` (the job has `contents: write`; no extra secret is needed):

- `seadex-companion-app-<version>.tar.gz`: the compiled server and frontend.
- `seadex-companion-update.json`: the package's size and SHA-256, and the container runtime it needs.

Running installations read the manifest from the latest release. They offer **Install and restart** only when the runtime matches the image they run. Otherwise they warn that a new Docker image is required and list what changed. The runtime covers:

- the `Dockerfile` and `docker-entrypoint.sh`, including the Node.js version and system packages;
- `server/launcher.ts`;
- every production package version in `package-lock.json`.

A change to any of these makes the release an image-only update for every existing installation. Group such changes into one release where possible, and say so in its release notes. A release without the manifest, for example while the workflow is still running, is also reported as needing a new image; installations check again within five minutes.

To build and inspect the package locally:

```bash
npm run build
node scripts/release-bundle.mjs bundle release-assets
```

The first release that contains the launcher must be installed by pulling the image, because older images cannot install updates in-app.
