FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/irc-bot/package.json apps/irc-bot/package.json

RUN npm ci --workspace=@deployment-platform/irc-bot

COPY apps/irc-bot apps/irc-bot

RUN npm run build --workspace=@deployment-platform/irc-bot


FROM node:24-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY apps/irc-bot/package.json apps/irc-bot/package.json

RUN npm ci \
  --omit=dev \
  --workspace=@deployment-platform/irc-bot \
  && npm cache clean --force

COPY --from=build /app/apps/irc-bot/dist apps/irc-bot/dist

CMD ["node", "apps/irc-bot/dist/index.js"]
