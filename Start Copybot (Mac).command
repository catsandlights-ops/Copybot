#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null; then echo "Node.js is not installed. Get it from https://nodejs.org then run this again."; read; exit 1; fi
[ -d node_modules ] || { echo "Installing, this takes a minute the first time..."; npm install; }
[ -f .env ] || cp .env.example .env
npm run app
