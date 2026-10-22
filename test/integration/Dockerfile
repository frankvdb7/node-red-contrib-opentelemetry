FROM node:24-alpine
ARG NODE_RED_VERSION=5
WORKDIR /data
RUN npm init -y && npm install --omit=dev --no-audit --no-fund "node-red@${NODE_RED_VERSION}"
COPY plugin.tgz /tmp/plugin.tgz
RUN npm install --omit=dev --no-audit --no-fund /tmp/plugin.tgz && rm /tmp/plugin.tgz
EXPOSE 1880
CMD ["node", "node_modules/node-red/red.js", "--userDir", "/data", "--settings", "/data/settings.js"]
