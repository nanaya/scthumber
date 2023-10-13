FROM node:20-bookworm-slim

RUN DEBIAN_FRONTEND=noninteractive apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

USER node

ADD --chown=node:node . /app

WORKDIR /app
ENV NODE_ENV=production

RUN yarn --frozen-lockfile --ignore-optional

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "scthumbd.js"]
