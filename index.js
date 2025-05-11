const fs = require("fs");
const path = require("path");
const { exec, execSync } = require("child_process");
const unzipper = require("unzipper");
const https = require("https");
const http = require("http");

const TEMP_DIR = path.join(__dirname, "temp");
const OUTPUT_DIR = path.join(__dirname, "outputs");
const API_URL = "https://macbridge-backend.onrender.com/jobs/next";

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

function runFlutterBuild(projectRoot, outputFile) {
  log("Running flutter build ios --release...");
  exec("flutter build ios --release", { cwd: projectRoot }, (err) => {
    if (err) return log(`Build failed: ${err}`);

    const ipaPath = path.join(projectRoot, "build/ios/iphoneos/Runner.app");
    if (fs.existsSync(ipaPath)) {
      fs.cpSync(ipaPath, outputFile, { recursive: true });
      log(`Build complete → ${outputFile}`);
    } else {
      log("Build completed, but .ipa not found.");
    }
  });
}

function runFlutterSimulatorBuild(projectRoot, outputFile) {
  log("Running flutter build ios --simulator...");
  exec("flutter build ios --simulator", { cwd: projectRoot }, (err) => {
    if (err) {
      log(`Simulator build failed: ${err}`);
      return;
    }

    const appPath = path.join(projectRoot, "build/ios/iphonesimulator/Runner.app");
    const simulatorOutput = outputFile.replace(".ipa", ".app");

    if (fs.existsSync(appPath)) {
      fs.cpSync(appPath, simulatorOutput, { recursive: true });
      log(`Simulator build complete → ${simulatorOutput}`);
    } else {
      log("Simulator build finished, but Runner.app not found.");
    }
  });
}

function signAndBuild(projectRoot, outputFile) {
  const testModePath = path.join(projectRoot, "test_mode.txt");
  log("Looking for test_mode.txt in: " + testModePath);
  const testMode = fs.existsSync(testModePath);

  if (testMode) {
    log("Test mode detected — building for iOS simulator...");
    return runFlutterSimulatorBuild(projectRoot, outputFile);
  }

  const certPath = path.join(projectRoot, "signing.p12");
  const profilePath = path.join(projectRoot, "profile.mobileprovision");
  const passPath = path.join(projectRoot, "password.txt");

  const hasSigning = fs.existsSync(certPath) && fs.existsSync(profilePath) && fs.existsSync(passPath);

  if (!hasSigning) {
    log("Code signing files not found — skipping signing and attempting normal build.");
    return runFlutterBuild(projectRoot, outputFile);
  }

  const password = fs.readFileSync(passPath, "utf-8").trim();

  try {
    log("Importing certificate...");
    execSync(`security import "${certPath}" -k ~/Library/Keychains/login.keychain-db -P "${password}" -T /usr/bin/codesign`);

    log("Copying provisioning profile...");
    execSync(`mkdir -p ~/Library/MobileDevice/Provisioning\\ Profiles/`);
    execSync(`cp "${profilePath}" ~/Library/MobileDevice/Provisioning\\ Profiles/`);

    return runFlutterBuild(projectRoot, outputFile);
  } catch (err) {
    log("Code signing failed: " + err.message);
  }
}

function downloadJobZip(url, destPath) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;

    function requestAndFollow(currentUrl) {
      const req = client.get(currentUrl, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
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
          return;
        }

        log("Running flutter pub get in: " + projectRoot);
        exec("flutter pub get", { cwd: projectRoot }, (err) => {
          if (err) return log(`pub get failed: ${err}`);
          const outputFile = path.join(OUTPUT_DIR, `${jobName}.ipa`);
          signAndBuild(projectRoot, outputFile);
        });

      } catch (err) {
        log("Error handling job: " + err.message);
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
