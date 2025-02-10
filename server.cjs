require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

(async () => {
  // Dynamically import the ESM-only Octokit packages
  const { Octokit } = await import('@octokit/rest');
  const { createAppAuth } = await import('@octokit/auth-app');

  // Load configuration from environment variables
  const appId = process.env.GITHUB_APP_ID;
  const installationId = process.env.GITHUB_INSTALLATION_ID;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const downloadFolder = process.env.DOWNLOAD_FOLDER || './';
  const assetName = process.env.ASSET_NAME; // e.g., "x64-linux"
  const outputFileName = process.env.OUTPUT_FILE_NAME || 'download';
  const githubPrivateKeyFilepath = process.env.GITHUB_PRIVATE_KEY_FILEPATH;

  let privateKey;
  try {
    privateKey = fs.readFileSync(githubPrivateKeyFilepath, 'utf-8');
  } catch (err) {
    console.error(`Error reading private key file at "${githubPrivateKeyFilepath}":`, err);
    process.exit(1);
  }

  if (!appId || !installationId || !owner || !repo || !assetName || !privateKey) {
    console.error(
      "Missing required configuration. Please check your environment variables (GITHUB_APP_ID, GITHUB_INSTALLATION_ID, GITHUB_OWNER, GITHUB_REPO, ASSET_NAME, GITHUB_PRIVATE_KEY_FILEPATH)."
    );
    process.exit(1);
  }

  // Initialize Octokit with GitHub App authentication
  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId,
      privateKey,
      installationId,
    },
  });

  // Get an installation access token
  const { token: installationToken } = await octokit.auth({ type: "installation" });
  if (!installationToken) {
    console.error("No installation token received from GitHub.");
    process.exit(1);
  }

  // Fetch the latest release for the repository
  const releaseResponse = await octokit.repos.getLatestRelease({ owner, repo });
  const release = releaseResponse.data;

  // Look for an asset that exactly matches the desired asset name
  if (!(release.assets && release.assets.length > 0)) {
    console.error("No assets attached to the latest release.");
    process.exit(1);
  }
  const matchingAsset = release.assets.find(asset => asset.name === assetName);
  if (!matchingAsset) {
    console.error(`Asset named "${assetName}" not found in the release assets.`);
    process.exit(1);
  }
  console.log(`Found asset "${assetName}" with id ${matchingAsset.id}.`);

  // Construct the API URL for downloading the asset
  const assetApiUrl = `https://api.github.com/repos/${owner}/${repo}/releases/assets/${matchingAsset.id}`;
  console.log("Asset API URL:", assetApiUrl);

  // Prepare the request headers, including User-Agent and redirect option
  const requestHeaders = {
    Authorization: `token ${installationToken}`,
    Accept: 'application/octet-stream',
    'User-Agent': 'node-download-script'
  };

  // Download the asset using fetch (Node 18+ has a global fetch API)
  const response = await fetch(assetApiUrl, { 
    headers: requestHeaders, 
    redirect: 'follow' // be explicit about following redirects
  });
  if (!response.ok) {
    const errorText = await response.text();
    console.error(`Failed to download release asset. Status: ${response.status}. Message: ${errorText}`);
    process.exit(1);
  }

  // Optional: log the Content-Length header for progress estimation
  const contentLengthHeader = response.headers.get('content-length');
  const totalSize = contentLengthHeader ? parseInt(contentLengthHeader, 10) : null;
  if (totalSize) {
    console.log(`Total size: ${totalSize} bytes`);
  } else {
    console.log("Content-Length header is missing. Cannot determine total size.");
  }

  // Convert the WHATWG stream (response.body) to a Node.js Readable stream
  const nodeReadable = Readable.fromWeb(response.body);

  // Create a transform stream to log progress
  let downloadedBytes = 0;
  const progressLogger = new Transform({
    transform(chunk, encoding, callback) {
      downloadedBytes += chunk.length;
      if (totalSize) {
        const percent = ((downloadedBytes / totalSize) * 100).toFixed(2);
        console.log(`Downloaded ${downloadedBytes} of ${totalSize} bytes (${percent}%)`);
      } else {
        console.log(`Downloaded ${downloadedBytes} bytes`);
      }
      callback(null, chunk);
    }
  });

  // Save the downloaded asset to disk with progress logging
  const filePath = path.join(downloadFolder, outputFileName);
  console.log("Saving downloaded asset to:", filePath);
  const fileStream = fs.createWriteStream(filePath);

  try {
    await pipeline(nodeReadable, progressLogger, fileStream);
    console.log("File downloaded successfully.");
  } catch (err) {
    console.error("Error during file download:", err);
    process.exit(1);
  }
})();