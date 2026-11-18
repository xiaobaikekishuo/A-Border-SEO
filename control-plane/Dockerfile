ARG NODE_BASE=node:24-alpine
FROM ${NODE_BASE}
WORKDIR /app
COPY --chown=node:node control-plane/*.mjs control-plane/package.json /app/control-plane/
COPY --chown=node:node control-plane/migrations/*.sql /app/control-plane/migrations/
COPY --chown=node:node control-plane/web/index.html control-plane/web/admin.css control-plane/web/admin.js /app/control-plane/web/
COPY --chown=node:node source/lib/managed/protocol.mjs /app/source/lib/managed/protocol.mjs
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV ABORDER_CONTROL_DB=/app/data/control.sqlite
EXPOSE 8080
CMD ["node", "/app/control-plane/server.mjs"]
