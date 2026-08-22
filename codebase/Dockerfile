FROM node:22-bookworm-slim AS dependencies
WORKDIR /srv/payflow
COPY package.json package-lock.json* ./
RUN npm install

FROM dependencies AS runtime
COPY . .
RUN npm run typecheck
CMD ["npm", "run", "start:gateway"]
