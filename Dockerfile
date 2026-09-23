# The frame's server in a container. No build step and no dependencies to install.
FROM node:24-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
COPY package.json *.js ./
COPY dist ./dist
# GINGHAM_FORM tells Settings how this copy is updated: by pulling a new image. The version is package.json's.
ENV NODE_ENV=production FRAME_DATA=/data FRAME_AUTH=required PORT=8080 HOST=0.0.0.0 GINGHAM_FORM=container
EXPOSE 8080
# The volume arrives owned by root; hand it to the unprivileged user, then run as that user.
CMD ["sh", "-c", "mkdir -p /data/households && chown -R node:node /data && exec su-exec node node server.js"]
