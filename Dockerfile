# One image for self-host and hosted (MASTER.md §10). Node runs TypeScript directly; the web app is prebuilt here.
# The runtime stage gets production dependencies and runtime sources only (no tests, fixtures, docs or build tools).

FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS manifests
WORKDIR /app
COPY packages ./packages-src
# Only package manifests, so dependency layers stay cached until a manifest changes.
RUN find packages-src -name package.json -not -path '*/node_modules/*' | while read f; do d=$(dirname "$f" | sed 's#^packages-src#packages#'); mkdir -p "$d"; cp "$f" "$d/"; done && rm -rf packages-src

FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY --from=manifests /app/packages ./packages
RUN npm ci --no-audit --no-fund

FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY --from=manifests /app/packages ./packages
COPY scripts/prune-optional-peers.ts scripts/
# pdfjs-dist lists @napi-rs/canvas as optional (native, for rendering pages; we only read text): drop it. Then
# refuse to build if any native addon (*.node) is left, so a new dependency can't slip one into the musl image.
RUN npm ci --omit=dev --no-audit --no-fund && rm -rf "$(npm config get cache)" \
 && node scripts/prune-optional-peers.ts && rm -rf scripts \
 && find . -path '*/node_modules/@napi-rs' -type d -prune -exec rm -rf {} + \
 && if find . -path '*/node_modules/*' -name '*.node' -type f | grep .; then echo 'native addons in production dependencies (above): the image must stay pure JavaScript' >&2; exit 1; fi

FROM deps AS build
COPY . .
RUN npm run build -w @agfn/web
# Runtime sources only: drop tests, recorded fixtures, scripts and the web app's sources (its dist is kept).
RUN mkdir /out \
 && cp -r packages apps /out/ \
 && find /out -name node_modules -prune -o \( -name '*.test.ts' -o -name 'test-kit.ts' -o -name 'testing.ts' -o -name '*.sandbox.test.ts' \) -type f -print | xargs rm -f \
 && find /out -name node_modules -prune -o -type d \( -name fixtures -o -name scripts \) -print | xargs rm -rf \
 && find /out -name node_modules -prune -o -type d -print | grep '/node_modules$' | xargs rm -rf \
 && rm -rf /out/apps/web/src /out/apps/web/public

# Plain Alpine plus the node binary (same Alpine release as the node image): no npm, yarn or corepack in the shipped
# image. Every dependency is pure JavaScript (SQLite is node:sqlite), so musl is fine.
FROM node:22-alpine3.24@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS node
FROM alpine:3.24@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a AS runtime
RUN apk add --no-cache libstdc++ libgcc && addgroup -g 1000 node && adduser -u 1000 -G node -s /bin/sh -D node
COPY --from=node /usr/local/bin/node /usr/local/bin/node
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8787
WORKDIR /app
COPY --from=prod-deps /app /app
COPY --from=build /out/packages ./packages
COPY --from=build /out/apps ./apps
# /privacy, /terms, /docs/<name> (every PUBLIC_DOCS file in apps/server/src/legal.ts) and /docs/guides/* are rendered
# from these at boot. A doc missing here renders as "Not published yet" (scripts/dockerfile.test.ts checks the list).
COPY docs/legal ./docs/legal
COPY docs/connect-your-ai.md ./docs/connect-your-ai.md
COPY docs/recipes.md ./docs/recipes.md
COPY docs/connectors.md ./docs/connectors.md
COPY docs/institutions.json ./docs/institutions.json
COPY docs/guides ./docs/guides
# AGFN_MASTER_KEY_COMMAND runs this at boot. The rest of scripts/ stays out of the image.
COPY scripts/kms-master-key.mjs ./scripts/kms-master-key.mjs
RUN mkdir -p /data && chown -R node:node /data && chmod 700 /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/src/main.ts"]
