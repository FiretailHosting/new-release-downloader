import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import fetch from 'node-fetch';
import 'dotenv/config';

const privateKey = fs.readFileSync('./pkey.pem', 'utf-8');
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Load configuration from environment variables
const appId = process.env.GITHUB_APP_ID;
const installationId = process.env.GITHUB_INSTALLATION_ID;
const owner = process.env.GITHUB_OWNER;
const repo = process.env.GITHUB_REPO;
const downloadFolder = process.env.DOWNLOAD_FOLDER || './';
const assetName = process.env.ASSET_NAME; // For example: "x64-linux" or "x64-linux.zip"
const outputFileName = process.env.OUTPUT_FILE_NAME || 'download';
// Initialize Octokit with GitHub App authentication
const octokit = new Octokit({
  authStrategy: createAppAuth,
  auth: {
    appId,
    privateKey,
    installationId,
  },
});

// Route to download the latest release asset by name
app.get('/update-release', async (req, res) => {
  try {
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
    console.log("Request headers:", requestHeaders);

    // Download the asset using node-fetch
    const response = await fetch(assetApiUrl, { headers: requestHeaders });
    console.log(`Fetch response status: ${response.status} ${response.statusText}`);
    if (!response.ok) {
      const errorText = await response.text();
      console.error("Fetch error details:", errorText);
      throw new Error(`Failed to download release asset: ${response.statusText} - ${errorText}`);
    }

    // Save the downloaded asset using your naming convention
    const filePath = path.join(downloadFolder, outputFileName);
    console.log("Saving file to:", filePath);
    const fileStream = fs.createWriteStream(filePath);
    await new Promise((resolve, reject) => {
      response.body.pipe(fileStream);
      response.body.on("error", reject);
      fileStream.on("finish", resolve);
    });

    console.log("File downloaded successfully.");
    res.send(`Latest release asset downloaded to ${filePath}`);
  } catch (error) {
    console.error("Error in /update-release:", error);
    res.status(500).send(`Error: ${error.message}`);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
