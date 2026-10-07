# Arena Command Suite — static serve (dashboard + app + brand assets)
# Used by Coolify / any Docker host. No build step required.
FROM nginx:alpine
COPY . /usr/share/nginx/html
EXPOSE 80
