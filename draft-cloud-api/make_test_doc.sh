#!/bin/bash

PORT=$(jq .port < $(dirname $0)/../local/environment.json)

F=$(mktemp)
curl -s -D - -X POST http://localhost:$PORT/api/v1/users > $F
API_KEY=$(grep "^X-Api-Key:" $F | sed "s/.*: //" | sed 's/\s//g')
# remove headers with awk to pass just json to jq
DOCSURL=$(cat $F | awk '/^\s*$/{p++};p' | jq -r .api_urls.documents)
rm -f $F

echo API_KEY: $API_KEY
curl -s -X POST -d "" --header "Authorization: $API_KEY" $DOCSURL | jq -r .api_urls.debugger


