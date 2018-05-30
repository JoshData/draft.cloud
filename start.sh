#!/bin/bash
source ~/.nvm/nvm.sh
nvm use default
./build.sh
node_modules/spectacle-docs/bin/spectacle.js -t public_html/apidocs/v1 backend/swagger.yaml
node index.js
