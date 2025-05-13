const fs = require("fs");
const path = require("path");
const { exec, execSync } = require("child_process");
const unzipper = require("unzipper");
const https = require("https");
const http = require("http");
const archiver = require("archiver");
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const { google } = require("googleapis");
const { stderr } = require("process");
const KEYFILEPATH = path.join(__dirname, "gdrive-key.json");
const SCOPES = ["https://www.googleapis.com/auth/drive"];
const DRIVE_FOLDER_ID = "1olOvZZbvGuyzoB-9L1d8sZXe9iEzauOA"; // <-- Replace with your actual Google Drive folder ID

const TEMP_DIR = path.join(__dirname, "temp");
const OUTPUT_DIR = path.join(__dirname, "outputs");
const API_URL = "https://macbridge-backend.onrender.com/jobs/next";
const RESULT_URL = "https://macbridge-backend.onrender.com/jobs/result";

function log(msg) {
  console.log(`[MacBridge Agent] ${msg}`);
}

async function extractZip(zipPath, destPath) {
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
async function reportResult(job_id, status, outputUrl = null, errorMessage = null) {
  const body = {
    job_id,
    status,
    output_url: outputUrl,
  };
  if (errorMessage) {
    body.error_message = errorMessage;
  }

  const res = await fetch(RESULT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  log(`Reported job result to backend: ${status}${errorMessage ? " with error message" : ""}`);
}

async function uploadToGoogleDrive(filePath) {
  log("Zipping output for upload...");

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

  log("Uploading to Google Drive...");
  const file = await drive.files.create({
    resource: fileMetadata,
    media,
    fields: "id",
  });

  const fileId = file.data.id;

  await drive.permissions.create({
    fileId,
    requestBody: {
      role: "reader",
      type: "anyone",
    },
  });

  const publicUrl = `https://drive.google.com/uc?id=${fileId}&export=download`;
  log(`Uploaded to Google Drive: ${publicUrl}`);
  return publicUrl;
}

function runFlutterBuild(projectRoot, outputFile, job_id) {
  log("Running flutter build ios --release...");
  exec("flutter build ios --release", { cwd: projectRoot }, async (err) => {
    if (err) {
      log(`Build failed: ${err}`);
      await reportResult(job_id, "failed", null, err.message);
      return;
    }

    const ipaPath = path.join(projectRoot, "build/ios/iphoneos/Runner.app");
    if (fs.existsSync(ipaPath)) {
      fs.cpSync(ipaPath, outputFile, { recursive: true });
      await reportResult(job_id, "success", "local-only");
      log(`Build complete → ${outputFile}`);
    } else {
      await reportResult(job_id, "failed", null, err.message);
      log("Build completed, but .ipa not found.");
    }
  });
}

function runFlutterSimulatorBuild(projectRoot, outputFile, job_id) {
  log("Running flutter build ios --simulator...");
  exec("flutter build ios --simulator", { cwd: projectRoot }, async (err) => {
    if (err) {
      log(`Simulator build failed: ${err}`);
      await reportResult(job_id, "failed", null, err.message);
      return;
    }

    const appPath = path.join(projectRoot, "build/ios/iphonesimulator/Runner.app");
    if (fs.existsSync(appPath)) {
      fs.cpSync(appPath, outputFile, { recursive: true });
      const outputUrl = await uploadToGoogleDrive(outputFile);
      await reportResult(job_id, "success", outputUrl);
      log(`Simulator build complete → ${outputUrl}`);
    } else {
      await reportResult(job_id, "failed", null, err.message);
      log("Simulator build finished, but Runner.app not found.");
    }
  });
}

function signAndBuild(projectRoot, outputFile, job_id, buildMode = "simulator") {
  log("Build mode: " + buildMode);
  const testModePath = path.join(projectRoot, "test_mode.txt");

  const isSimulator = buildMode === "simulator";

  if (isSimulator) {
    log("Building for iOS simulator as requested...");
    return runFlutterSimulatorBuild(projectRoot, outputFile, job_id);
  }

  const certPath = path.join(projectRoot, "signing.p12");
  const profilePath = path.join(projectRoot, "profile.mobileprovision");
  const passPath = path.join(projectRoot, "password.txt");

  const hasSigning = fs.existsSync(certPath) && fs.existsSync(profilePath) && fs.existsSync(passPath);

  if (!hasSigning) {
    log("Code signing files not found — switching to simulator build.");
    return runFlutterSimulatorBuild(projectRoot, outputFile, job_id);
  }

  const password = fs.readFileSync(passPath, "utf-8").trim();

  try {
    log("Importing certificate...");
    execSync(`security import "${certPath}" -k ~/Library/Keychains/login.keychain-db -P "${password}" -T /usr/bin/codesign`);
    log("Copying provisioning profile...");
    execSync(`mkdir -p ~/Library/MobileDevice/Provisioning\\ Profiles/`);
    execSync(`cp "${profilePath}" ~/Library/MobileDevice/Provisioning\\ Profiles/`);
    return runFlutterBuild(projectRoot, outputFile, job_id);
  } catch (err) {
    log("Code signing failed: " + err.message);
    return reportResult(job_id, "failed");
  }
}

function downloadJobZip(url, destPath) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;

    function requestAndFollow(currentUrl) {
      const req = client.get(currentUrl, (res) => {
        if ([301, 302, 303].includes(res.statusCode)) {
          const redirectUrl = res.headers.location;
          if (!redirectUrl) return reject(new Error("Redirect with no location header"));
          log(`Redirecting to: ${redirectUrl}`);
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

// ... [top imports remain the same, unchanged]

function fetchJobFromAPI() {
  log("Checking for jobs from cloud...");

  https.get(API_URL, (res) => {
    let data = "";
    res.on("data", chunk => data += chunk);
    res.on("end", async () => {
      try {
        const job = JSON.parse(data);
        if (!job.job_id || !job.zip_url) {
          log("No jobs available.");
          return;
        }

        const jobName = job.job_id;
        const zipUrl = job.zip_url;
        const zipPath = path.join(TEMP_DIR, `${jobName}.zip`);
        const extractPath = path.join(TEMP_DIR, jobName);

        fs.rmSync(extractPath, { recursive: true, force: true });
        fs.mkdirSync(extractPath, { recursive: true });

        log(`Downloading job: ${jobName}`);
        await downloadJobZip(zipUrl, zipPath);

        log(`Extracting job...`);
        await extractZip(zipPath, extractPath);

        const projectRoot = findFlutterProjectRoot(extractPath);
        if (!projectRoot) {
          log("pubspec.yaml not found in any folder");
          await reportResult(jobName, "failed", null);
          return;
        }

        log("Running flutter pub get in: " + projectRoot);
        exec("flutter pub get", { cwd: projectRoot }, (err) => {
          if (err) {
            log(`pub get failed: ${err}`);
            reportResult(jobName, "failed", null, stderr || err.message);
            return;
          }

          const outputFile = path.join(OUTPUT_DIR, `${jobName}.app`);
          signAndBuild(projectRoot, outputFile, jobName, job.build_mode || "simulator");
        });

      } catch (err) {
        log("Error handling job: " + err.message);
        if (data.includes("job_id")) {
          try {
            const job = JSON.parse(data);
            if (job?.job_id) await reportResult(job.job_id, "failed", null);
          } catch {}
        }
      }
    });
  }).on("error", err => {
    log("Failed to contact API: " + err.message);
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

log("Agent started...");
fetchJobFromAPI();

function runPubGet(projectRoot) {
  return new Promise((resolve) => {
    exec("flutter pub get", { cwd: projectRoot }, (err) => {
      if (err) {
        log(`pub get failed: ${err}`);
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

function runWithRetry(taskFn, retries, onComplete) {
  let attempts = 0;

  async function attempt() {
    attempts++;
    const success = await taskFn();
    if (success) {
      onComplete(true);
    } else if (attempts <= retries) {
      log(`Retrying (${attempts}/${retries})...`);
      setTimeout(attempt, 2000);
    } else {
      log("Max retry attempts reached.");
      onComplete(false);
    }
  }

  attempt();
}