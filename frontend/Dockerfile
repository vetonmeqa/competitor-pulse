# --- Build: typecheck and bundle the React app -------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- Runtime: nginx serves the static files and forwards /api to the backend -------------
FROM nginx:1.29-alpine
# Where nginx forwards /api requests. Compose sets it to the api service.
ENV API_URL=http://api:3000
# Makes the official image read the container's DNS servers into NGINX_LOCAL_RESOLVERS.
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
# The official image fills in the ${...} variables from the environment at container start.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
