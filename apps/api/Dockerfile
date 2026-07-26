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

EXPOSE 3001

CMD ["node", "apps/api/dist/server.js"]
