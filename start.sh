#!/bin/bash
source ~/.nvm/nvm.sh
nvm use default
./build.sh
node index.js
