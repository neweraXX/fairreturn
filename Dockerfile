FROM node:22-alpine
WORKDIR /app
COPY server.js ./
COPY public ./public
COPY cache ./cache
RUN chown -R node:node /app
USER node
ENV PORT=8787
EXPOSE 8787
CMD ["node", "server.js"]
