FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json

RUN npm ci --workspace=@deployment-platform/web

COPY apps/web apps/web

RUN npm run build --workspace=@deployment-platform/web


FROM nginx:alpine AS runtime

COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80
