import { registerServiceProcess, unregisterServiceProcess } from "../../index";
const service = process.env.FIXTURE_SERVICE === "web" ? "web" : process.env.FIXTURE_SERVICE === "brain" ? "brain" : "agent";
if (process.env.FIXTURE_FAIL) process.exit(3);
console.log(JSON.stringify({ argv: process.argv.slice(2) }));
if (process.env.FIXTURE_WEB_ENV) console.log(JSON.stringify({ webDist: process.env.COLEO_WEB_DIST, apiUrl: process.env.COLEO_API_URL }));
if (process.env.FIXTURE_NO_READY) console.log(`unready PID ${process.pid}`);
if (!process.env.FIXTURE_NO_READY) await registerServiceProcess(service);
setInterval(() => {}, 1000);
process.on("SIGTERM", async () => {
  if (process.env.FIXTURE_IGNORE_STOP) return;
  await unregisterServiceProcess(service);
  process.exit(0);
});
