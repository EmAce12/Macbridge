BUILD BOX — THE BIG IDEA

What Is BuildBox?

BuildBox is a cloud-based iOS build platform made by devs, for devs — specifically for:
	•	Flutter and cross-platform developers
	•	Windows users who don’t own a Mac
	•	Hobby devs and indie builders who can’t afford an Apple Developer account (yet)

It provides a simple, fast way to build iOS apps remotely, get the .ipa file, and test or even distribute apps — without owning a Mac or deep knowledge of DevOps.




THE VISION

“BuildBox removes the Apple wall and gives every developer a chance to build for iOS.”




CORE LAYERS OF THE SYSTEM

1. BuildBox Agent (Mac Side)

Purpose: Turns a Mac (like your MacBook) into a build worker.
	•	Listens for build jobs from the server
	•	Pulls the project (ZIP or GitHub)
	•	Installs dependencies
	•	Injects the user’s certificate & provisioning profile
	•	Builds the .ipa using flutter build ios --release
	•	Uploads the result and cleans up
	•	Reports status back

This agent will also power the community Mac network, where others can install it and earn credits by letting their Mac process builds.




2. Backend Server (Cloud Side)

Purpose: The brain of the system.
	•	Receives project uploads or GitHub links from users
	•	Stores certificates, provisioning profiles securely
	•	Handles build job queue
	•	Matches available BuildBox agents to pending jobs
	•	Tracks job status, build history, and errors
	•	Sends notifications or real-time updates to users

It connects users to agents and coordinates the entire infrastructure.




3. Frontend Dashboard (User Side)

Purpose: Where users interact with BuildBox.
	•	Sign up / Log in (Email, GitHub, Google)
	•	Upload Flutter project or connect GitHub repo
	•	Upload certificates & provisioning profile
	•	Click “Build iOS”
	•	View build logs, status, and download .ipa
	•	Manage past builds
	•	Community features (optional in future)

It’s clean, dev-friendly, and removes the need to touch CI config or Fastlane.



4. Community Mac Sharing Network (Future Layer)

Purpose: Power BuildBox with the community.
	•	Anyone with a Mac can install the agent
	•	They set availability (e.g. overnight, weekends)
	•	When their Mac is used for builds, they earn credits or money
	•	This allows BuildBox to scale without expensive Mac cloud servers

Think of it as Airbnb for build power — made by developers, run by developers.




5. Membership & Hobby Dev Support (Add-on Layer)

Purpose: Help devs without Apple Developer accounts.
	•	Devs can pay for temporary access to BuildBox’s Apple Dev account (for testing only)
	•	Use BuildBox to build & test apps for 1 week
	•	After 1 week, builds are disabled unless they use their own Apple Developer account
	•	This allows them to test ideas before spending $99/year on Apple

This makes the platform accessible to students, beginners, and side hustlers.



IN SUMMARY

BuildBox = An ecosystem made up of:
	•	Build Agents (Macs): to build the apps
	•	Backend Server: to manage logic, job routing, and storage
	•	Frontend Dashboard: to let users upload projects and trigger builds
	•	Community Layer: to scale the Mac power organically
	•	Membership Model: to help hobbyists access iOS testing before going pro
