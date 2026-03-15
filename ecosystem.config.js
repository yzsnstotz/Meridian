const path = require("node:path");

const LOG_DIR = process.env.LOG_DIR || "/var/log/hub";
const HUB_SOCKET_PATH = process.env.HUB_SOCKET_PATH || "/tmp/hub-socks/hub-core.sock";
const ROOT_DIR = __dirname;

const baseApp = {
  cwd: ROOT_DIR,
  interpreter: "node",
  exec_mode: "fork",
  instances: 1,
  merge_logs: true,
  autorestart: true,
  max_restarts: 10,
  restart_delay: 3000,
  kill_timeout: 10000,
  env: {
    NODE_ENV: "production",
    LOG_LEVEL: process.env.LOG_LEVEL || "info",
    LOG_DIR,
    HUB_SOCKET_PATH,
    AGENT_WORKDIR: process.env.AGENT_WORKDIR
  }
};

module.exports = {
  apps: [
    {
      ...baseApp,
      name: "calling-hub",
      script: "./dist/hub/index.js",
      out_file: path.join(LOG_DIR, "hub.log"),
      error_file: path.join(LOG_DIR, "hub-error.log")
    },
    {
      ...baseApp,
      name: "calling-interface",
      script: "./dist/interface/index.js",
      out_file: path.join(LOG_DIR, "interface.log"),
      error_file: path.join(LOG_DIR, "interface-error.log")
    },
    {
      ...baseApp,
      name: "calling-monitor",
      script: "./dist/monitor/index.js",
      out_file: path.join(LOG_DIR, "monitor.log"),
      error_file: path.join(LOG_DIR, "monitor-error.log")
    },
    {
      ...baseApp,
      name: "calling-web",
      script: "./dist/web/server.js",
      out_file: path.join(LOG_DIR, "web.log"),
      error_file: path.join(LOG_DIR, "web-error.log")
    }
  ]
};
