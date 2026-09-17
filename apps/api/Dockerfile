FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json

RUN npm ci --workspace=@deployment-platform/api

COPY apps/api apps/api

RUN npm run build --workspace=@deployment-platform/api


FROM node:24-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

# The canonical, single-source release version and source commit — the same
# values baked into the web bundle (see apps/web/Dockerfile) so `GET /` and
# the web "Updates" panel always agree on what's actually running. Neither
# is ever hardcoded in source; both default to "dev" for a local build with
# no release pipeline behind it.
ARG APP_VERSION=dev
ARG SOURCE_COMMIT=unknown
ENV APP_VERSION=$APP_VERSION
ENV SOURCE_COMMIT=$SOURCE_COMMIT

# git is required at runtime: github-deploy-service.ts shells out to it
# (via process-runner.ts) to clone a GitHub source repository before
# building it. ca-certificates is required for that clone to work over
# HTTPS. Nothing else is installed — keep this image minimal.
RUN apk add --no-cache git ca-certificates

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json

RUN npm ci \
  --omit=dev \
  --workspace=@deployment-platform/api \
  && npm cache clean --force

COPY --from=build /app/apps/api/dist apps/api/dist

# The trusted release-signing public keys — the trust anchor for the
# self-update system (see apps/api/src/services/trusted-keys.ts, which loads
# them from /app/trusted-keys). Public keys only; never private-key material.
# An empty/absent directory means "trust nothing" (fail closed), which is the
# correct state until a signing key is provisioned.
COPY installer/trusted-keys ./trusted-keys

# The migration SOURCE files (tiny .ts), so the host updater can hand
# release-remote.sh's from-source migration-verification step the exact
# migration list this image ships — without the host needing any source
# checkout. The updater `docker cp`s these out of the running container into
# the minimal release directory it builds for a registry-mode deploy. These
# are read as text (parsed for version/name), never executed at runtime.
COPY apps/api/src/migrations ./apps/api/src/migrations

EXPOSE 3001

CMD ["node", "apps/api/dist/server.js"]
