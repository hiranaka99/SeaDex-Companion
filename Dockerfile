# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: Build the React + TypeScript frontend (Vite)
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
# Stage 2: Runtime — Flask backend + the compiled frontend
# ---------------------------------------------------------------------------
FROM python:3.11-slim

WORKDIR /app

# Install Python dependencies first for better layer caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application code
COPY app.py .

# Bring in the frontend bundle produced by stage 1
COPY --from=frontend /app/static ./static

# Config + cache live in /app/data (mount a volume here to persist)
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data

EXPOSE 8080

CMD ["python", "app.py"]