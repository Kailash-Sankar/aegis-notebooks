# Aegis runner container (ADR 0003).
#
# This is the security boundary for model-generated shell commands. The
# container runs the runner AND the Pi agent (MVP phase 1: one container for
# the whole app). It mounts ONLY the workspaces directory -- never the host
# ~/.pi/agent and never the Docker socket.
#
# Build from the repo root:
#   docker build -f runner/Dockerfile -t aegis-runner .
#
# Run (from the repo root):
#   docker run --rm \
#     --read-only --tmpfs /tmp -e HOME=/tmp \
#     --pids-limit 512 --memory 2g --cpus 2 \
#     -e ANTHROPIC_API_KEY \
#     -e WORKSPACES_ROOT=/workspaces \
#     -v "$PWD/workspaces:/workspaces" \
#     -p 8787:8787 \
#     aegis-runner

FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     bash ca-certificates curl git ripgrep unzip jq \
  && rm -rf /var/lib/apt/lists/*

# DuckDB CLI used by the agent via bash and by the duckdb_query tool.
# Pin a version for reproducibility in real deployments.
RUN curl -fsSL https://install.duckdb.org | sh \
  && ln -s /root/.duckdb/cli/latest/duckdb /usr/local/bin/duckdb

# pnpm via corepack (version pinned by the root packageManager field).
RUN corepack enable
WORKDIR /app

# Manifests first for layer caching. web/package.json is present so the
# workspace resolves, but only the runner's deps are installed.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY runner/package.json ./runner/
COPY web/package.json ./web/
RUN pnpm install --filter @aegis/runner --frozen-lockfile

COPY runner/ ./runner/

WORKDIR /app/runner
ENV WORKSPACES_ROOT=/workspaces \
    PORT=8787 \
    NODE_ENV=production

EXPOSE 8787
# Run tsx directly (no pnpm/corepack at runtime), so the container works with a
# read-only root filesystem and a noexec-able tmpfs HOME.
CMD ["node", "--import", "tsx", "src/index.ts"]
