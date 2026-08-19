# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: Build the TypeScript backend
# ---------------------------------------------------------------------------
FROM node:22-alpine AS backend

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY server/ ./server/
RUN npm run build:server

# ---------------------------------------------------------------------------
# Stage 2: Build the React + TypeScript frontend (Vite)
# ---------------------------------------------------------------------------
FROM node:22-alpine AS frontend

WORKDIR /app/frontend

# Install dependencies first (separate layer for better caching).
# npm ci uses package-lock.json for a reproducible install and includes
# devDependencies (needed for the `tsc --noEmit` type-check in the build).
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

# Copy the frontend source and build the production bundle.
# vite.config.ts sets outDir to "../static" (emptyOutDir: true), so the
# compiled app lands in /app/static inside this stage.
COPY frontend/ ./
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 3: Runtime — Node.js backend + the compiled frontend
# ---------------------------------------------------------------------------
FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY --from=backend /app/dist ./dist
COPY --from=frontend /app/static ./static

# Config + cache live in /app/data (mount a volume here to persist)
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data

EXPOSE 8080

CMD ["node", "dist/server/index.js"]
