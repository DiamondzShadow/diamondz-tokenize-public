# Mastercard Open Finance relay — Cloud Run (us-central1). No dependencies beyond Bun itself.
FROM oven/bun:1.3.14-slim
WORKDIR /app
COPY server.ts .
USER bun
ENV PORT=8080
EXPOSE 8080
CMD ["bun", "run", "server.ts"]
