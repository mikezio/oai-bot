#!/bin/zsh
set -e
cd "${0:A:h}"
if [[ ! -d node_modules ]]; then
  npm install
fi
npm run build
open http://127.0.0.1:4317
export HOST=0.0.0.0
oai_bot_interface=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')
oai_bot_ip=$(ipconfig getifaddr "$oai_bot_interface" 2>/dev/null || true)
echo "Phone URL: http://${oai_bot_ip:-your-mac-ip}:4317"
npm start
