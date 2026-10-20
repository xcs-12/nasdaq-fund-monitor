const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = process.cwd();
const checkout = path.join(root, ".watch-data");
const state = path.resolve(process.env.WATCH_STATE_DIR || path.join(root, "runtime"));
function git(args, cwd = root) { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function restore() {
  // Only a genuinely missing remote branch creates a new baseline. Network/auth failures stop the run.
  const exists = git(["ls-remote", "--heads", "origin", "monitor-data"]);
  fs.mkdirSync(state, { recursive: true });
  if (exists) {
    git(["fetch", "origin", "monitor-data"]);
    git(["worktree", "add", "--detach", checkout, "FETCH_HEAD"]);
    if (!fs.existsSync(path.join(checkout, "watch-state.json"))) throw new Error("持久化分支缺少状态文件");
    fs.cpSync(checkout, state, { recursive: true, filter: (name) => path.basename(name) !== ".git" });
  } else {
    fs.mkdirSync(checkout, { recursive: true });
    git(["init", "--initial-branch=monitor-data"], checkout);
    git(["remote", "add", "origin", git(["remote", "get-url", "origin"])], checkout);
    // The checkout's authenticated extra header is kept only in the runner's local Git config.
    const key = "http.https://github.com/.extraheader";
    let header = "";
    try { header = git(["config", "--get", key]); } catch { /* Local repositories need no HTTP header. */ }
    if (header) git(["config", key, header], checkout);
  }
}
function save() {
  if (!fs.existsSync(path.join(state, "watch-state.json"))) throw new Error("没有有效运行状态，停止保存");
  fs.cpSync(state, checkout, { recursive: true });
  git(["config", "user.name", "nasdaq-monitor[bot]"], checkout);
  git(["config", "user.email", "nasdaq-monitor@users.noreply.github.com"], checkout);
  git(["add", "."], checkout);
  if (git(["diff", "--cached", "--name-only"], checkout)) {
    git(["commit", "-m", "Update monitor state"], checkout);
    git(["push", "origin", "HEAD:refs/heads/monitor-data"], checkout);
  }
}
try {
  if (process.argv[2] === "restore") restore();
  else if (process.argv[2] === "save") save();
  else throw new Error("不支持的操作");
  console.log("持久化状态操作完成。");
} catch {
  console.error("持久化状态失败：停止运行以避免丢失基线或重复通知。请检查分支与仓库写权限。");
  process.exitCode = 1;
}
