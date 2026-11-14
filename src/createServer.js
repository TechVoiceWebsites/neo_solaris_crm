import http from "node:http";
import { app } from "./app.js";
import { initSocket } from "./socket/index.js";
import { startJobs } from "./jobs/followups.js";
// Request-listener server wrapped in http.createServer WITHOUT listen(): this is the shape
// Netlify Server documents for apps that need WebSockets (Socket.IO).
export function createCrmServer() {
  const server = http.createServer(app);
  initSocket(server);
  startJobs();
  return server;
}
