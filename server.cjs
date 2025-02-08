require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream'); // <-- Import Node's stream module

(async () => {
  // Dynamically import the ESM-only Octokit packages
  const { Octokit } = await import('@octokit/rest');
  const { createAppAuth } = await import('@octokit/auth-app');

  const app = express();

  // Use express.json with a verify callback to capture the raw body
  app.use(express.json({
    verify: (req, res, buf, encoding) => {
      req.rawBody = buf;
    }
  }));

  /**
   * Middleware to verify the GitHub webhook signature.
   * It supports both SHA-256 and SHA-1 (if only X-Hub-Signature is provided).
   */
  function verifyGithubSignature(req, res, next) {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      console.error("Missing GITHUB_WEBHOOK_SECRET in environment variables.");
      return res.status(500).send("Server configuration error");
    }
    
    // Try to use the SHA-256 header first, then fallback to SHA-1
    let signature = req.get('X-Hub-Signature-256');
    let algorithm = 'sha256';
    if (!signature) {
      signature = req.get('X-Hub-Signature');
      algorithm = 'sha1';
    }
    if (!signature) {
      console.error("No signature found on request.");
      return res.status(401).send('Signature missing');
    }

    // Compute the digest using the same algorithm and the raw body
    const hmac = crypto.createHmac(algorithm, secret);
    hmac.update(req.rawBody);
    const digest = `${algorithm}=` + hmac.digest('hex');

    // Use timingSafeEqual to prevent timing attacks
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest))) {
      console.error("Request signatures do not match.");
      return res.status(401).send('Invalid signature');
    }
    
    // Signature verified; continue to the next middleware/route handler
    next();
  }

  // Load configuration from environment variables
  const appId = process.env.GITHUB_APP_ID;
  const installationId = process.env.GITHUB_INSTALLATION_ID;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const downloadFolder = process.env.DOWNLOAD_FOLDER || './';
  const assetName = process.env.ASSET_NAME; // e.g., "x64-linux.zip"
  const outputFileName = process.env.OUTPUT_FILE_NAME || 'download';
  const githubPrivateKeyFilepath = process.env.GITHUB_PRIVATE_KEY_FILEPATH;

  const privateKey = fs.readFileSync(githubPrivateKeyFilepath, 'utf-8');

  if (!appId || !installationId || !owner || !repo || !assetName || !privateKey) {
    console.error("Missing required configuration. Please check your environment variables.");
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

  // Use POST (GitHub sends webhook payloads as POST requests) and add our verification middleware
  app.post('/github-webhook', verifyGithubSignature, async (req, res) => {
    try {
      // Optionally, log the event type
      const eventType = req.get('X-GitHub-Event');
      console.log(`Received GitHub event: ${eventType}`);

      // Get an installation access token
      const { token: installationToken } = await octokit.auth({ type: "installation" });
      if (!installationToken) throw new Error("No installation token received");

      // Fetch the latest release for the repo
      const releaseResponse = await octokit.repos.getLatestRelease({ owner, repo });
      const release = releaseResponse.data;

      // Look for an asset that exactly matches the desired asset name
      if (!(release.assets && release.assets.length > 0)) {
        throw new Error("No assets attached to the release.");
      }
      const matchingAsset = release.assets.find(asset => asset.name === assetName);
      if (!matchingAsset) {
        throw new Error(`Asset named "${assetName}" not found in release assets.`);
      }
      console.log(`Found asset "${assetName}" with id ${matchingAsset.id}`);

      // Construct the API URL for downloading the asset from a private repository
      const assetApiUrl = `https://api.github.com/repos/${owner}/${repo}/releases/assets/${matchingAsset.id}`;
      console.log("Asset API URL:", assetApiUrl);

      // Prepare the request headers (using the installation token)
      const requestHeaders = {
        Authorization: `token ${installationToken}`,
        Accept: 'application/octet-stream'
      };

      // Download the asset using fetch (Node 18+ has a global fetch API)
      const response = await fetch(assetApiUrl, { headers: requestHeaders });
      if (!response.ok) {
        const errorText = await response.text();
        console.error("Fetch error details:", errorText);
        throw new Error(`Failed to download release asset: ${response.statusText} - ${errorText}`);
      }

      // Convert the WHATWG stream (response.body) to a Node.js Readable stream
      const nodeReadable = Readable.fromWeb(response.body);

      // Save the downloaded asset using your naming convention
      const filePath = path.join(downloadFolder, outputFileName);
      console.log("Saving file to:", filePath);
      const fileStream = fs.createWriteStream(filePath);

      // Pipe the Node.js stream into the file stream
      await new Promise((resolve, reject) => {
        nodeReadable.pipe(fileStream);
        nodeReadable.on("error", reject);
        fileStream.on("finish", resolve);
      });

      console.log("File downloaded successfully.");
      res.send(`Latest release asset downloaded to ${filePath}`);
    } catch (error) {
      console.error("Error in /github-webhook:", error);
      res.status(500).send(`Error: ${error.message}`);
    }
  });

  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
})();
