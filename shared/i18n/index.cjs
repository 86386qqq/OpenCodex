const DEFAULT_LOCALE = "en-US";
const ZH_CN = "zh-CN";
const EN_US = "en-US";

const MESSAGES = {
  // 文案表是资源数据，不放在逻辑源码里；这里仅按 locale 装载对应 JSON。
  [ZH_CN]: require("./locales/zh-CN.json"),
  [EN_US]: require("./locales/en-US.json"),
};

function normalizeLocale(value, fallback = DEFAULT_LOCALE) {
  const raw = String(value || "").trim().replace(/_/g, "-").toLowerCase();
  if (!raw) return fallback;
  if (raw === "zh" || raw.startsWith("zh-")) return ZH_CN;
  if (raw === "en" || raw.startsWith("en-")) return EN_US;
  return fallback;
}

function messagesForLocale(locale) {
  return MESSAGES[normalizeLocale(locale)] || MESSAGES[DEFAULT_LOCALE];
}

function formatMessage(messages, key, values) {
  const template = (messages && messages[key]) || MESSAGES[DEFAULT_LOCALE][key] || key;
  if (!values || typeof values !== "object") return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match
  );
}

function t(locale, key, values) {
  return formatMessage(messagesForLocale(locale), key, values);
}

function systemLocaleCandidates(extraCandidates) {
  const candidates = [];
  if (Array.isArray(extraCandidates)) candidates.push(...extraCandidates);
  try {
    candidates.push(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {}
  candidates.push(process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG);
  return candidates.filter(Boolean);
}

function resolveOpenCodexLocale(options = {}) {
  // OpenCodex 自有文案只跟随系统语言；不读官方配置，也不依赖官方 IPC 是否存在。
  const candidates = systemLocaleCandidates(options.systemLocales);
  const zhCandidate = candidates.find((candidate) => normalizeLocale(candidate, "") === ZH_CN);
  return { locale: zhCandidate ? ZH_CN : EN_US, source: zhCandidate ? "system" : "default" };
}

function resolveOpenCodexI18n(options = {}) {
  const resolved = resolveOpenCodexLocale(options);
  return {
    ...resolved,
    messages: messagesForLocale(resolved.locale),
  };
}

module.exports = {
  DEFAULT_LOCALE,
  EN_US,
  MESSAGES,
  ZH_CN,
  formatMessage,
  messagesForLocale,
  normalizeLocale,
  resolveOpenCodexI18n,
  resolveOpenCodexLocale,
  t,
};
