FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS web-deps
WORKDIR /app
COPY plugins/web-ui/package.json plugins/web-ui/package-lock.json ./
RUN npm ci --omit=dev --fetch-retries=2 --fetch-retry-mintimeout=1000 --fetch-retry-maxtimeout=10000 --fetch-timeout=30000

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS build
WORKDIR /app
ARG WEB_UI_BASE=/
ENV WEB_UI_BASE=$WEB_UI_BASE
COPY --from=web-deps /root/.npm /root/.npm
COPY plugins/web-ui/package.json plugins/web-ui/package-lock.json ./
RUN npm ci --ignore-scripts --prefer-offline --fetch-retries=2 --fetch-retry-mintimeout=1000 --fetch-retry-maxtimeout=10000 --fetch-timeout=30000 \
  && for attempt in 1 2 3; do \
    node node_modules/esbuild/install.js && break; \
    [ "$attempt" -eq 3 ] && exit 1; \
    sleep 1; \
  done
COPY plugins/web-ui/index.html plugins/web-ui/shared.html plugins/web-ui/vite.config.ts plugins/web-ui/tsconfig.json ./
COPY plugins/web-ui/public ./public
COPY plugins/web-ui/src ./src
COPY plugins/chassis/src /chassis/src
COPY docs/images/slack-app-config-token-setup.gif /docs/images/slack-app-config-token-setup.gif
RUN NODE_OPTIONS=--max-old-space-size=4096 npm run build

FROM web-deps
WORKDIR /app
RUN rm package-lock.json && rm -rf /root/.npm /tmp/node-compile-cache
COPY plugins/web-ui/server ./server
COPY plugins/web-ui/src/app-edit.ts ./src/app-edit.ts
COPY plugins/admin/package.json plugins/admin/package-lock.json /admin/
RUN npm ci --prefix /admin --omit=dev && rm -rf /root/.npm /tmp/node-compile-cache
COPY plugins/admin/src /admin/src
COPY plugins/admin/ui /admin/ui
COPY plugins/admin/public /admin/public
COPY plugins/chassis/src /chassis/src
COPY plugins/web-ui/src /web-ui/src
COPY --from=build /app/dist-web ./dist-web

ARG GIT_SHA=
ENV GIT_SHA=$GIT_SHA
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
RUN apk add --no-cache util-linux
USER node
CMD ["node", "server/index.ts"]
