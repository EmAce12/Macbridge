const fs = require("fs");
const path = require("path");
const { exec, execSync } = require("child_process");
const unzipper = require("unzipper");
const https = require("https");
const http = require("http");
const archiver = require("archiver");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const { google } = require("googleapis");

const WebSocket = require("ws");
let ws;
let logQueue = [];
let socketReady = false;

const KEYFILEPATH = path.join(__dirname, "gdrive-key.json");
const SCOPES = ["https://www.googleapis.com/auth/drive"];
const DRIVE_FOLDER_ID = "1olOvZZbvGuyzoB-9L1d8sZXe9iEzauOA";
const TEMP_DIR = path.join(__dirname, "temp");
const OUTPUT_DIR = path.join(__dirname, "outputs");
const API_URL = "https://macbridge-backend.onrender.com/jobs/next";
const RESULT_URL = "https://macbridge-backend.onrender.com/jobs/result";

// WebSocket Setup (Render URL)
function initWebSocket() {
  ws = new WebSocket("wss://macbridge-ws-logger.onrender.com");

  ws.on("open", () => {
    socketReady = true;
    console.log("[WebSocket] Connected to log server");

    // Flush any early logs
    logQueue.forEach((payload) => {
      ws.send(JSON.stringify(payload));
    });
    logQueue = [];

    sendLog("Connected to remote WebSocket log server");
  });

  ws.on("error", (err) => {
    console.error("[WebSocket Error]:", err.message);
  });
}

function sendLog(msg, jobId = null) {
  const fullMessage = `[MacBridge Agent] ${msg}`;
  console.log(fullMessage);

  const payload = {
    log: fullMessage,
    ...(jobId && { jobId }),
  };

  if (socketReady && ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  } else {
    logQueue.push(payload); // store until ready
  }
}

initWebSocket();

async function extractZip(zipPath, destPath, jobId) {
  return new Promise((resolve, reject) => {
    fs.createReadStream(zipPath)
      .pipe(unzipper.Parse())
      .on("entry", function (entry) {
        const fullPath = path.join(destPath, entry.path);
        if (entry.type === "Directory") {
          fs.mkdirSync(fullPath, { recursive: true });
          entry.autodrain();
        } else {
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          entry.pipe(fs.createWriteStream(fullPath));
        }
      })
      .on("close", resolve)
      .on("error", reject);
  });
}

async function reportResult(job_id, status, outputUrl = null, webhookUrl = null, errorMessage = null) {
  const body = { job_id, status, output_url: outputUrl, error: errorMessage };

  await fetch(RESULT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  sendLog(`Reported job result to backend: ${status}`, job_id);

  if (webhookUrl) {
    try {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      sendLog("Webhook notified successfully.", job_id);
    } catch (err) {
      sendLog("Failed to notify webhook: " + err.message, job_id);
    }
  }
}

async function uploadToGoogleDrive(filePath, jobId) {
  try {
    sendLog("Zipping output for upload...", jobId);
    const zipPath = filePath + ".zip";
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.directory(filePath, false);
    archive.pipe(output);
    await archive.finalize();

    const auth = new google.auth.GoogleAuth({
      keyFile: KEYFILEPATH,
      scopes: SCOPES,
    });

    const drive = google.drive({ version: "v3", auth });

    const fileMetadata = {
      name: path.basename(zipPath),
      parents: [DRIVE_FOLDER_ID],
    };

    const media = {
      mimeType: "application/zip",
      body: fs.createReadStream(zipPath),
    };

    sendLog("Uploading to Google Drive...", jobId);
    const file = await drive.files.create({
      resource: fileMetadata,
      media,
      fields: "id",
    });

    const fileId = file.data.id;

    await drive.permissions.create({
      fileId,
      requestBody: { role: "reader", type: "anyone" },
    });

    const publicUrl = `https://drive.google.com/uc?id=${fileId}&export=download`;
    sendLog(`Uploaded to Google Drive: ${publicUrl}`, jobId);
    return publicUrl;
  } catch (err) {
    sendLog("Google Drive upload failed: " + err.message, jobId);
    return null;
  }
}

function runFlutterBuild(projectRoot, outputFile, job_id, webhookUrl) {
  sendLog("Running flutter build ios --release...", job_id);
  exec("flutter build ios --release", { cwd: projectRoot }, async (err) => {
    if (err) {
      sendLog(`Build failed: ${err}`, job_id);
      await reportResult(job_id, "failed", null, webhookUrl, err.message);
      return;
    }

    const ipaPath = path.join(projectRoot, "build/ios/iphoneos/Runner.app");
    if (fs.existsSync(ipaPath)) {
      fs.cpSync(ipaPath, outputFile, { recursive: true });
      await reportResult(job_id, "success", "local-only", webhookUrl);
      sendLog(`Build complete → ${outputFile}`, job_id);
    } else {
      await reportResult(job_id, "failed", null, webhookUrl, "Runner.app not found after release build.");
      sendLog("Build completed, but .ipa not found.", job_id);
    }
  });
}

function runFlutterSimulatorBuild(projectRoot, outputFile, job_id, webhookUrl) {
  sendLog("Running flutter build ios --simulator...", job_id);
  exec("flutter build ios --simulator", { cwd: projectRoot }, async (err) => {
    if (err) {
      sendLog(`Simulator build failed: ${err}`, job_id);
      await reportResult(job_id, "failed", null, webhookUrl, err.message);
      return;
    }

    const appPath = path.join(projectRoot, "build/ios/iphonesimulator/Runner.app");
    if (fs.existsSync(appPath)) {
      fs.cpSync(appPath, outputFile, { recursive: true });
      const outputUrl = await uploadToGoogleDrive(outputFile, job_id);
      await reportResult(job_id, "success", outputUrl, webhookUrl);
      sendLog(`Simulator build complete → ${outputUrl}`, job_id);
    } else {
      await reportResult(job_id, "failed", null, webhookUrl, "Runner.app not found after simulator build.");
      sendLog("Simulator build finished, but Runner.app not found.", job_id);
    }
  });
}

function signAndBuild(projectRoot, outputFile, job_id, buildMode = "simulator", webhookUrl = null) {
  sendLog("Build mode: " + buildMode, job_id);

  if (buildMode === "simulator") {
    return runFlutterSimulatorBuild(projectRoot, outputFile, job_id, webhookUrl);
  }

  const certPath = path.join(projectRoot, "signing.p12");
  const profilePath = path.join(projectRoot, "profile.mobileprovision");
  const passPath = path.join(projectRoot, "password.txt");

  const hasSigning = fs.existsSync(certPath) && fs.existsSync(profilePath) && fs.existsSync(passPath);

  if (!hasSigning) {
    sendLog("Code signing files not found — switching to simulator build.", job_id);
    return runFlutterSimulatorBuild(projectRoot, outputFile, job_id, webhookUrl);
  }

  const password = fs.readFileSync(passPath, "utf-8").trim();

  try {
    sendLog("Importing certificate...", job_id);
    execSync(`security import "${certPath}" -k ~/Library/Keychains/login.keychain-db -P "${password}" -T /usr/bin/codesign`);
    execSync(`mkdir -p ~/Library/MobileDevice/Provisioning\\ Profiles/`);
    execSync(`cp "${profilePath}" ~/Library/MobileDevice/Provisioning\\ Profiles/`);
    return runFlutterBuild(projectRoot, outputFile, job_id, webhookUrl);
  } catch (err) {
    sendLog("Code signing failed: " + err.message, job_id);
    return reportResult(job_id, "failed", null, webhookUrl, err.message);
  }
}

function downloadJobZip(url, destPath, jobId) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;

    function requestAndFollow(currentUrl) {
      const req = client.get(currentUrl, (res) => {
        if ([301, 302, 303].includes(res.statusCode)) {
          const redirectUrl = res.headers.location;
          if (!redirectUrl) return reject(new Error("Redirect with no location header"));
          sendLog(`Redirecting to: ${redirectUrl}`, jobId);
          return requestAndFollow(redirectUrl);
        }

        if (res.statusCode !== 200) {
          return reject(new Error(`Download failed: ${res.statusCode}`));
        }

        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      });

      req.on("error", reject);
    }

    requestAndFollow(url);
  });
}

