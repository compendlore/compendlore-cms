# syntax=docker/dockerfile:1.7

FROM node:24.13.1-bookworm-slim AS dependencies

ENV CI=true
WORKDIR /home/node/workspace
COPY --chown=node:node . .
RUN chown node:node /home/node/workspace
USER node
RUN npm ci

FROM dependencies AS frontend-build
ARG VITE_API_ORIGIN=http://localhost:4000
ENV VITE_API_ORIGIN=${VITE_API_ORIGIN}
RUN npm run build:frontend

FROM nginx:1.28-alpine AS nginx-runtime
COPY docker/nginx.conf /etc/nginx/nginx.conf
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
	CMD wget --quiet --tries=1 --spider http://127.0.0.1:8080/ || exit 1

FROM nginx-runtime AS site
COPY docker/site.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend-build --chown=nginx:nginx /home/node/workspace/frontend/site/dist /usr/share/nginx/html

FROM nginx-runtime AS administration
COPY docker/administration.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend-build --chown=nginx:nginx /home/node/workspace/frontend/administration/dist /usr/share/nginx/html

FROM dependencies AS quality
RUN npm run ci
CMD ["npm", "run", "ci"]
