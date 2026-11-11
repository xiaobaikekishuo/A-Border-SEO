# A-Border SEO: the web app and the background worker in one image.
#
#   docker build -t a-border-seo:1.1.2 .
#
# The web app listens on port 3000 ("node server.js", the default command);
# "node worker.cjs" runs the background worker from the same image. The image
# does not change the database on start: apply the schema migrations first with
#
#   node node_modules/prisma/build/index.js migrate deploy
#
# docker-compose.yml does that before the app starts; the Windows kit backs the
# database up and then runs it.

FROM node:24-alpine AS base
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS builder
COPY . .
# Prisma generate needs a syntactically valid DATABASE_URL but never connects.
# Inline it so it does not persist as an image layer.
RUN DATABASE_URL="postgresql://build:build@localhost/build" npx prisma generate
# No network from here on: fonts are self-hosted (app/fonts.ts), so a dependency
# that tries to download something at build time fails here instead of later.
RUN --network=none npm run build
# The worker process as one file: the standalone output has no TypeScript
# runtime. Prisma stays external and resolves from node_modules.
RUN --network=none node scripts/build-worker.mjs /build/worker.cjs
RUN --network=none ./node_modules/.bin/esbuild scripts/review-crawl.ts --bundle --platform=node --packages=external --outfile=review-crawl.cjs
# The Prisma CLI with its full runtime dependency closure, computed from the
# installed tree (scripts/stage-prisma-cli.mjs explains why it is not a hand list).
RUN --network=none node scripts/stage-prisma-cli.mjs /build/prisma-cli

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs
COPY --from=builder /build/public ./public
COPY --from=builder --chown=nextjs:nodejs /build/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /build/.next/static ./.next/static
COPY --from=builder /build/prisma ./prisma
COPY --from=builder /build/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /build/worker.cjs ./worker.cjs
COPY --from=builder /build/review-crawl.cjs ./review-crawl.cjs
# Call the CLI through its real entry point (node_modules/prisma/build/index.js),
# not node_modules/.bin/prisma: COPY flattens that link into a file and the CLI
# then looks for its WASM files in the wrong directory.
COPY --from=builder /build/prisma-cli ./node_modules
USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