function fetchJobFromAPI() {
  sendLog("Checking for jobs from cloud...");

  https.get(API_URL, (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", async () => {
      try {
        const job = JSON.parse(data);
        if (!job.job_id || !job.zip_url) {
          sendLog("No jobs available.");
          return;
        }

        const jobName = job.job_id;
        const zipUrl = job.zip_url;
        const buildMode = job.build_mode || "simulator";
        const webhookUrl = job.webhook_url || null;

        const zipPath = path.join(TEMP_DIR, `${jobName}.zip`);
        const extractPath = path.join(TEMP_DIR, jobName);

        fs.rmSync(extractPath, { recursive: true, force: true });
        fs.mkdirSync(extractPath, { recursive: true });

        sendLog(`Downloading job: ${jobName}`, jobName);
        await downloadJobZip(zipUrl, zipPath, jobName);

        sendLog("Extracting job...", jobName);
        await extractZip(zipPath, extractPath, jobName);

        const projectRoot = findFlutterProjectRoot(extractPath);
        if (!projectRoot) {
          sendLog("pubspec.yaml not found in any folder", jobName);
          await reportResult(jobName, "failed", null, webhookUrl, "pubspec.yaml not found");
          return;
        }

        sendLog("Running flutter pub get in: " + projectRoot, jobName);
        exec("flutter pub get", { cwd: projectRoot }, (err) => {
          if (err) {
            sendLog(`pub get failed: ${err}`, jobName);
            reportResult(jobName, "failed", null, webhookUrl, err.message);
            return;
          }

          const outputFile = path.join(OUTPUT_DIR, `${jobName}.app`);
          signAndBuild(projectRoot, outputFile, jobName, buildMode, webhookUrl);
        });
      } catch (err) {
        sendLog("Error handling job: " + err.message);
        try {
          const job = JSON.parse(data);
          if (job?.job_id) await reportResult(job.job_id, "failed", null, job.webhook_url || null, err.message);
        } catch {}
      }
    });
  }).on("error", (err) => {
    sendLog("Failed to contact API: " + err.message);
  });
}

function findFlutterProjectRoot(startPath) {
  const entries = fs.readdirSync(startPath);
  if (entries.includes("pubspec.yaml")) return startPath;

  for (const entry of entries) {
    const fullPath = path.join(startPath, entry);
    if (fs.statSync(fullPath).isDirectory()) {
      const result = findFlutterProjectRoot(fullPath);
      if (result) return result;
    }
  }
  return null;
}

sendLog("Agent started...");

// Wait a second to allow WebSocket subscription from frontend
setTimeout(() => {
  fetchJobFromAPI();
}, 1000);