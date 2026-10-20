const crypto = require("node:crypto");
const { buildSnapshot, compareSnapshots } = require("../lib/core");
const { inferShareClass } = require("../lib/sources");
const { compareOfficialLimit } = require("../lib/official-pdf");

const MANAGERS = ["景顺长城", "广发", "国泰", "南方", "大成", "华夏", "易方达", "博时", "华安", "招商", "嘉实", "建信", "富国", "万家", "天弘", "汇添富", "摩根", "华泰柏瑞", "中欧", "鹏华", "中银", "长城"];
function decorate(row) {
  return Object.assign({}, row, {
    manager: MANAGERS.find((name) => row.name.startsWith(name)) || "其他",
    shareClass: row.shareClass || inferShareClass(row.name) || (row.name.replace(/\([^)]*\)/g, "").match(/([A-Z])(?:类)?人民币$/) || [])[1] || "",
    indexLabel: row.index === "nasdaq-tech" ? "纳斯达克科技" : "纳斯达克100"
  });
}

function publicRows(payload) {
  const sales = payload.rows.map((row) => decorate({
    index: row.index, code: row.code, name: row.name, currency: row.currency,
    channel: row.channel, channelBucket: row.channelBucket, shareClass: row.shareClass,
    status: row.decisionStatus || row.status,
    limitAmount: (row.decisionStatus || row.status) === "limited"
      ? (Number.isFinite(row.decisionLimitAmount) ? row.decisionLimitAmount : row.limitAmount) : null,
    sourceStatus: row.status, sourceLimitAmount: row.limitAmount,
    queriedAt: row.queriedAt, sourceUrl: row.sourceUrl,
    noticeUrl: row.officialNotice && row.officialNotice.url,
    basis: row.decisionBasis || "channel-only", availability: "public-sales-page"
  }));
  const direct = payload.rows.flatMap((row) => {
    const notice = row.officialNotice;
    if (!notice || !notice.parsed) return [];
    const result = compareOfficialLimit({ code: row.code, channel: "基金公司直销", status: "limited", limitAmount: null }, notice.parsed, payload.queriedAt, "Asia/Shanghai");
    const status = result.status === "official-suspended" ? "suspended" : result.status === "official-open" ? "open"
      : Number.isFinite(result.amount) && String(result.accountBasis).startsWith("single-fund-account-daily-cumulative")
        && !["not-comparable-channel", "pending", "unknown", "share-not-covered"].includes(result.status) ? "limited" : "unknown";
    // A missing or ambiguous direct-sale rule must never be interpreted as unlimited.
    if (status === "unknown") return [];
    return [decorate({
      index: row.index, code: row.code, name: row.name, currency: result.currency || row.currency,
      shareClass: row.shareClass, channel: "基金公司直销公告", channelBucket: "fund-manager-direct",
      status, limitAmount: status === "limited" ? result.amount : null,
      accountBasis: result.accountBasis || "unknown", effectiveDate: result.effectiveDate,
      queriedAt: payload.queriedAt, sourceUrl: result.noticeUrl || notice.url,
      noticeUrl: result.noticeUrl || notice.url, availability: "unverified"
    })];
  });
  return sales.concat(direct);
}

function createSnapshot(payload) {
  return buildSnapshot(payload.queriedAt, publicRows(payload));
}

function changeEvents(previous, snapshot) {
  return compareSnapshots(previous, snapshot).map((event) => {
    const id = crypto.createHash("sha256").update(JSON.stringify([snapshot.queriedAt, event])).digest("hex");
    return Object.assign({ id, detectedAt: snapshot.queriedAt }, event);
  });
}

function hasAmbiguousRows(payload) {
  return payload.rows.some((row) => (row.decisionStatus || row.status) === "unknown");
}

module.exports = { decorate, publicRows, createSnapshot, changeEvents, hasAmbiguousRows };
