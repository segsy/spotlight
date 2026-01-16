# Specify the base Docker image. You can read more about
# the available images at https://docs.apify.com/sdk/js/docs/guides/docker-images
FROM apify/actor-node-playwright:20

COPY --chown=myuser:myuser package*.json ./

RUN npm --quiet set progress=false \
  && npm install --omit=dev \
  && npx --yes playwright install chromium \
  && rm -rf ~/.npm

COPY --chown=myuser:myuser . ./

CMD npm start --silent
