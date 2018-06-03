#!/bin/bash

# Build client-side widgets library.
node_modules/browserify/bin/cmd.js -d widgets/draftdotcloud.js -o public_html/draftdotcloud.js

# Build API documentation.
node_modules/spectacle-docs/bin/spectacle.js -j -t public_html/apidocs/v1 backend/swagger.yaml

# Get fonts.
FONTDIR=public_html/static/fonts/google
rm -rf $FONTDIR
mkdir -p $FONTDIR
node_modules/google-font-installer/cli.js download -d $FONTDIR Macondo
