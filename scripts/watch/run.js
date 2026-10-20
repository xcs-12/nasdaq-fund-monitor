const fs = require("node:fs");
const path = require("node:path");
const { runQuery, readJson, writeAtomic } = require("../lib/query");
const { createSnapshot, changeEvents, hasAmbiguousRows } = require("./model");
const { sendMail } = require("./mail");

const ROOT = path.resolve(__dirname, "../..");
function locations(options = {}) {
  const stateDir = path.resolve(options.stateDir || process.env.WATCH_STATE_DIR || path.join(ROOT, "runtime"));
  const webDir = path.resolve(options.webDir || process.env.WATCH_WEB_DIR || path.join(ROOT, "web/data"));
  return { stateDir, webDir, stateFile: path.join(stateDir, "watch-state.json") };
}
function save(file, value) { writeAtomic(file, JSON.stringify(value, null, 2) + "\n"); }
function loadState(file) {
  if (!fs.existsSync(file)) return { version: 1, events: [], pending: [], history: [] };
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!state || !Array.isArray(state.history) || (state.pending && !Array.isArray(state.pending))) throw new Error("状态文件损坏，停止运行以保护基线");
  return state;
}

function exportWeb(state, webDir) {
  const latest = {
    schemaVersion: 1, lastAttemptAt: state.lastAttemptAt || null,
    lastSuccessAt: state.snapshot && state.snapshot.queriedAt || null,
    health: state.health || "pending", rows: state.snapshot && state.snapshot.rows || [],
    recentChanges: state.events || [],
    coverage: state.coverage || null,
    message: state.health === "ok" ? "" : "本次检查未完成，以下保留最近一次有效数据。"
  };
  save(path.join(webDir, "latest.json"), latest);
  save(path.join(webDir, "history.json"), state.history || []);
}

async function check(options = {}) {
  const dirs = locations(options);
  const state = loadState(dirs.stateFile);
  const at = options.now || new Date().toISOString();
  state.lastAttemptAt = at;
  let payload;
  try {
    payload = await (options.query || runQuery)({
      index: "all", includeUsd: false, includeEtf: false, watchNasdaq: true,
      outputDir: path.join(dirs.stateDir, "core"), save: true,
      officialNotices: true, officialNoticeCacheHours: 0, historyLimit: 90,
      queriedAt: at, concurrency: 2, retries: 1
    });
    if (payload.health.status !== "ok" || payload.exitCode !== 0 || !payload.rows.length || hasAmbiguousRows(payload)
      || payload.officialNotices && (payload.officialNotices.unparsed || payload.officialNotices.unresolvedFundCount)) throw new Error("incomplete");
    const snapshot = createSnapshot(payload);
    const salesCodes = new Set(snapshot.rows.filter((row) => row.channelBucket === "sales-agency").map((row) => row.code));
    if (state.snapshot && state.snapshot.rows.some((row) => row.channelBucket === "fund-manager-direct"
      && salesCodes.has(row.code) && !snapshot.byKey[row.key])) {
      // A missing/changed rule basis is not evidence that direct-sale access was removed.
      throw new Error("direct-rule-no-longer-comparable");
    }
    const changes = changeEvents(state.snapshot, snapshot);
    const pending = new Map((state.pending || []).map((event) => [event.id, event]));
    changes.forEach((event) => pending.set(event.id, event));
    state.pending = [...pending.values()];
    state.snapshot = snapshot;
    state.health = "ok";
    state.events = changes.concat(state.events || []).slice(0, 1000);
    state.coverage = {
      expected: payload.health.expected, checked: payload.health.checked,
      managers: Object.fromEntries(["广发", "国泰", "南方", "大成", "景顺长城"].map((manager) => [manager, snapshot.rows.filter((row) => row.channelBucket === "sales-agency" && row.manager === manager).length]))
    };
    state.history = [{ queriedAt: at, health: "ok", rows: snapshot.rows, changes }].concat(state.history || []).slice(0, 90);
  } catch {
    state.health = "error";
    state.history = [{ queriedAt: at, health: "error", rows: [], changes: [] }].concat(state.history || []).slice(0, 90);
  }
  // Save the outbox before any SMTP operation. A failed query never replaces the baseline.
  save(dirs.stateFile, state);
  exportWeb(state, dirs.webDir);
  return state.health === "ok" ? 0 : 2;
}

async function deliver(options = {}) {
  const dirs = locations(options);
  const state = fs.existsSync(dirs.stateFile) ? loadState(dirs.stateFile) : null;
  if (!state || !state.pending || !state.pending.length) return { sent: 0 };
  try {
    await (options.send || sendMail)(state.pending);
    const count = state.pending.length;
    state.lastMail = { status: "accepted", at: new Date().toISOString(), count };
    state.pending = [];
    save(dirs.stateFile, state);
    return { sent: count };
  } catch {
    state.lastMail = { status: "failed", at: new Date().toISOString() };
    save(dirs.stateFile, state);
    throw new Error("邮件发送失败，待发送事件已保留；请检查 Secrets、SMTP 服务和收件地址。");
  }
}

async function main() {
  const action = process.argv[2] || "check";
  if (action === "check") {
    process.exitCode = await check();
    console.log(process.exitCode ? "数据不完整，保留原基线。" : "检查完成，公开数据与待发送事件已保存。");
  } else if (action === "send") {
    const result = await deliver();
    console.log(`邮件处理完成，发送 ${result.sent} 条变化。`);
  } else if (action === "test-mail") {
    await sendMail([], { test: true });
    console.log("测试邮件已被 SMTP 接受，请在收件箱确认。");
  } else if (action === "export") {
    const dirs = locations();
    exportWeb(readJson(dirs.stateFile, {}), dirs.webDir);
  } else throw new Error("不支持的操作");
}
if (require.main === module) main().catch(() => {
  console.error("任务失败。请检查配置和数据源；邮件失败时事件会保留至下次重试。");
  process.exitCode = 1;
});
module.exports = { check, deliver, exportWeb, locations };
