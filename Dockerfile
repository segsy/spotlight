# Specify the base Docker image. You can read more about
# the available images at https://docs.apify.com/sdk/js/docs/guides/docker-images
FROM apify/actor-node:22

RUN npm ls crawlee apify puppeteer playwright || true

COPY --chown=myuser:myuser package*.json ./

RUN npm --quiet set progress=false     && npm install --omit=dev --omit=optional     && echo "Installed NPM packages:"     && (npm list --omit=dev --all || true)     && echo "Node.js version:"     && node --version     && echo "NPM version:"     && npm --version     && rm -r ~/.npm

COPY --chown=myuser:myuser . ./

CMD npm start --silent
