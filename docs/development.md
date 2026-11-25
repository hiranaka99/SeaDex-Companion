# Development and releases

This guide covers source builds, local development, testing, and release publication. For installation and everyday use, see the [README](../README.md).

## Run from source

Requires **Node.js 24+**.

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

## Validation

- `npm run typecheck` type-checks the server, the tests, and the frontend.
- `npm test` builds the server and runs backend, HTTP, scheduling, and frontend utility regressions.
- `npm run build` builds the server and frontend for production.
- `npm run test:browser` builds the frontend and checks browser workflows with isolated local fixtures. It defaults to Microsoft Edge on Windows; set `BROWSER_PATH` to a Chromium executable on other systems.
- `npm run test:docker` builds a fresh image and checks startup, health, assets, authentication, persistence, download recovery, and shutdown in an isolated container.

See [maintainability notes](maintainability.md) for runtime ownership, persistence, and compatibility details.

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

The release tag must match both package versions. A stable release such as `v2.6.1` publishes `:2.6.1`, `:2.6`, and `:latest`; prereleases publish only their full version tag. The workflow validates the package versions, runs the server tests, and builds the production Dockerfile before pushing images.

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
