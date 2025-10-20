FROM node:24-bookworm-slim

USER node

ADD --chown=node:node . /app

WORKDIR /app
ENV NODE_ENV=production

RUN yarn --frozen-lockfile

CMD ["node", "scthumbd.js"]
