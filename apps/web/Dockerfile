FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json

RUN npm ci --workspace=@deployment-platform/web

COPY apps/web apps/web

# The deployed image version (e.g. "0.1.141") and the git commit it was built
# from, passed by the release/installer build paths and baked into the bundle
# so the Updates screen can show both. APP_VERSION is a per-box counter;
# SOURCE_COMMIT is comparable across installs. Defaults suit a plain build.
ARG APP_VERSION=dev
ARG SOURCE_COMMIT=unknown
ENV VITE_APP_VERSION=$APP_VERSION
ENV VITE_APP_COMMIT=$SOURCE_COMMIT

RUN npm run build --workspace=@deployment-platform/web


FROM nginx:alpine AS runtime

COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80
