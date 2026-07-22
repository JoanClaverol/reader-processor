#!/usr/bin/env node
// reader-process — start the dashboard on the first free port and open it.
// reader-process auth — run the one-time Gmail OAuth flow.
"use strict";

const { existsSync } = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const DIST = path.join(__dirname, "..", "dist-server");

if (!existsSync(path.join(DIST, "index.js"))) {
  console.error("Build output missing. Run `pnpm install` in the reader-processor checkout first.");
  process.exit(1);
}

const command = process.argv[2];
if (command === "auth") {
  require(path.join(DIST, "auth.js"));
  return;
}
if (command !== undefined) {
  console.error(`Unknown command: ${command}\nUsage: reader-process [auth]`);
  process.exit(1);
}

function findFreePort(start) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", (err) => {
      if (err.code === "EADDRINUSE") resolve(findFreePort(start + 1));
      else reject(err);
    });
    srv.listen(start, "127.0.0.1", () => {
      srv.close(() => resolve(start));
    });
  });
}

function openInBrowser(url) {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  const child = spawn(cmd, [url], {
    shell: process.platform === "win32",
    stdio: "ignore",
    detached: true,
  });
  child.on("error", () => console.log(`Open the dashboard yourself: ${url}`));
  child.unref();
}

function openWhenReady(url, attempts) {
  if (attempts <= 0) return;
  http
    .get(url, (res) => {
      res.resume();
      openInBrowser(url);
    })
    .on("error", () => setTimeout(() => openWhenReady(url, attempts - 1), 500));
}

findFreePort(Number(process.env.PORT || 8377)).then((port) => {
  process.env.PORT = String(port);
  console.log(`Starting reader-processor on http://localhost:${port} (Ctrl-C to stop)`);
  if (!process.env.NO_OPEN) openWhenReady(`http://localhost:${port}/`, 30);
  require(path.join(DIST, "index.js"));
});
