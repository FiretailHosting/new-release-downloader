## Install Github Private Key
Place the private key in a directory of your choosing

### Set up Env File
Read the .env.sample file and create a .env file with the same variables


npx esbuild server.cjs --bundle --platform=node --target=node18 --outfile=dist/server.js

pkg ./dist/server.js --target node18-x64-linux -o server-x64