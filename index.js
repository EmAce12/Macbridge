const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const unzipper = require("unzipper");

const JOBS_DIR = path.join(__dirname, "jobs");
const OUTPUT_DIR = path.join(__dirname, "outputs");

function log(msg) {
  console.log(`[MacBridge Agent] ${msg}`);
}

const unzip = require("unzipper");

async function extractZip(zipPath, destPath) {
  return new Promise((resolve, reject) => {
    fs.createReadStream(zipPath)
      .pipe(unzip.Parse())
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

async function processJob(file) {
    const jobName = path.basename(file, ".zip");
    const jobPath = path.join(JOBS_DIR, file);
    const jobDir = path.join(__dirname, "temp", jobName);
  
    log(`Processing ${file}`);
  
    fs.mkdirSync(jobDir, { recursive: true });
    // await fs.createReadStream(jobPath)
    //   .pipe(unzipper.Extract({ path: jobDir }))
    //   .promise();
    await extractZip(jobPath, jobDir);
  
    // Smart recursive search
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
  
      exec("flutter build ios --release", { cwd: projectRoot }, (err) => {
        if (err) return log(`Build failed: ${err}`);
  
        const ipaPath = path.join(projectRoot, "build/ios/iphoneos/Runner.app");
        if (fs.existsSync(ipaPath)) {
          const outputFile = path.join(OUTPUT_DIR, `${jobName}.ipa`);
          fs.copyFileSync(ipaPath, outputFile);
          log(`Build complete → ${outputFile}`);
        } else {
          log("Build completed, but .ipa not found.");
        }
      });
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
