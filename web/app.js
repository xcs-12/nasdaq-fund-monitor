(function () {
  const STATUS = { open: "开放申购", limited: "限额申购", suspended: "暂停申购", unavailable: "暂不可申购", unknown: "暂未确认" };
  const TYPES = { "amount-increased": "额度提高", "amount-decreased": "额度降低", "amount-changed": "额度变化", "status-changed": "状态变化", "channel-added": "新增记录", "channel-removed": "记录移除" };
  const escape = (text) => String(text == null ? "" : text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const time = (iso) => iso && Number.isFinite(Date.parse(iso)) ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso)) : "尚无记录";
  function amount(row) {
    if (!row) return "无记录";
    if (row.status === "open") return "未显示上限";
    if (row.status !== "limited") return STATUS[row.status] || "暂未确认";
    return Number.isFinite(row.limitAmount) ? `${row.limitAmount.toLocaleString("zh-CN")} 元` : "额度未知";
  }
  function filterRows(rows, filters) {
    const result = rows.filter((row) => row.channelBucket === filters.channel && (!filters.manager || row.manager === filters.manager)
      && (!filters.status || row.status === filters.status) && `${row.name} ${row.code}`.toLowerCase().includes((filters.search || "").trim().toLowerCase()));
    const rank = (row) => row.status === "open" ? Infinity : row.status === "limited" && Number.isFinite(row.limitAmount) ? row.limitAmount : null;
    return result.sort((a, b) => {
      if (filters.sort === "name") return a.name.localeCompare(b.name, "zh-CN");
      const left = rank(a), right = rank(b);
      if (left === null && right !== null) return 1;
      if (right === null && left !== null) return -1;
      if (left !== right && left !== null && right !== null) return (left < right ? -1 : 1) * (filters.sort === "asc" ? 1 : -1);
      return a.code.localeCompare(b.code);
    });
  }
  function safeUrl(value) {
    try { const url = new URL(value); return url.protocol === "https:" ? url.href : ""; } catch { return ""; }
  }
  function link(url, label) { const safe = safeUrl(url); return safe ? `<a href="${escape(safe)}" target="_blank" rel="noopener noreferrer">${label} ↗</a>` : ""; }
  function rowHtml(row) {
    const money = row.status === "limited" && Number.isFinite(row.limitAmount)
      ? `<span class="money">${escape(row.limitAmount.toLocaleString("zh-CN"))}<small>元 / 日</small></span>`
      : `<span class="money text">${escape(amount(row))}</span>`;
    return `<tr><td><div class="fund-name">${escape(row.name)}</div><div class="code">${escape(row.code)}${row.shareClass ? `<span class="share">${escape(row.shareClass)}</span>` : ""}</div></td><td>${escape(row.manager)}<div class="category ${row.index === "nasdaq-tech" ? "tech" : ""}">${escape(row.indexLabel)}</div></td><td><span class="badge ${escape(row.status)}">${escape(STATUS[row.status] || "暂未确认")}</span>${row.availability === "unverified" ? '<span class="direct-warning">公告口径 · 实际可买未核验</span>' : ""}</td><td>${money}</td><td class="source">${escape(time(row.queriedAt))}<br>${link(row.sourceUrl, "数据来源")}${row.noticeUrl && row.noticeUrl !== row.sourceUrl ? link(row.noticeUrl, "公告") : ""}</td></tr>`;
  }
  function eventHtml(event) {
    const row = event.after || event.before;
    return `<article class="change"><div class="change-top"><span>${escape(TYPES[event.type] || "变化")}</span><time>${escape(time(event.detectedAt))}</time></div><div class="change-title">${escape(row.name)} <span class="code">${escape(row.code)}</span></div><div class="change-amount"><span>${escape(amount(event.before))} → </span>${escape(amount(event.after))}</div><div class="change-meta">${escape(row.channel)} · ${escape(row.indexLabel)} ${link(row.sourceUrl, "来源")}</div></article>`;
  }
  function healthText(data, now = Date.now()) {
    if (!data.lastSuccessAt) return { warning: true, text: `${data.health === "error" ? "最近检查失败，" : ""}尚未建立有效数据基线。首次成功检查后显示基金与额度。${data.lastAttemptAt ? `最近尝试：${time(data.lastAttemptAt)}（北京时间）` : ""}` };
    const stale = now - Date.parse(data.lastSuccessAt) > 86400000;
    return { warning: stale || data.health !== "ok", text: `${stale ? "数据已超过24小时未更新。" : ""}${data.health === "ok" ? "最近检查成功。" : "最近检查失败，保留上次有效数据。"}最近成功：${time(data.lastSuccessAt)}（北京时间）｜最近尝试：${time(data.lastAttemptAt)}` };
  }
  if (typeof module !== "undefined") module.exports = { filterRows, amount, safeUrl, escape, healthText, rowHtml, eventHtml };
  if (typeof document === "undefined") return;
  let data, history = [], channel = "sales-agency";
  const $ = (id) => document.getElementById(id);
  function render() {
    const rows = filterRows(data.rows, { channel, manager: $("manager").value, status: $("status").value, search: $("search").value, sort: $("sort").value });
    $("fund-rows").innerHTML = rows.length ? rows.map(rowHtml).join("") : '<tr><td colspan="5" class="empty">没有符合条件的记录。直销页仅列出已解析的适用公告，不代表所有产品均有直销数据。</td></tr>';
    $("result-count").textContent = `${rows.length} 条渠道记录`;
    $("channel-note").textContent = channel === "sales-agency" ? "代销数据来自天天基金公开销售页，并结合适用公告核验；其他平台额度可能不同。" : "以下为公告中适用的直销规则，实际可申购状态尚未验证；请以基金公司 APP 显示为准。";
  }
  async function load() {
    try {
      const response = await fetch(`data/latest.json?t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error("fetch");
      data = await response.json();
      if (!Array.isArray(data.rows) || !Array.isArray(data.recentChanges)) throw new Error("shape");
      const health = healthText(data);
      $("health").textContent = health.text;
      $("health").classList.toggle("warning", health.warning);
      const sales = data.rows.filter((row) => row.channelBucket === "sales-agency");
      $("stat-funds").textContent = data.lastSuccessAt ? new Set(sales.map((row) => row.code)).size : "—";
      $("stat-limited").textContent = data.lastSuccessAt ? sales.filter((row) => row.status === "limited").length : "—";
      $("stat-suspended").textContent = data.lastSuccessAt ? sales.filter((row) => ["suspended", "unavailable"].includes(row.status)).length : "—";
      $("stat-changes").textContent = data.lastSuccessAt ? data.recentChanges.filter((event) => event.detectedAt === data.lastSuccessAt).length : "—";
      $("stat-time").textContent = time(data.lastSuccessAt);
      $("manager").innerHTML = '<option value="">全部公司</option>' + [...new Set(data.rows.map((row) => row.manager))].sort((a, b) => a.localeCompare(b, "zh-CN")).map((name) => `<option value="${escape(name)}">${escape(name)}</option>`).join("");
      $("changes").innerHTML = data.recentChanges.length ? `<div class="change-list">${data.recentChanges.slice(0, 6).map(eventHtml).join("")}</div>` : '<p class="empty">暂无已确认的限购变化。首次有效检查仅建立基线。</p>';
      render();
    } catch {
      $("health").classList.add("warning");
      $("health").textContent = "监控数据暂时无法加载。请稍后刷新页面，或检查部署任务。";
      $("changes").innerHTML = '<p class="empty">暂时无法读取变化记录。</p>';
      $("fund-rows").innerHTML = '<tr><td colspan="5" class="empty">暂无可展示数据。</td></tr>';
    }
    try {
      const response = await fetch(`data/history.json?t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error("fetch");
      history = await response.json();
      $("history-select").innerHTML = '<option value="">选择检查时间</option>' + history.map((entry, index) => `<option value="${index}">${escape(time(entry.queriedAt))} · ${entry.health === "ok" ? `${entry.changes.length} 条变化` : "检查失败"}</option>`).join("");
    } catch { $("history-detail").innerHTML = '<p class="empty">检查历史暂时无法加载。</p>'; }
  }
  ["search", "manager", "status", "sort"].forEach((id) => $(id).addEventListener(id === "search" ? "input" : "change", () => { if (data) render(); }));
  document.querySelectorAll("[data-channel]").forEach((button) => button.addEventListener("click", () => {
    channel = button.dataset.channel;
    document.querySelectorAll("[data-channel]").forEach((tab) => { tab.classList.toggle("selected", tab === button); tab.setAttribute("aria-pressed", String(tab === button)); });
    if (data) render();
  }));
  $("history-select").addEventListener("change", () => {
    const entry = $("history-select").value === "" ? null : history[Number($("history-select").value)];
    if (!entry) { $("history-detail").innerHTML = '<p class="empty">选择记录，查看当时的额度和变化。</p>'; return; }
    $("history-detail").innerHTML = entry.health !== "ok" ? '<p class="empty">本次检查未完成，没有更新有效数据基线或生成额度变化。</p>' : `<div class="history-summary">${escape(time(entry.queriedAt))} · ${entry.rows.length} 条渠道记录 · ${entry.changes.length} 条变化</div>${entry.changes.length ? `<div class="change-list">${entry.changes.map(eventHtml).join("")}</div>` : '<p class="empty">本次没有变化，或正在建立首次基线。</p>'}<details><summary>展开当时的额度快照</summary><div class="table-scroll"><table><tbody>${entry.rows.map(rowHtml).join("")}</tbody></table></div></details>`;
  });
  load();
})();
