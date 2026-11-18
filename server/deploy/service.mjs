import { chdir } from "node:process";
import { fileURLToPath } from "node:url";

const role = process.argv[2];
if (!["app", "worker"].includes(role) || process.env.ABORDER_HOSTED !== "1") throw new Error("Invalid hosted service configuration.");
process.env.NODE_ENV = "production";
process.env.HOSTNAME = "127.0.0.1";
process.env.PORT = "18330";
process.env.ABORDER_MANAGED = "0";
process.env.WORKER_MODE = role === "app" ? "off" : "worker";
process.env.WORKER_LONG_CONCURRENCY = "1";
process.env.WORKER_SHORT_CONCURRENCY = "1";
process.env.WORKER_SHUTDOWN_GRACE_SECONDS = "35";
const app = new URL("../../app/", import.meta.url);
chdir(fileURLToPath(app));
await import(new URL(role === "app" ? "server.js" : "worker.cjs", app));
