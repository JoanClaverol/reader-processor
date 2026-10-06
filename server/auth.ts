// One-time interactive Gmail OAuth flow:  reader-process auth
// (Only needed if data/token.json is missing — a token saved by the earlier
// Python version keeps working.)
import http from "http";
import { mkdirSync, writeFileSync } from "fs";
import { spawn } from "child_process";
import { randomBytes } from "crypto";
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

  // state ties the callback to this run; PKCE ties the code to this process,
  // so a code injected by anything else on the machine is useless.
  const state = randomBytes(16).toString("hex");
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state,
    code_challenge: codeChallenge,
    // google-auth-library's CodeChallengeMethod.S256, without importing the
    // transitive package directly.
    code_challenge_method: "S256" as never,
  });
  console.log("Opening browser for Google sign-in…");
  openInBrowser(authUrl);

  const code = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for Google sign-in (10 minutes).")),
      10 * 60 * 1000,
    );
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", redirectUri);
      // Favicon fetches, port probes and stale tabs used to abort the flow;
      // only a callback carrying our state counts.
      if (url.pathname !== "/" || url.searchParams.get("state") !== state) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.end(code ? "Authenticated — you can close this tab." : `Sign-in failed: ${error ?? "no code"}`);
      clearTimeout(timeout);
      if (code) resolve(code);
      else reject(new Error(`Google sign-in failed: ${error ?? "no code in callback"}`));
    });
  });
  server.close();

  const { tokens } = await client.getToken({ code, codeVerifier });
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  // Owner-only: this token grants read/send access to the Gmail account.
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  console.log(`Authenticated. Token saved to ${TOKEN_PATH}`);
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
