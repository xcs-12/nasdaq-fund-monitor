const nodemailer = require("nodemailer");
const { changeLine, formatTime } = require("../lib/report");

function smtpSettings(env = process.env) {
  const required = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "MAIL_FROM", "MAIL_TO"];
  if (required.some((key) => !env[key])) throw new Error("邮件配置不完整：请检查 GitHub Secrets");
  const port = Number(env.SMTP_PORT);
  if (![465, 587].includes(port)) throw new Error("SMTP_PORT 必须为 465 或 587（TLS）");
  return {
    host: env.SMTP_HOST, port, secure: port === 465, requireTLS: true,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 30000,
    disableFileAccess: true, disableUrlAccess: true,
    logger: false, debug: false
  };
}

function buildMail(events, env = process.env, test = false) {
  const lines = test ? ["这是一封纳指基金限购监控测试邮件，不代表真实限购变化。"] : events.map((event) => {
    const row = event.after || event.before;
    return [changeLine(event), `份额：${row.shareClass || "未标明"}｜渠道：${row.channel}`,
      `发现时间：${formatTime(event.detectedAt, "Asia/Shanghai")}`, `来源：${row.sourceUrl || row.noticeUrl || "请查看网页"}`,
      row.availability === "unverified" ? "直销信息来自公告，实际可申购状态尚未验证。" : ""].filter(Boolean).join("\n");
  });
  lines.push(`网页：${env.SITE_URL || "尚未配置网页地址"}`, "额度按购买渠道分别统计，实际申购请核对对应销售渠道与基金公告。");
  return {
    from: env.MAIL_FROM, to: env.MAIL_TO,
    subject: test ? "【测试】纳指基金限购邮件通知" : `【限购变化】纳指场外基金 ${events.length} 条更新`,
    text: lines.join("\n\n"),
    messageId: test ? undefined : `<${require("node:crypto").createHash("sha256").update(events.map((event) => event.id).sort().join(",")).digest("hex")}@nasdaq-limit-monitor>`
  };
}

async function sendMail(events, options = {}) {
  const env = options.env || process.env;
  const transport = (options.createTransport || nodemailer.createTransport)(smtpSettings(env));
  try {
    const result = await transport.sendMail(buildMail(events, env, options.test));
    if (!result.accepted || !result.accepted.length || (result.rejected && result.rejected.length)) throw new Error("邮件未被所有收件服务器接受");
    return true;
  } finally {
    if (transport.close) transport.close();
  }
}

module.exports = { smtpSettings, buildMail, sendMail };
