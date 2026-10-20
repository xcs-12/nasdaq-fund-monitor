const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { execFileSync, spawnSync } = require("node:child_process");
const nodemailer = require("nodemailer");
const { sendMail } = require("../scripts/watch/mail");
const { check } = require("../scripts/watch/run");

test("real Nodemailer exchanges SMTP commands with a local simulated server", async (t) => {
  let received = "";
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.write("220 localhost mock SMTP\r\n");
    let buffer = "", data = false;
    socket.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        if (data) {
          if (line === ".") { data = false; socket.write("250 Message accepted\r\n"); }
          else received += line + "\n";
        } else if (/^EHLO|^HELO/.test(line)) socket.write("250 localhost\r\n");
        else if (/^MAIL FROM|^RCPT TO/.test(line)) socket.write("250 OK\r\n");
        else if (line === "DATA") { data = true; socket.write("354 Send body\r\n"); }
        else if (line === "QUIT") { socket.end("221 Bye\r\n"); }
        else socket.write("250 OK\r\n");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const env = { SMTP_HOST: "smtp.example.com", SMTP_PORT: "465", SMTP_USER: "sender@example.com", SMTP_PASS: "placeholder", MAIL_FROM: "sender@example.com", MAIL_TO: "receiver@example.com" };
  await sendMail([], { env, test: true, createTransport: (production) => {
    assert.equal(production.requireTLS, true);
    assert.equal(production.tls.rejectUnauthorized, true);
    // Only the in-process loopback mock uses cleartext; production settings are tested separately.
    return nodemailer.createTransport({ host: "127.0.0.1", port: server.address().port, secure: false, ignoreTLS: true });
  } });
  assert.match(received, /To: receiver@example.com/);
  assert.match(received, /Subject:/);
});

test("persistent branch roundtrip keeps baseline and pending events across clean runners", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nasdaq-git-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, "remote.git");
  const one = path.join(root, "one"), two = path.join(root, "two");
  function git(args, cwd = root) { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  git(["init", "--bare", remote]);
  const script = path.resolve(__dirname, "../scripts/watch/state-branch.js");
  function setup(directory) {
    fs.mkdirSync(directory);
    git(["init", "--initial-branch=main"], directory);
    git(["remote", "add", "origin", remote], directory);
  }
  function action(directory, name) {
    return spawnSync(process.execPath, [script, name], { cwd: directory, env: { ...process.env, WATCH_STATE_DIR: path.join(directory, "runtime") }, encoding: "utf8" });
  }
  setup(one);
  assert.equal(action(one, "restore").status, 0);
  const state = { version: 1, pending: [{ id: "test-event" }], snapshot: { queriedAt: "2026-10-20" } };
  fs.writeFileSync(path.join(one, "runtime/watch-state.json"), JSON.stringify(state));
  assert.equal(action(one, "save").status, 0);
  setup(two);
  const restored = action(two, "restore");
  assert.equal(restored.status, 0, restored.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(two, "runtime/watch-state.json"))), state);
  assert.equal(action(two, "save").status, 0);
});

test("invalid persisted JSON never resets the notification baseline", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nasdaq-corrupt-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "watch-state.json");
  fs.writeFileSync(file, "{broken");
  await assert.rejects(check({ stateDir: root, query: async () => { throw Error("must not query"); } }));
  assert.equal(fs.readFileSync(file, "utf8"), "{broken");
});
