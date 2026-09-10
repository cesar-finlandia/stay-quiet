# StayQuiet — one image, one port, one process.
#
# Stage 1 builds the browser bundle and the standalone context-buffer bridge with
# the repository's Node toolchain. Stage 2 is a Python runtime that also carries a
# bare `node` binary (copied from the official Node image, no node_modules) so the
# bridge runs without shipping 200 MB of packages.
FROM node:20-slim AS web
WORKDIR /build
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json vite.config.ts index.html ./
COPY contracts ./contracts
COPY src ./src
COPY engine ./engine
RUN npm run build:ui && npm run build:bridge

FROM python:3.11-slim AS runtime
# A bare Node binary for the context-buffer bridge. No npm, no node_modules.
COPY --from=node:20-slim /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8080 \
    HOST=0.0.0.0
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY config ./config
COPY contracts ./contracts
COPY fixtures ./fixtures
COPY src ./src
COPY engine ./engine
COPY pyproject.toml ./
COPY --from=web /build/dist ./dist
EXPOSE 8080
# No secret is baked in: with no AWS credentials the app serves the recorded cache.
CMD ["python", "-m", "src.stayquiet"]
