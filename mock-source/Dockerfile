# Mocked OLTP source (dev/simulation only). See mock-source/README.md.
#
# Build from the repo root:
#   docker build -f mock-source/Dockerfile -t aegis-mock-source .
FROM node:24-bookworm-slim

RUN corepack enable
WORKDIR /app

# Manifests first for layer caching. The other workspace package.json files are
# present so the workspace resolves.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY runner/package.json ./runner/
COPY web/package.json ./web/
COPY mock-source/package.json ./mock-source/
RUN pnpm install --filter @aegis/mock-source --frozen-lockfile

COPY mock-source/ ./mock-source/

WORKDIR /app/mock-source
ENV MOCK_PORT=8099 \
    MOCK_DB=/data/mock.db

EXPOSE 8099
CMD ["node", "--import", "tsx", "src/index.ts"]
