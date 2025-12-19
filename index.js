const fs = require("fs");
const path = require("path");
const { exec, execSync } = require("child_process");
const unzipper = require("unzipper");
const https = require("https");
const archiver = require("archiver");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const { google } = require("googleapis");
const WebSocket = require("ws");

const KEYFILEPATH = path.join(__dirname, "gdrive-key.json");
const SCOPES = ["https://www.googleapis.com/auth/drive"];
const DRIVE_FOLDER_ID = "1olOvZZbvGuyzoB-9L1d8sZXe9iEzauOA";
const TEMP_DIR = path.join(__dirname, "temp");
const OUTPUT_DIR = path.join(__dirname, "outputs");
const API_URL = "https://macbridge-backend.onrender.com/jobs/next";
const RESULT_URL = "https://macbridge-backend.onrender.com/jobs/result";

let ws;
let logQueue = [];
let socketReady = false;

// Reconnect WebSocket with backoff
function initWebSocket() {
  ws = new WebSocket("wss://macbridge-ws-logger.onrender.com");

  ws.on("open", () => {
    socketReady = true;
    console.log("[WebSocket] Connected to log server");
    logQueue.forEach((payload) => ws.send(JSON.stringify(payload)));
    logQueue = [];
    sendLog("Connected to remote WebSocket log server");
  });

  ws.on("error", (err) => {
    console.error("[WebSocket Error]:", err.message);
    socketReady = false;
  });

  ws.on("close", () => {
    socketReady = false;
    console.log("[WebSocket] Closed, reconnecting in 30s...");
    setTimeout(initWebSocket, 30000); // Backoff
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
    logQueue.push(payload);
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

  try {
    await fetch(RESULT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    sendLog(`Reported job result to backend: ${status}`, job_id);
  } catch (err) {
    sendLog(`Failed to report result: ${err.message}`, job_id);
  }

  if (webhookUrl) {
    try {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      sendLog("Webhook notified successfully.", jobId);
    } catch (err) {
      sendLog("Failed to notify webhook: " + err.message, jobId);
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

// ... (keep your other functions: runFlutterBuild, signAndBuild, downloadJobZip, findFlutterProjectRoot)

function fetchJobFromAPI() {
  sendLog("Checking for jobs from cloud...");

  https.get(API_URL, (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", async () => {
      if (res.statusCode !== 200) {
        sendLog(`API error: ${res.statusCode} - ${data.substring(0, 100)}...`);
        setTimeout(fetchJobFromAPI, 30000); // Backoff 30s
        return;
      }

      try {
        const job = JSON.parse(data);
        if (!job.job_id || !job.zip_url) {
          sendLog("No jobs available.");
          setTimeout(fetchJobFromAPI, 10000); // Poll 10s
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
          setTimeout(fetchJobFromAPI, 10000);
          return;
        }

        sendLog("Running flutter pub get in: " + projectRoot, jobName);
        exec("flutter pub get", { cwd: projectRoot }, (err) => {
          if (err) {
            sendLog(`pub get failed: ${err}`, jobName);
            reportResult(jobName, "failed", null, webhookUrl, err.message);
            setTimeout(fetchJobFromAPI, 10000);
            return;
          }

          const outputFile = path.join(OUTPUT_DIR, `${jobName}.app`);
          signAndBuild(projectRoot, outputFile, jobName, buildMode, webhookUrl);
        });
      } catch (err) {
        sendLog("JSON parse or handling error: " + err.message);
        setTimeout(fetchJobFromAPI, 30000);
      }
    });
  }).on("error", (err) => {
    sendLog("Failed to contact API: " + err.message);
    setTimeout(fetchJobFromAPI, 30000);
  });
}

// Poll every 10s
setInterval(fetchJobFromAPI, 10000);

// Initial call
fetchJobFromAPI();

sendLog("Agent started...");