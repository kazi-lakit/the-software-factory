# Root Dockerfile for Blocks Release.
# The build context MUST be the repo root: board-ui imports ../core/src
# (Vite alias `@factory/core` -> ../core/src/browser.ts), so core/ has to be
# inside the build context alongside board-ui/.
FROM node:24-alpine AS builder

WORKDIR /app

# Dependency manifests first so the npm ci layers cache.
COPY core/package*.json ./core/
COPY board-ui/package*.json ./board-ui/
RUN cd core && npm ci
RUN cd board-ui && npm ci

COPY core ./core
COPY board-ui ./board-ui

ARG ci_build=dev
ARG VITE_BLOCKS_API_URL
ARG VITE_BLOCKS_PROJECT_KEY
ARG VITE_BLOCKS_X_BLOCKS_KEY
ARG VITE_BLOCKS_APP_DOMAIN
ARG VITE_BLOCKS_OIDC_URL=https://iam.seliseblocks.com
ARG VITE_BLOCKS_OIDC_CLIENT_ID
ARG VITE_BLOCKS_OIDC_SCOPE="openid profile"
ARG VITE_BLOCKS_REDIRECT_URI
ARG VITE_BLOCKS_HOSTED_LOGIN=true

ENV VITE_BLOCKS_API_URL=${VITE_BLOCKS_API_URL}
ENV VITE_BLOCKS_PROJECT_KEY=${VITE_BLOCKS_PROJECT_KEY}
ENV VITE_BLOCKS_X_BLOCKS_KEY=${VITE_BLOCKS_X_BLOCKS_KEY}
ENV VITE_BLOCKS_APP_DOMAIN=${VITE_BLOCKS_APP_DOMAIN}
ENV VITE_BLOCKS_OIDC_URL=${VITE_BLOCKS_OIDC_URL}
ENV VITE_BLOCKS_OIDC_CLIENT_ID=${VITE_BLOCKS_OIDC_CLIENT_ID}
ENV VITE_BLOCKS_OIDC_SCOPE=${VITE_BLOCKS_OIDC_SCOPE}
ENV VITE_BLOCKS_REDIRECT_URI=${VITE_BLOCKS_REDIRECT_URI}
ENV VITE_BLOCKS_HOSTED_LOGIN=${VITE_BLOCKS_HOSTED_LOGIN}

WORKDIR /app/board-ui
RUN NODE_OPTIONS="--max-old-space-size=4096" npx vite build --mode "${ci_build}" \
  && node scripts/write-release-env.mjs "${ci_build}"

FROM nginxinc/nginx-unprivileged:1.29-alpine

COPY --from=builder /app/board-ui/dist /usr/share/nginx/html
COPY board-ui/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080
