import { createCrmServer } from "./createServer.js";
import { env } from "./config/env.js";
createCrmServer().listen(env.port, () => console.log(`CRM API on :${env.port}`));
