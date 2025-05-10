const fs = require("fs");
const path = require("path");
const { exec, execSync } = require("child_process");
const unzipper = require("unzipper");

const JOBS_DIR = path.join(__dirname, "jobs");
const OUTPUT_DIR = path.join(__dirname, "outputs");

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
      fs.copyFileSync(ipaPath, outputFile);
      log(`Build complete → ${outputFile}`);
    } else {
      log("Build completed, but .ipa not found.");
    }
  });
}

function runFlutterSimulatorBuild(projectRoot, outputFile) {
  log("Running flutter build ios --simulator...");
  exec("flutter build ios --simulator", { cwd: projectRoot }, (err, stdout, stderr) => {
    if (err) {
      log(`Simulator build failed: ${err}`);
      return;
    }

    const appPath = path.join(projectRoot, "build/ios/iphonesimulator/Runner.app");
    const simulatorOutput = outputFile.replace(".ipa", ".app");

    if (fs.existsSync(appPath)) {
      try {
        fs.cpSync(appPath, simulatorOutput, { recursive: true });
        log(`Simulator build complete → ${simulatorOutput}`);
      } catch (copyErr) {
        log(`Copy failed: ${copyErr.message}`);
      }
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

async function processJob(file) {
  const jobName = path.basename(file, ".zip");
  const jobPath = path.join(JOBS_DIR, file);
  const jobDir = path.join(__dirname, "temp", jobName);

  log(`Processing ${file}`);
  fs.rmSync(jobDir, { recursive: true, force: true }); // Clean old job folder
  fs.mkdirSync(jobDir, { recursive: true });
  await extractZip(jobPath, jobDir);

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

  const projectRoot = findFlutterProjectRoot(jobDir);
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
}

function watchJobs() {
  const jobs = fs.readdirSync(JOBS_DIR).filter(file => file.endsWith(".zip"));
  if (jobs.length === 0) {
    log("No jobs to process.");
    return;
  }

  jobs.forEach(file => {
    processJob(file);
  });
}

log("Agent started...");
watchJobs();
