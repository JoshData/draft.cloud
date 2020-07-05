#!/bin/bash

ROOT=frontend/public_html

# Build client-side widgets library.
node_modules/browserify/bin/cmd.js -d widgets/draftdotcloud.js -o $ROOT/draftdotcloud.js

# Build API documentation.
node_modules/spectacle-docs/bin/spectacle.js -j -t $ROOT/apidocs/v1 backend/swagger.yaml

# Get fonts.
FONTDIR=$ROOT/static/fonts/google
rm -rf $FONTDIR
mkdir -p $FONTDIR
node_modules/google-font-installer/cli.js download -d $FONTDIR Macondo
node_modules/google-font-installer/cli.js download -d $FONTDIR "IBM Plex Sans"
node_modules/google-font-installer/cli.js download -d $FONTDIR "IBM Plex Mono"
