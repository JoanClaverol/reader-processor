// One-time interactive Gmail OAuth flow:  reader-process auth
// (Only needed if data/token.json is missing — a token saved by the earlier
// Python version keeps working.)
import http from "http";
import { mkdirSync, writeFileSync } from "fs";
import { spawn } from "child_process";
import { DATA_DIR } from "./config";
import { makeOAuthClient, SCOPES, TOKEN_PATH } from "./gmail";

function openInBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  const child = spawn(cmd, [url], {
    shell: process.platform === "win32",
    stdio: "ignore",
    detached: true,
  });
  child.on("error", () => {
    console.log(`Couldn't open a browser automatically. Open this URL yourself:\n${url}`);
  });
  child.unref();
}

async function main(): Promise<void> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://localhost:${port}/`;
  const client = makeOAuthClient(redirectUri);

  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });
  console.log("Opening browser for Google sign-in…");
  openInBrowser(authUrl);

  const code = await new Promise<string>((resolve, reject) => {
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", redirectUri);
      const code = url.searchParams.get("code");
      res.end(code ? "Authenticated — you can close this tab." : "Missing code.");
      if (code) resolve(code);
      else reject(new Error(`No code in callback: ${req.url}`));
    });
  });
  server.close();

  const { tokens } = await client.getToken(code);
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  // Owner-only: this token grants read/send access to the Gmail account.
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  console.log(`Authenticated. Token saved to ${TOKEN_PATH}`);
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
