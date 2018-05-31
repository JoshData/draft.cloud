#!/bin/bash

# Build client-side widgets library.
node_modules/browserify/bin/cmd.js -d widgets/draftdotcloud.js -o public_html/draftdotcloud.js

# Build API documentation.
node_modules/spectacle-docs/bin/spectacle.js -t public_html/apidocs/v1 backend/swagger.yaml
