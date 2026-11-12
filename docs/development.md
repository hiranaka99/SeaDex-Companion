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

## Validation

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

To rerun publication, use **Actions → Publish Docker image → Run workflow** with an existing release tag and the prerelease option when appropriate. Publishing an image does not update running containers; users must pull the image and recreate their containers.
