const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { check, deliver } = require("../scripts/watch/run");
const { createSnapshot, changeEvents, publicRows } = require("../scripts/watch/model");
const { smtpSettings, buildMail, sendMail } = require("../scripts/watch/mail");
const { parseFundCatalog } = require("../scripts/lib/sources");
const { runQuery } = require("../scripts/lib/query");
const { filterRows, healthText, escape, safeUrl, rowHtml } = require("../web/app");

function dirs(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nasdaq-watch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { stateDir: path.join(root, "state"), webDir: path.join(root, "web") };
}
function payload(amount = 100, status = "limited", at = "2026-10-20T01:10:00.000Z") {
  return { queriedAt: at, health: { status: "ok", expected: 1, checked: 1 }, exitCode: 0,
    rows: [{ code: "270042", name: "广发纳斯达克100ETF联接人民币(QDII)A", index: "nasdaq100", currency: "CNY",
      channel: "天天基金公开销售页", channelBucket: "sales-agency", status, limitAmount: status === "limited" ? amount : null,
      queriedAt: at, sourceUrl: "https://fund.eastmoney.com/270042.html" }] };
}
const env = { SMTP_HOST: "smtp.example.com", SMTP_PORT: "465", SMTP_USER: "sender@example.com", SMTP_PASS: "test-only-not-a-real-secret", MAIL_FROM: "sender@example.com", MAIL_TO: "receiver@example.com", SITE_URL: "https://example.com/watch/" };

test("watch includes technology RMB OTC shares while default catalog remains unchanged", async (t) => {
  const data = "var r = " + JSON.stringify([
    ["270042", "", "广发纳斯达克100ETF联接人民币(QDII)A"],
    ["017091", "", "景顺长城纳斯达克科技ETF联接(QDII)A人民币"],
    ["017093", "", "景顺长城纳斯达克科技ETF联接(QDII)C人民币"],
    ["017092", "", "景顺长城纳斯达克科技ETF联接(QDII)A美元"],
    ["159509", "", "景顺长城纳斯达克科技ETF(QDII)"],
    ["017641", "", "摩根标普500指数(QDII)人民币A"]
  ]) + ";";
  assert.equal(parseFundCatalog(data).some((fund) => fund.index === "nasdaq-tech"), false);
  const result = await runQuery({ outputDir: dirs(t).stateDir, watchNasdaq: true, save: false,
    fetchText: async (url) => url.includes("fundcode_search") ? data : "交易状态：开放申购，开放赎回" });
  assert.deepEqual(result.rows.map((row) => row.code), ["270042", "017091", "017093"]);
  assert.equal(result.rows[1].index, "nasdaq-tech");
});

test("initial check makes no mail, later change persists outbox, retry succeeds without duplication", async (t) => {
  const options = dirs(t);
  await check({ ...options, query: async () => payload() });
  assert.equal((await deliver({ ...options, send: async () => { throw Error("must not send"); } })).sent, 0);
  const next = payload(200, "limited", "2026-10-20T06:30:00.000Z");
  await check({ ...options, now: next.queriedAt, query: async () => next });
  let state = JSON.parse(fs.readFileSync(path.join(options.stateDir, "watch-state.json")));
  assert.equal(state.pending.length, 1);
  assert.equal(state.pending[0].type, "amount-increased");
  await assert.rejects(deliver({ ...options, send: async () => { throw Error("SMTP unavailable"); } }), /邮件发送失败/);
  await check({ ...options, query: async () => next });
  let sends = 0;
  const send = async (events) => { sends++; assert.equal(events.length, 1); };
  assert.equal((await deliver({ ...options, send })).sent, 1);
  assert.equal((await deliver({ ...options, send })).sent, 0);
  assert.equal(sends, 1);
  state = JSON.parse(fs.readFileSync(path.join(options.stateDir, "watch-state.json")));
  assert.equal(state.lastMail.status, "accepted");
  const published = fs.readFileSync(path.join(options.webDir, "latest.json"), "utf8");
  assert.doesNotMatch(published, /SMTP|MAIL_TO|receiver@example|pending|lastMail/);
});

test("incomplete/throwing queries retain baseline and produce no missing-record events", async (t) => {
  const options = dirs(t);
  await check({ ...options, query: async () => payload() });
  const original = JSON.parse(fs.readFileSync(path.join(options.stateDir, "watch-state.json"))).snapshot;
  for (const query of [async () => ({ ...payload(), health: { status: "partial" } }), async () => ({ ...payload(), officialNotices: { unparsed: 1 } }), async () => payload(0, "unknown"), async () => { throw Error("network"); }]) {
    assert.equal(await check({ ...options, query }), 2);
    const state = JSON.parse(fs.readFileSync(path.join(options.stateDir, "watch-state.json")));
    assert.deepEqual(state.snapshot, original);
    assert.equal(state.pending.length, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(options.webDir, "latest.json"))).health, "error");
  }
});

