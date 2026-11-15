# Margin web app as a static site behind nginx (spec §11 "Deployment", phase 6).
#   docker build -t margin .
#   docker run --rm -p 8080:8080 margin
# Pin the base images by digest (image@sha256:…) for reproducible deployments.
ARG NODE_IMAGE=node:22-alpine
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:stable-alpine

FROM ${NODE_IMAGE} AS build
# AGPL-3.0 §13: link shown to users of the hosted app; point it at the source you deploy.
ARG SOURCE_URL=
ENV VITE_SOURCE_URL=${SOURCE_URL}
WORKDIR /src
RUN corepack enable
# Dependencies first, so the layer is reused while only sources change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY packages/bridge/package.json packages/bridge/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json tsconfig.json ./
COPY schema schema
COPY fonts fonts
COPY packages packages
RUN pnpm install --frozen-lockfile --offline && pnpm --filter @margin/web build

# Only the built files, for serving them from your own web server (no container at runtime):
#   docker build --target static --output type=local,dest=/srv/margin/www .
FROM scratch AS static
COPY --from=build /src/packages/web/dist /

FROM ${NGINX_IMAGE}
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/margin.conf deploy/security-headers.conf /etc/nginx/margin/
COPY --from=build /src/packages/web/dist /usr/share/nginx/html
EXPOSE 8080