test("up/down, pause/resume, added/removed are compared without NAV noise", () => {
  const before = createSnapshot(payload());
  assert.equal(changeEvents(before, createSnapshot(payload(50)))[0].type, "amount-decreased");
  assert.equal(changeEvents(before, createSnapshot(payload(150)))[0].type, "amount-increased");
  const paused = createSnapshot(payload(null, "suspended"));
  assert.equal(changeEvents(before, paused)[0].type, "status-changed");
  assert.equal(changeEvents(paused, before)[0].after.status, "limited");
  const more = payload(); more.rows.push({ ...more.rows[0], code: "006479", name: "广发纳斯达克100ETF联接C" });
  assert.equal(changeEvents(before, createSnapshot(more))[0].type, "channel-added");
  assert.equal(changeEvents(createSnapshot(more), before)[0].type, "channel-removed");
  const nav = payload(); nav.rows[0].nav = 999;
  assert.equal(changeEvents(before, createSnapshot(nav)).length, 0);
});

test("direct-sale rules stay separate, include pauses, never imply actual availability", () => {
  const source = payload();
  source.rows[0].officialNotice = { url: "https://fund.eastmoney.com/notice.html", parsed: { parsed: true, effectiveDate: "2026-10-01",
    accountBasis: "single-fund-account-daily-cumulative", limits: [{ scope: "fund-manager-direct", perShareLimits: { "270042": { amount: 1000, currency: "CNY" } }, perShareStatuses: {} }] } };
  const rows = publicRows(source);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].limitAmount, 100);
  assert.equal(rows[1].limitAmount, 1000);
  assert.equal(rows[1].availability, "unverified");
  const tech = payload();
  tech.rows[0].name = "景顺长城纳斯达克科技ETF联接(QDII)C人民币";
  assert.equal(publicRows(tech)[0].shareClass, "C");
  const before = createSnapshot(source);
  source.rows[0].officialNotice.parsed.limits[0].perShareLimits["270042"].amount = 2000;
  const events = changeEvents(before, createSnapshot(source));
  assert.equal(events.length, 1);
  assert.equal(events[0].after.channelBucket, "fund-manager-direct");
  source.rows[0].officialNotice.parsed.limits[0].perShareLimits = {};
  source.rows[0].officialNotice.parsed.limits[0].perShareStatuses = { "270042": "suspended" };
  assert.equal(publicRows(source)[1].status, "suspended");
});

test("SMTP uses verified TLS, renders merged events, and rejects partial acceptance", async () => {
  assert.equal(smtpSettings(env).secure, true);
  const starttls = smtpSettings({ ...env, SMTP_PORT: "587" });
  assert.equal(starttls.secure, false);
  assert.equal(starttls.requireTLS, true);
  assert.equal(starttls.tls.rejectUnauthorized, true);
  assert.throws(() => smtpSettings({ ...env, SMTP_PORT: "25" }), /TLS/);
  assert.throws(() => smtpSettings({}), /Secrets/);
  const events = changeEvents(createSnapshot(payload()), createSnapshot(payload(500)));
  const mail = buildMail(events.concat(events), env);
  assert.match(mail.subject, /2 条/);
  assert.match(mail.text, /100元 -> 500元/);
  assert.match(mail.text, /来源：https:\/\/fund/);
  assert.match(buildMail([], env, true).subject, /测试/);
  let closed = false;
  await sendMail(events, { env, createTransport: () => ({ sendMail: async () => ({ accepted: [env.MAIL_TO], rejected: [] }), close: () => { closed = true; } }) });
  assert.equal(closed, true);
  await assert.rejects(sendMail(events, { env, createTransport: () => ({ sendMail: async () => ({ accepted: [], rejected: [env.MAIL_TO] }) }) }));
});

test("UI filtering/sorting, stale detection and HTML/link safety", () => {
  const rows = [50, 500].map((value) => publicRows(payload(value))[0]);
  rows[1].code = "006479";
  const filters = { channel: "sales-agency", sort: "desc", search: "广发", manager: "广发", status: "limited" };
  assert.equal(filterRows(rows, filters)[0].limitAmount, 500);
  assert.equal(filterRows(rows, { ...filters, sort: "asc" })[0].limitAmount, 50);
  assert.equal(filterRows(rows, { ...filters, channel: "fund-manager-direct" }).length, 0);
  assert.equal(filterRows(rows, { ...filters, search: "006479" }).length, 1);
  assert.equal(healthText({ lastSuccessAt: "2026-10-18T00:00:00Z", health: "ok" }, Date.parse("2026-10-20T00:00:00Z")).warning, true);
  assert.equal(healthText({ lastSuccessAt: null }).warning, true);
  assert.equal(safeUrl("javascript:alert(1)"), "");
  assert.equal(escape("<script>"), "&lt;script&gt;");
  assert.doesNotMatch(rowHtml({ ...rows[0], name: "<img src=x>", sourceUrl: "javascript:alert(1)" }), /<img|href="javascript/);
});

test("history keeps exactly the latest 90 checks", async (t) => {
  const options = dirs(t);
  fs.mkdirSync(options.stateDir, { recursive: true });
  fs.writeFileSync(path.join(options.stateDir, "watch-state.json"), JSON.stringify({ history: Array(90).fill({ queriedAt: "2026-01-01", health: "error", rows: [], changes: [] }) }));
  await check({ ...options, query: async () => payload() });
  assert.equal(JSON.parse(fs.readFileSync(path.join(options.webDir, "history.json"))).length, 90);
});
