import { decidePortfolioAction, normalizeTarget } from "./strategy.js";
import { decryptVault, encryptVault } from "./vault.js";

const DEFAULT_PORTFOLIO = [];

function readStoredList() {
  try { return JSON.parse(localStorage.getItem("fund-watchlist") || "[]"); } catch { return []; }
}

function readStoredObject(key) {
  try { return JSON.parse(localStorage.getItem(key) || "{}"); } catch { return {}; }
}

function readStrategySettings() {
  const stored = readStoredObject("fund-strategy-settings");
  return {
    defaultTakeProfitPct: normalizeTarget(stored.defaultTakeProfitPct, 20),
    fundTargets: stored.fundTargets && typeof stored.fundTargets === "object" ? stored.fundTargets : {},
    fundCostNavs: stored.fundCostNavs && typeof stored.fundCostNavs === "object" ? stored.fundCostNavs : {}
  };
}

function readPortfolio() {
  const stored = readStoredObject("fund-portfolio");
  const storedItems = Array.isArray(stored.items) ? stored.items : [];
  return storedItems.filter((fund) => /^\d{6}$/.test(fund.code)).map((fund) => ({ ...fund, userGroup: fund.userGroup || "未分组" }));
}

function readTradeHistory() {
  const stored = readStoredObject("fund-trade-history");
  const history = {};
  for (const [code, records] of Object.entries(stored)) {
    if (!/^\d{6}$/.test(code) || !Array.isArray(records)) continue;
    history[code] = records.filter((record) => {
      return /^\d{4}-\d{2}-\d{2}$/.test(record?.date)
        && ["buy", "sell"].includes(record?.type)
        && Number(record?.nav) > 0;
    }).slice(0, 500);
  }
  return history;
}

const initialPortfolio = readPortfolio();
const mergedWatchlist = [...initialPortfolio, ...readStoredList()]
  .filter((fund, index, items) => items.findIndex((item) => item.code === fund.code) === index)
  .map(({ code, name, userGroup = "未分组" }) => ({ code, name, userGroup }));

const state = {
  code: localStorage.getItem("fund-code") || "110022",
  profile: localStorage.getItem("fund-profile") || "balanced",
  range: localStorage.getItem("fund-range") || "1y",
  watchlist: mergedWatchlist,
  portfolio: initialPortfolio,
  customGroups: Array.isArray(readStoredObject("fund-custom-groups").items) ? readStoredObject("fund-custom-groups").items : ["我的持仓", "未分组"],
  portfolioPayload: null,
  portfolioResearchPayload: null,
  marketOpportunityPayload: null,
  refreshingMarketOpportunities: false,
  portfolioFilter: "all",
  portfolioGroup: "all",
  portfolioUnits: readStoredObject("fund-portfolio-units"),
  tradeHistory: readTradeHistory(),
  strategySettings: readStrategySettings(),
  refreshingPortfolio: false,
  nextRefreshAt: null,
  view: "portfolio",
  payload: null,
  charts: [],
  navChart: null,
  searchTimer: null,
  activeCompanyCode: null,
  strategyFundCode: null,
  installPrompt: null
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const formatPct = (value, empty = "--") => value == null ? empty : `${value > 0 ? "+" : ""}${Number(value).toFixed(2)}%`;
const formatNumber = (value, digits = 4) => value == null ? "--" : Number(value).toFixed(digits);
const formatMoney = (value) => value == null ? "--" : new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 2 }).format(value);
const signedClass = (value) => value > 0 ? "positive-text" : value < 0 ? "negative-text" : "";
const formatTrendLevel = (value) => {
  if (!Number.isFinite(Number(value))) return "--";
  const level = Math.min(10, Math.max(-10, Number(value) / 10));
  return `${level > 0 ? "+" : ""}${level.toFixed(1)}`;
};
const fundFamilyKey = (name) => String(name ?? "").replace(/(?:\s*[-—]?\s*[ACIE])$/i, "").replace(/\s+/g, "").toLowerCase();

function setText(selector, value) { $(selector).textContent = value; }

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("visible"), 3000);
}

function setLoading(loading) {
  $("#loadingOverlay").classList.toggle("hidden", !loading);
}

function setSignedValue(selector, value) {
  const element = $(selector);
  element.textContent = formatPct(value);
  element.className = signedClass(value);
}

function profileCopy(profile) {
  return {
    conservative: "稳健模式要求更多趋势证据，信号较少但过滤更严格。",
    balanced: "均衡模式兼顾趋势确认与信号灵敏度。",
    aggressive: "积极模式更早响应转折，同时更容易遇到假信号。"
  }[profile];
}

function showView(view) {
  state.view = view;
  $("#portfolioView").hidden = view !== "portfolio";
  $("#detailView").hidden = view !== "detail";
  $$(".view-switch button").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  if (view === "detail") requestAnimationFrame(() => state.charts.forEach((chart) => chart.render()));
}

function updateCurrentFundButton() {
  const button = $("#addCurrentButton");
  const exists = state.payload && state.portfolio.some((item) => item.code === state.payload.fund.code);
  button.title = exists ? "从当前组合移除" : "将当前基金加入关注";
  button.setAttribute("aria-label", exists ? "移除关注" : "加入关注");
  button.innerHTML = exists
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
}

function savePortfolio() {
  localStorage.setItem("fund-portfolio", JSON.stringify({ items: state.portfolio }));
  localStorage.setItem("fund-custom-groups", JSON.stringify({ items: state.customGroups }));
  state.watchlist = state.portfolio.map(({ code, name, userGroup }) => ({ code, name, userGroup }));
  localStorage.setItem("fund-watchlist", JSON.stringify(state.watchlist));
}

function addFundToPortfolio(fund) {
  if (!fund || !/^\d{6}$/.test(fund.code)) return false;
  if (state.portfolio.some((item) => item.code === fund.code)) {
    showToast("该基金已在当前浏览器的自选中");
    return false;
  }
  const userGroup = state.portfolioGroup !== "all" ? state.portfolioGroup : "未分组";
  state.portfolio.push({ code: fund.code, name: fund.name || fund.code, userGroup, snapshotValue: null, snapshotReturnPct: null });
  savePortfolio();
  renderGroupOptions();
  renderWatchlist();
  updateCurrentFundButton();
  showToast(`已加入“${userGroup}”分组`);
  refreshPortfolio();
  return true;
}

function saveStrategySettings() {
  localStorage.setItem("fund-strategy-settings", JSON.stringify(state.strategySettings));
}

function saveTradeHistory() {
  localStorage.setItem("fund-trade-history", JSON.stringify(state.tradeHistory));
}

function tradesFor(code = state.code) {
  return Array.isArray(state.tradeHistory[code]) ? state.tradeHistory[code] : [];
}

function collectPrivateStorage() {
  const payload = {};
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith("fund-")) payload[key] = localStorage.getItem(key);
  }
  return payload;
}

function applyPrivateStorage(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("保险箱内容无效");
  const entries = Object.entries(payload);
  if (entries.length > 80 || entries.some(([key, value]) => !key.startsWith("fund-") || typeof value !== "string")) throw new Error("保险箱包含不受支持的数据");
  const currentKeys = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith("fund-")) currentKeys.push(key);
  }
  currentKeys.forEach((key) => localStorage.removeItem(key));
  entries.forEach(([key, value]) => localStorage.setItem(key, value));
}

function downloadJsonFile(payload, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function takeProfitTargetFor(code) {
  return normalizeTarget(state.strategySettings.fundTargets[code], state.strategySettings.defaultTakeProfitPct);
}

function renderGroupOptions() {
  const groups = [...new Set(["我的持仓", ...state.customGroups, "未分组"])];
  state.customGroups = groups;
  const select = $("#portfolioGroup");
  const selected = groups.includes(state.portfolioGroup) ? state.portfolioGroup : "all";
  select.innerHTML = `<option value="all">全部分组</option>${groups.map((group) => `<option value="${escapeHtml(group)}">${escapeHtml(group)}</option>`).join("")}`;
  select.value = selected;
  renderGroupModal();
}

function renderGroupModal() {
  const list = $("#customGroupList");
  if (!list) return;
  list.innerHTML = state.customGroups.map((group) => {
    const count = state.portfolio.filter((fund) => fund.userGroup === group).length;
    const protectedGroup = group === "我的持仓" || group === "未分组";
    return `<div class="custom-group-item"><div><strong>${escapeHtml(group)}</strong><span>${count} 只基金</span></div>${protectedGroup ? "" : `<button class="icon-button small" data-delete-group="${escapeHtml(group)}" title="删除分组" aria-label="删除${escapeHtml(group)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13M10 11v5m4-5v5"/></svg></button>`}</div>`;
  }).join("");
  $$('[data-delete-group]').forEach((button) => button.addEventListener("click", () => {
    const group = button.dataset.deleteGroup;
    state.portfolio.forEach((fund) => { if (fund.userGroup === group) fund.userGroup = "未分组"; });
    state.customGroups = state.customGroups.filter((item) => item !== group);
    if (state.portfolioGroup === group) state.portfolioGroup = "all";
    savePortfolio(); renderGroupOptions(); renderPortfolioRows(); renderWatchlist();
  }));
}

function renderStrategyFundFields() {
  const code = state.strategyFundCode || state.portfolio[0]?.code;
  if (!code) return;
  state.strategyFundCode = code;
  const target = state.strategySettings.fundTargets[code];
  const costNav = state.strategySettings.fundCostNavs[code];
  $("#strategyFundSelect").value = code;
  $("#fundTakeProfitInput").value = Number.isFinite(Number(target)) ? Number(target) : "";
  $("#fundCostNavInput").value = Number.isFinite(Number(costNav)) ? Number(costNav) : "";
  const fund = state.portfolio.find((item) => item.code === code);
  setText("#strategyFundNote", `${fund?.name || code} 当前止盈目标 ${takeProfitTargetFor(code).toFixed(1)}%。成本净值留空时沿用现有参考成本。`);
}

function renderStrategyModal() {
  $("#defaultTakeProfitInput").value = state.strategySettings.defaultTakeProfitPct;
  $("#strategyFundSelect").innerHTML = state.portfolio.map((fund) => `<option value="${fund.code}">${escapeHtml(fund.name)} · ${fund.code}</option>`).join("");
  if (!state.portfolio.some((fund) => fund.code === state.strategyFundCode)) state.strategyFundCode = state.portfolio[0]?.code ?? null;
  renderStrategyFundFields();
}

function researchFor(code) {
  return state.portfolioResearchPayload?.items?.find((item) => item.code === code) ?? null;
}

function compositeFor(item) {
  const research = researchFor(item.code);
  const usable = research?.fundamentalScore != null && research.coverage >= 15;
  const compositeScore = usable ? Math.round(item.signal.score * 0.75 + research.fundamentalScore * 0.25) : item.signal.score;
  const holding = holdingSnapshot(item);
  const targetPct = takeProfitTargetFor(item.code);
  const entry = decidePortfolioAction({
    technicalState: item.entry?.state,
    technicalLabel: item.entry?.label,
    score: item.signal.score,
    compositeScore,
    confidence: item.signal.confidence,
    attentionThreshold: item.signal.threshold?.attention,
    reduceThreshold: item.signal.threshold?.reduce,
    fundamentalScore: research?.fundamentalScore,
    fundamentalUsable: usable,
    drawdown: item.current?.drawdown,
    volatility: item.current?.volatility,
    holdingReturnPct: holding?.returnPct,
    hasHolding: Boolean(holding),
    targetPct,
    dataQuality: item.data?.quality,
    lagBusinessDays: item.data?.lagBusinessDays
  });
  return { research, compositeScore, entry, usable, holding, targetPct };
}

function qualityLabel(item) {
  if (item.data?.lagBusinessDays > 0) return { label: `延迟${item.data.lagBusinessDays}日`, className: "mismatch" };
  if (item.data?.quality === "verified") return { label: "双源一致", className: "verified" };
  if (item.data?.quality === "mismatch") return { label: "需要核对", className: "mismatch" };
  return { label: "单源数据", className: "single-source" };
}

function holdingSnapshot(item) {
  const holding = state.portfolio.find((fund) => fund.code === item.code);
  if (!holding || !item.current?.nav) return null;
  const customCostNav = Number(state.strategySettings.fundCostNavs[item.code]);
  const hasCustomCost = Number.isFinite(customCostNav) && customCostNav > 0;
  if ((!Number.isFinite(holding.snapshotValue) || holding.snapshotValue <= 0) && !hasCustomCost) return null;
  if ((!Number.isFinite(holding.snapshotValue) || holding.snapshotValue <= 0) && hasCustomCost) {
    return { units: null, currentValue: null, cost: null, profit: null, returnPct: (item.current.nav / customCostNav - 1) * 100, costNav: customCostNav };
  }
  if (!state.portfolioUnits[item.code]) {
    state.portfolioUnits[item.code] = holding.snapshotValue / item.current.nav;
    localStorage.setItem("fund-portfolio-units", JSON.stringify(state.portfolioUnits));
  }
  const units = state.portfolioUnits[item.code];
  const currentValue = units * item.current.nav;
  const cost = hasCustomCost ? units * customCostNav : holding.snapshotValue / (1 + holding.snapshotReturnPct / 100);
  const profit = currentValue - cost;
  return { units, currentValue, cost, profit, returnPct: cost ? profit / cost * 100 : null, costNav: hasCustomCost ? customCostNav : cost / units };
}

function renderPortfolioRows() {
  const items = state.portfolioPayload?.items ?? [];
  const filtered = items.filter((item) => {
    const holding = state.portfolio.find((fund) => fund.code === item.code);
    const derived = compositeFor(item);
    const groupMatches = state.portfolioGroup === "all" || holding?.userGroup === state.portfolioGroup;
    const statusMatches = state.portfolioFilter === "all" || derived.entry?.state === state.portfolioFilter;
    return groupMatches && statusMatches;
  });
  filtered.sort((left, right) => {
    const leftHolding = state.portfolio.find((fund) => fund.code === left.code);
    const rightHolding = state.portfolio.find((fund) => fund.code === right.code);
    const groupDifference = state.customGroups.indexOf(leftHolding?.userGroup) - state.customGroups.indexOf(rightHolding?.userGroup);
    if (groupDifference) return groupDifference;
    const leftSector = researchFor(left.code)?.dominantSector ?? "未识别";
    const rightSector = researchFor(right.code)?.dominantSector ?? "未识别";
    return leftSector.localeCompare(rightSector, "zh-CN") || compositeFor(right).compositeScore - compositeFor(left).compositeScore;
  });
  $("#portfolioEmpty").textContent = items.length ? "当前筛选条件下没有基金" : "当前浏览器还没有基金，请先搜索并加入自己的组合";
  $("#portfolioEmpty").hidden = filtered.length > 0;
  $("#portfolioRows").innerHTML = filtered.map((item) => {
    if (item.error) return `<tr><td><div class="fund-cell"><strong>${escapeHtml(state.portfolio.find((fund) => fund.code === item.code)?.name || item.code)}</strong><span>${item.code}</span></div></td><td colspan="4" class="negative-text">${escapeHtml(item.error)}</td><td></td></tr>`;
    const portfolioFund = state.portfolio.find((fund) => fund.code === item.code);
    const derived = compositeFor(item);
    const holding = derived.holding;
    const tags = derived.research?.tags ?? [];
    const tagLabel = tags.length ? tags.map(escapeHtml).join(" / ") : derived.research ? "暂无披露持仓" : "系统标签读取中";
    const quality = qualityLabel(item);
    const scoreClass = signedClass(derived.compositeScore);
    const groupOptions = state.customGroups.map((group) => `<option value="${escapeHtml(group)}" ${portfolioFund?.userGroup === group ? "selected" : ""}>${escapeHtml(group)}</option>`).join("");
    return `<tr data-code="${item.code}">
      <td><div class="fund-cell"><strong title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong><span>${item.code} · ${tagLabel}</span><select class="inline-group-select" data-group-code="${item.code}" aria-label="${escapeHtml(item.name)}关注分组">${groupOptions}</select></div></td>
      <td><div class="holding-cell"><strong>${formatNumber(item.current.nav)}</strong><span>${item.current.date} · ${quality.label}</span><small class="${signedClass(item.current.dailyChange)}">${formatPct(item.current.dailyChange)}</small></div></td>
      <td><div class="holding-cell"><strong class="${signedClass(holding?.returnPct)}">${formatPct(holding?.returnPct)}</strong><span>${holding?.currentValue != null ? formatMoney(holding.currentValue) : "未设置持仓成本"}</span><small>止盈目标 ${derived.targetPct.toFixed(1)}%</small></div></td>
      <td><div class="composite-cell"><span class="score-chip ${scoreClass}" title="综合趋势等级，范围 -10.0 至 +10.0">${formatTrendLevel(derived.compositeScore)}</span><small>技术 ${formatTrendLevel(item.signal.score)}${derived.usable ? ` · 基本面 ${derived.research.fundamentalScore > 0 ? "+" : ""}${derived.research.fundamentalScore}` : ""}</small></div></td>
      <td><div class="action-cell"><span class="entry-chip ${derived.entry.state}" title="${escapeHtml(derived.entry.detail || "")}">${escapeHtml(derived.entry.label)}</span><small title="${escapeHtml(derived.entry.detail || "")}">${escapeHtml(derived.entry.detail || "")}</small></div></td>
      <td><button class="icon-button small row-action" data-open-code="${item.code}" title="查看单基分析" aria-label="查看${escapeHtml(item.name)}分析"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></button></td>
    </tr>`;
  }).join("");
  $$('[data-open-code]').forEach((button) => button.addEventListener("click", () => loadFund(button.dataset.openCode)));
  $$('[data-group-code]').forEach((select) => select.addEventListener("change", () => {
    const fund = state.portfolio.find((item) => item.code === select.dataset.groupCode);
    if (!fund) return;
    fund.userGroup = select.value;
    savePortfolio(); renderGroupOptions(); renderWatchlist(); renderPortfolioRows();
  }));
}

function setPortfolioFilter(filter) {
  state.portfolioFilter = filter;
  $$("#portfolioFilter button").forEach((item) => item.classList.toggle("active", item.dataset.filter === filter));
  renderPortfolioRows();
}

function renderTrendLeaders(items) {
  const families = new Set();
  const ranked = items
    .filter((item) => !item.error)
    .map((item) => ({ item, derived: compositeFor(item) }))
    .sort((left, right) => {
      const leftVerified = left.item.data?.quality === "verified" && left.item.data?.lagBusinessDays === 0 ? 1 : 0;
      const rightVerified = right.item.data?.quality === "verified" && right.item.data?.lagBusinessDays === 0 ? 1 : 0;
      return rightVerified - leftVerified
        || right.derived.compositeScore - left.derived.compositeScore
        || (right.item.current?.periodReturns?.quarter ?? -Infinity) - (left.item.current?.periodReturns?.quarter ?? -Infinity);
    })
    .filter(({ item }) => {
      const family = fundFamilyKey(item.name);
      if (families.has(family)) return false;
      families.add(family);
      return true;
    })
    .slice(0, 3);
  const container = $("#trendLeaders");
  if (!ranked.length) {
    container.innerHTML = '<div class="trend-leaders-empty">添加基金后，这里会对自选范围内的趋势强度进行排序</div>';
    return;
  }
  container.innerHTML = ranked.map(({ item, derived }, index) => {
    const verified = item.data?.quality === "verified" && item.data?.lagBusinessDays === 0;
    return `<button class="trend-leader-card" data-leader-code="${item.code}">
      <span class="leader-rank">${String(index + 1).padStart(2, "0")}</span>
      <span class="leader-identity"><strong title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong><small>${item.code} · ${verified ? "正式净值已校验" : "数据待确认"}</small></span>
      <span class="leader-score ${signedClass(derived.compositeScore)}"><strong>${formatTrendLevel(derived.compositeScore)}</strong><small>趋势等级</small></span>
      <span class="leader-return-pair"><span class="leader-metric"><strong class="${signedClass(item.current?.periodReturns?.month)}">${formatPct(item.current?.periodReturns?.month)}</strong><small>近1月</small></span><span class="leader-metric"><strong class="${signedClass(item.current?.periodReturns?.quarter)}">${formatPct(item.current?.periodReturns?.quarter)}</strong><small>近3月</small></span></span>
      <span class="entry-chip ${derived.entry.state}">${escapeHtml(derived.entry.label)}</span>
    </button>`;
  }).join("");
  $$('[data-leader-code]').forEach((button) => button.addEventListener("click", () => loadFund(button.dataset.leaderCode)));
}

function renderMarketOpportunities(payload) {
  state.marketOpportunityPayload = payload;
  const container = $("#marketOpportunities");
  const items = payload.items ?? [];
  if (!items.length) {
    container.innerHTML = '<div class="market-opportunities-empty">当前没有同时通过板块去重与数据验证的候选</div>';
  } else {
    container.innerHTML = items.map((item, index) => `<button class="market-opportunity" data-market-code="${item.code}">
      <span class="market-opportunity-top"><b>${escapeHtml(item.sector)}</b><small>板块代表 ${String(index + 1).padStart(2, "0")}</small></span>
      <span class="market-opportunity-name"><strong title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong><small>${item.code} · 持仓期 ${escapeHtml(item.holdingsReportDate || "待披露")}</small></span>
      <span class="market-return"><small>近1月</small><strong class="${signedClass(item.returns.month)}">${formatPct(item.returns.month)}</strong></span>
      <span class="market-return"><small>近3月</small><strong class="${signedClass(item.returns.quarter)}">${formatPct(item.returns.quarter)}</strong></span>
      <span class="market-evidence"><span>趋势等级 <b class="${signedClass(item.trend.score)}">${formatTrendLevel(item.trend.score)}</b></span><span>同向率 <b>${item.trend.confidence}%</b></span><span>回撤 <b class="${signedClass(item.trend.drawdown)}">${formatPct(item.trend.drawdown)}</b></span><span>基本面 <b>${item.fundamental.score == null ? "待补" : `${item.fundamental.score > 0 ? "+" : ""}${item.fundamental.score}`}</b></span></span>
      <span class="market-decision"><span class="entry-chip ${item.suggestion.state}">${escapeHtml(item.suggestion.label)}</span><small title="${escapeHtml(item.suggestion.detail)}">${escapeHtml(item.suggestion.detail)}</small></span>
    </button>`).join("");
    $$('[data-market-code]').forEach((button) => button.addEventListener("click", () => loadFund(button.dataset.marketCode)));
  }
  const updated = new Date(payload.generatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  setText("#marketOpportunitiesUpdated", `排行净值日 ${payload.rankDate || "--"} · ${updated} 完成板块去重`);
}

async function refreshMarketOpportunities() {
  if (state.refreshingMarketOpportunities) return;
  state.refreshingMarketOpportunities = true;
  setText("#marketOpportunitiesUpdated", "正在验证排行、净值、持仓和风险指标");
  try {
    const response = await fetch(`/api/market/opportunities?profile=${state.profile}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "全市场候选读取失败");
    renderMarketOpportunities(payload);
  } catch (error) {
    $("#marketOpportunities").innerHTML = `<div class="market-opportunities-empty">${escapeHtml(error.message)}</div>`;
    setText("#marketOpportunitiesUpdated", "本轮公开市场扫描未完成，稍后自动重试");
  } finally {
    state.refreshingMarketOpportunities = false;
  }
}

function notifyActionChanges(items) {
  const actionable = new Set(["base", "take-profit", "sell"]);
  const current = items.filter((item) => actionable.has(item.entry?.state) && item.data?.quality === "verified" && item.data?.lagBusinessDays === 0).map((item) => `${item.code}:${item.entry.state}`);
  const stored = localStorage.getItem("fund-last-actions-v2");
  if (stored == null) {
    localStorage.setItem("fund-last-actions-v2", JSON.stringify(current));
    return;
  }
  let previous = [];
  try { previous = JSON.parse(stored); } catch {}
  const added = current.filter((key) => !previous.includes(key));
  localStorage.setItem("fund-last-actions-v2", JSON.stringify(current));
  if (!added.length || !("Notification" in window) || localStorage.getItem("fund-notifications") !== "on" || Notification.permission !== "granted") return;
  const messages = added.map((key) => {
    const [code, action] = key.split(":");
    const item = items.find((candidate) => candidate.code === code);
    return item ? `${item.name}：${item.entry.label}` : action;
  });
  new Notification("净值罗盘：策略提示变化", { body: messages.join("；"), tag: "fund-strategy-action" });
}

function renderPortfolio(payload) {
  state.portfolioPayload = payload;
  const valid = payload.items.filter((item) => !item.error);
  const derivedItems = valid.map((item) => ({ item, derived: compositeFor(item) }));
  const holdings = derivedItems.map(({ derived }) => derived.holding).filter((holding) => Number.isFinite(holding?.currentValue));
  const currentValue = holdings.reduce((sum, holding) => sum + holding.currentValue, 0);
  const cost = holdings.reduce((sum, holding) => sum + holding.cost, 0);
  const profit = currentValue - cost;
  setText("#portfolioValue", formatMoney(currentValue));
  setText("#portfolioProfit", valid.length ? `估算持有收益 ${profit >= 0 ? "+" : ""}${formatMoney(profit)} · ${formatPct(cost ? profit / cost * 100 : null)}` : "本机数据为空，不会显示其他用户的组合");
  $("#portfolioProfit").className = signedClass(profit);
  setText("#baseCount", derivedItems.filter(({ derived }) => derived.entry.state === "base").length);
  setText("#holdCount", derivedItems.filter(({ derived }) => derived.entry.state === "hold").length);
  setText("#waitCount", derivedItems.filter(({ derived }) => derived.entry.state === "wait").length);
  setText("#takeProfitCount", derivedItems.filter(({ derived }) => derived.entry.state === "take-profit").length);
  setText("#sellCount", derivedItems.filter(({ derived }) => derived.entry.state === "sell").length);
  setText("#defaultTargetLabel", `${state.strategySettings.defaultTakeProfitPct.toFixed(0)}%`);
  setText("#marketStatus", payload.market.label);
  const verified = valid.filter((item) => item.data.quality === "verified" && item.data.lagBusinessDays === 0).length;
  setText("#qualityStatus", valid.length ? `${verified}/${valid.length} 双源一致` : "本地隐私模式");
  $("#qualityStatus").className = `quality-status ${!valid.length || verified === valid.length ? "positive-text" : "negative-text"}`;
  const updated = new Date(payload.generatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  setText("#portfolioUpdated", `上次检查 ${updated} · 预期最新净值日 ${payload.expectedOfficialDate}`);
  setText("#sourceStatus", valid.length ? `${valid.length} 只基金自动跟踪中` : "新访客默认空组合");
  state.nextRefreshAt = Date.now() + payload.refreshAfterSeconds * 1000;
  renderTrendLeaders(valid);
  renderPortfolioRows();
  notifyActionChanges(valid.map((item) => ({ ...item, entry: compositeFor(item).entry })));
}

async function refreshPortfolio({ silent = false } = {}) {
  if (state.refreshingPortfolio) return;
  state.refreshingPortfolio = true;
  $("#refreshPortfolioButton").classList.add("spinning");
  if (!silent && !state.portfolioPayload) setLoading(true);
  try {
    const codes = state.portfolio.map((fund) => fund.code);
    const response = await fetch("/api/portfolio", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ codes, profile: state.profile }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "组合数据读取失败");
    renderPortfolio(payload);
    refreshPortfolioResearch();
  } catch (error) {
    showToast(error.message);
    state.nextRefreshAt = Date.now() + 10 * 60 * 1000;
  } finally {
    state.refreshingPortfolio = false;
    $("#refreshPortfolioButton").classList.remove("spinning");
    setLoading(false);
  }
}

async function refreshPortfolioResearch() {
  const codes = state.portfolio.map((fund) => fund.code);
  if (!codes.length) {
    state.portfolioResearchPayload = { items: [] };
    return;
  }
  try {
    setText("#portfolioUpdated", "净值分析已完成，正在读取季度持仓与公司财报");
    const response = await fetch("/api/portfolio/research", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ codes }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "持仓研究数据读取失败");
    state.portfolioResearchPayload = payload;
    if (state.portfolioPayload) renderPortfolio(state.portfolioPayload);
  } catch (error) {
    showToast(`研究层暂未更新：${error.message}`);
  }
}

function updateRefreshCountdown() {
  if (!state.nextRefreshAt) return;
  const seconds = Math.max(0, Math.ceil((state.nextRefreshAt - Date.now()) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const remainder = String(seconds % 60).padStart(2, "0");
  setText("#refreshCountdown", hours ? `${String(hours).padStart(2, "0")}:${minutes}:${remainder}` : `${minutes}:${remainder}`);
  if (seconds === 0) refreshPortfolio({ silent: true });
}

function localDateString(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function renderTradeJournal() {
  const records = [...tradesFor()].sort((left, right) => right.date.localeCompare(left.date) || String(right.createdAt).localeCompare(String(left.createdAt)));
  const buys = records.filter((record) => record.type === "buy").reduce((sum, record) => sum + Number(record.amount || 0), 0);
  const sells = records.filter((record) => record.type === "sell").reduce((sum, record) => sum + Number(record.amount || 0), 0);
  setText("#tradeBuyTotal", formatMoney(buys));
  setText("#tradeSellTotal", formatMoney(sells));
  setText("#tradeNetAmount", formatMoney(buys - sells));
  $("#tradeNetAmount").className = signedClass(-(buys - sells));
  setText("#tradeRecordCount", `${records.length} 笔`);
  $("#tradeHistoryEmpty").hidden = records.length > 0;
  $("#tradeHistoryRows").innerHTML = records.map((record) => `<tr>
    <td>${record.date}</td>
    <td><span class="trade-type ${record.type}">${record.type === "buy" ? "买入" : "卖出"}</span></td>
    <td>${formatNumber(record.nav)}</td>
    <td>${formatMoney(record.amount)}</td>
    <td>${Number(record.units).toFixed(2)} 份</td>
    <td><span class="trade-note" title="${escapeHtml(record.note || "")}">${escapeHtml(record.note || "--")}</span></td>
    <td><button class="icon-button small" data-delete-trade="${escapeHtml(record.id)}" title="删除这条交易记录" aria-label="删除${record.date}交易记录"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13M10 11v5m4-5v5"/></svg></button></td>
  </tr>`).join("");
  $$('[data-delete-trade]').forEach((button) => button.addEventListener("click", () => {
    state.tradeHistory[state.code] = tradesFor().filter((record) => record.id !== button.dataset.deleteTrade);
    saveTradeHistory();
    renderTradeJournal();
    showToast("交易记录已删除");
  }));
  state.navChart?.setMarkers(records.map((record) => ({ ...record, label: record.type === "buy" ? "买" : "卖" })));
}

class LineChart {
  constructor(canvas, tooltip, options) {
    this.canvas = canvas;
    this.tooltip = tooltip;
    this.options = options;
    this.rows = [];
    this.markers = [];
    this.hoverIndex = null;
    this.resizeObserver = new ResizeObserver(() => this.render());
    this.resizeObserver.observe(canvas.parentElement);
    canvas.addEventListener("mousemove", (event) => this.onPointer(event));
    canvas.addEventListener("mouseleave", () => {
      this.hoverIndex = null;
      this.tooltip.classList.remove("visible");
      this.render();
    });
    canvas.addEventListener("touchstart", (event) => this.onPointer(event.touches[0]), { passive: true });
    canvas.addEventListener("touchmove", (event) => this.onPointer(event.touches[0]), { passive: true });
  }

  setData(rows) {
    this.rows = rows;
    this.hoverIndex = null;
    this.render();
  }

  setMarkers(markers) {
    this.markers = Array.isArray(markers) ? markers : [];
    this.render();
  }

  markerIndex(marker) {
    if (!this.rows.length) return -1;
    const exact = this.rows.findIndex((row) => row.date === marker.date);
    if (exact >= 0) return exact;
    const target = new Date(`${marker.date}T12:00:00+08:00`).getTime();
    let closest = 0;
    let distance = Infinity;
    this.rows.forEach((row, index) => {
      const nextDistance = Math.abs(Number(row.timestamp) - target);
      if (nextDistance < distance) { closest = index; distance = nextDistance; }
    });
    return closest;
  }

  dimensions() {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(280, rect.width);
    const height = Math.max(120, rect.height);
    if (this.canvas.width !== Math.round(width * ratio) || this.canvas.height !== Math.round(height * ratio)) {
      this.canvas.width = Math.round(width * ratio);
      this.canvas.height = Math.round(height * ratio);
    }
    const context = this.canvas.getContext("2d");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { context, width, height, ratio };
  }

  bounds(width, height) {
    return { left: 10, top: 10, right: width - 52, bottom: height - 25 };
  }

  getValues() {
    const values = [];
    for (const series of this.options.series) {
      for (const row of this.rows) {
        const value = Number(row[series.key]);
        if (Number.isFinite(value)) values.push(value);
      }
    }
    return values;
  }

  getDomain() {
    const values = this.getValues();
    if (!values.length) return [0, 1];
    let min = this.options.min ?? Math.min(...values);
    let max = this.options.max ?? Math.max(...values);
    for (const line of this.options.referenceLines || []) {
      min = Math.min(min, line.value);
      max = Math.max(max, line.value);
    }
    const padding = (max - min || 1) * .1;
    return [min - (this.options.min == null ? padding : 0), max + (this.options.max == null ? padding : 0)];
  }

  render() {
    const { context: ctx, width, height } = this.dimensions();
    ctx.clearRect(0, 0, width, height);
    if (!this.rows.length) return;
    const bounds = this.bounds(width, height);
    const [min, max] = this.getDomain();
    const xFor = (index) => bounds.left + index / Math.max(1, this.rows.length - 1) * (bounds.right - bounds.left);
    const yFor = (value) => bounds.bottom - (value - min) / Math.max(.000001, max - min) * (bounds.bottom - bounds.top);

    ctx.lineWidth = 1;
    ctx.font = '10px "Segoe UI", sans-serif';
    ctx.textAlign = "left";
    ctx.fillStyle = css("--muted");
    ctx.strokeStyle = css("--line");
    for (let i = 0; i <= 4; i += 1) {
      const y = bounds.top + i / 4 * (bounds.bottom - bounds.top);
      ctx.beginPath();
      ctx.moveTo(bounds.left, y);
      ctx.lineTo(bounds.right, y);
      ctx.stroke();
      const value = max - i / 4 * (max - min);
      ctx.fillText(this.options.axisFormat ? this.options.axisFormat(value) : value.toFixed(2), bounds.right + 7, y + 3);
    }
    const tickCount = width < 520 ? 3 : 5;
    ctx.textAlign = "center";
    for (let i = 0; i < tickCount; i += 1) {
      const index = Math.round(i / Math.max(1, tickCount - 1) * (this.rows.length - 1));
      const x = xFor(index);
      ctx.fillText(this.rows[index].date.slice(5), x, height - 6);
    }

    for (const line of this.options.referenceLines || []) {
      const y = yFor(line.value);
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = css("--line-strong");
      ctx.beginPath(); ctx.moveTo(bounds.left, y); ctx.lineTo(bounds.right, y); ctx.stroke();
      ctx.restore();
    }

    const barSeries = this.options.series.filter((series) => series.type === "bar");
    for (const series of barSeries) {
      const zeroY = yFor(0);
      const barWidth = Math.max(1, (bounds.right - bounds.left) / Math.max(1, this.rows.length) * .7);
      this.rows.forEach((row, index) => {
        const value = Number(row[series.key]);
        if (!Number.isFinite(value)) return;
        ctx.fillStyle = value >= 0 ? css("--up") : css("--down");
        const y = yFor(value);
        ctx.globalAlpha = .62;
        ctx.fillRect(xFor(index) - barWidth / 2, Math.min(y, zeroY), barWidth, Math.max(1, Math.abs(zeroY - y)));
      });
      ctx.globalAlpha = 1;
    }

    for (const series of this.options.series.filter((item) => item.type !== "bar")) {
      ctx.strokeStyle = series.color.startsWith("--") ? css(series.color) : series.color;
      ctx.lineWidth = series.width || 1.6;
      ctx.beginPath();
      let started = false;
      this.rows.forEach((row, index) => {
        const value = Number(row[series.key]);
        if (!Number.isFinite(value)) { started = false; return; }
        const x = xFor(index);
        const y = yFor(value);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    for (const marker of this.markers) {
      const index = this.markerIndex(marker);
      if (index < 0) continue;
      const x = xFor(index);
      const nav = Number(this.rows[index].trendNav);
      if (!Number.isFinite(nav)) continue;
      const y = yFor(nav);
      const buy = marker.type === "buy";
      ctx.save();
      ctx.fillStyle = buy ? css("--up") : css("--down");
      ctx.strokeStyle = css("--surface");
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (buy) {
        ctx.moveTo(x, y - 10); ctx.lineTo(x - 6, y + 1); ctx.lineTo(x + 6, y + 1);
      } else {
        ctx.moveTo(x, y + 10); ctx.lineTo(x - 6, y - 1); ctx.lineTo(x + 6, y - 1);
      }
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = buy ? css("--up") : css("--down");
      ctx.font = '700 9px "Segoe UI", sans-serif';
      ctx.textAlign = "center";
      ctx.fillText(marker.label, x, buy ? y - 13 : y + 18);
      ctx.restore();
    }

    if (this.hoverIndex != null) {
      const x = xFor(this.hoverIndex);
      ctx.strokeStyle = css("--line-strong");
      ctx.beginPath(); ctx.moveTo(x, bounds.top); ctx.lineTo(x, bounds.bottom); ctx.stroke();
      for (const series of this.options.series.filter((item) => item.type !== "bar")) {
        const value = Number(this.rows[this.hoverIndex][series.key]);
        if (!Number.isFinite(value)) continue;
        ctx.beginPath();
        ctx.fillStyle = series.color.startsWith("--") ? css(series.color) : series.color;
        ctx.arc(x, yFor(value), 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  onPointer(event) {
    if (!this.rows.length) return;
    const rect = this.canvas.getBoundingClientRect();
    const bounds = this.bounds(rect.width, rect.height);
    const localX = clamp(event.clientX - rect.left, bounds.left, bounds.right);
    const index = Math.round((localX - bounds.left) / Math.max(1, bounds.right - bounds.left) * (this.rows.length - 1));
    this.hoverIndex = index;
    const row = this.rows[index];
    const lines = this.options.series.map((series) => {
      const value = Number(row[series.key]);
      return Number.isFinite(value) ? `${series.label} ${series.format ? series.format(value) : value.toFixed(2)}` : null;
    }).filter(Boolean);
    const markerLines = this.markers.filter((marker) => this.markerIndex(marker) === index).map((marker) => `${marker.type === "buy" ? "买入" : "卖出"} ${formatMoney(marker.amount)} · ${Number(marker.units).toFixed(2)}份`);
    this.tooltip.innerHTML = `<strong>${row.date}</strong><br>${[...lines, ...markerLines].join("<br>")}`;
    this.tooltip.style.left = `${localX}px`;
    this.tooltip.style.top = `${Math.max(54, event.clientY - rect.top)}px`;
    this.tooltip.classList.add("visible");
    this.render();
  }
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

function initCharts() {
  state.navChart = new LineChart($("#navChart"), $("#navTooltip"), {
      series: [
        { key: "trendNav", label: "累计净值", color: "--teal", width: 2.1, format: (value) => value.toFixed(4) },
        { key: "ma5", label: "MA5", color: "--up", width: 1.1, format: (value) => value.toFixed(4) },
        { key: "ma10", label: "MA10", color: "--amber", width: 1.1, format: (value) => value.toFixed(4) },
        { key: "ma20", label: "MA20", color: "--purple", width: 1.25, format: (value) => value.toFixed(4) },
        { key: "ma60", label: "MA60", color: "--blue", width: 1.25, format: (value) => value.toFixed(4) },
        { key: "ma120", label: "MA120", color: "--muted", width: 1.15, format: (value) => value.toFixed(4) }
      ], axisFormat: (value) => value.toFixed(3)
    });
  state.charts = [
    state.navChart,
    new LineChart($("#kdjChart"), $("#kdjTooltip"), {
      series: [
        { key: "k", label: "K", color: "--teal", format: (value) => value.toFixed(1) },
        { key: "d", label: "D", color: "--amber", format: (value) => value.toFixed(1) },
        { key: "j", label: "J", color: "--purple", width: 1.1, format: (value) => value.toFixed(1) }
      ], referenceLines: [{ value: 20 }, { value: 80 }], axisFormat: (value) => value.toFixed(0)
    }),
    new LineChart($("#macdChart"), $("#macdTooltip"), {
      series: [
        { key: "macdHist", label: "柱", type: "bar", color: "--up", format: (value) => value.toFixed(4) },
        { key: "dif", label: "DIF", color: "--teal", format: (value) => value.toFixed(4) },
        { key: "dea", label: "DEA", color: "--amber", format: (value) => value.toFixed(4) }
      ], referenceLines: [{ value: 0 }], axisFormat: (value) => value.toFixed(3)
    }),
    new LineChart($("#rsiChart"), $("#rsiTooltip"), {
      series: [{ key: "rsi", label: "RSI", color: "--teal", width: 1.8, format: (value) => value.toFixed(1) }],
      min: 0, max: 100, referenceLines: [{ value: 30 }, { value: 70 }], axisFormat: (value) => value.toFixed(0)
    })
  ];
}

function renderWatchlist() {
  const list = $("#watchList");
  const groups = [...state.customGroups, "未分组"].filter((group, index, items) => items.indexOf(group) === index);
  list.innerHTML = groups.map((group) => {
    const funds = state.watchlist.filter((fund) => (fund.userGroup || "未分组") === group);
    if (!funds.length) return "";
    return `<div class="watch-group-title">${group}</div>${funds.map((fund) => `
      <button class="watch-item ${fund.code === state.code ? "active" : ""}" data-code="${fund.code}">
        <strong>${escapeHtml(fund.name)}</strong><span>${fund.code}</span><em>查看</em>
      </button>`).join("")}`;
  }).join("");
  list.querySelectorAll("button").forEach((button) => button.addEventListener("click", () => loadFund(button.dataset.code)));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function detailActionForSignal(signal) {
  const portfolioItem = state.portfolioPayload?.items?.find((item) => item.code === state.code && !item.error);
  if (portfolioItem) return compositeFor(portfolioItem).entry;
  if (signal.score <= signal.threshold.reduce) return { state: "sell", label: "风险退出", detail: "中长期趋势已达到防守阈值，执行前核对赎回费用、持有期限和组合替代方案" };
  if (signal.score >= signal.threshold.attention && signal.confidence >= 70) return { state: "base", label: "技术面通过", detail: "趋势等级达到阈值且有效指标同向率不低于70%；加入组合并完成正式净值与基本面校验后，才会生成分批建仓建议" };
  return { state: "wait", label: "等待确认", detail: "当前有效指标同向率不足以新增仓位，继续等待中长期趋势确认" };
}

function renderSignal(signal, analogs) {
  const action = detailActionForSignal(signal);
  setText("#trendScore", formatTrendLevel(signal.score));
  setText("#signalTitle", action.label);
  setText("#signalAction", `${action.detail}。技术结论：${signal.signal}。`);
  $("#signalBand").dataset.action = action.state;
  setText("#confidenceValue", `${signal.confidence}%`);
  $("#confidenceBar").style.width = `${signal.confidence}%`;
  $("#confidenceBar").style.background = signal.confidence >= 70 ? css("--up") : signal.confidence >= 55 ? css("--amber") : css("--muted");
  const agreementCount = signal.agreement?.total ? `${signal.agreement.aligned}/${signal.agreement.total}项有效指标` : "有效指标";
  const agreementMeaning = signal.confidence >= 80
    ? "高度一致，方向证据较强，仍需通过净值、风险和基本面验证"
    : signal.confidence >= 70
      ? "多数一致，可进入候选验证，不等于已经出现买点"
      : signal.confidence >= 55
        ? "部分一致，仅作观察，暂不据此新增仓位"
        : "分歧较大，不据此操作";
  setText("#confidenceCopy", `${agreementCount}与最终趋势方向同向；${agreementMeaning}。该比例不是上涨概率。`);
  $("#scoreRing").style.setProperty("--score-angle", `${(signal.score + 100) / 200 * 360}deg`);
  $("#scoreRing").style.color = signal.tone === "positive" ? css("--up") : signal.tone === "negative" ? css("--down") : css("--ink");

  if (analogs.sampleCount >= 10) {
    setText("#analogRate", `${analogs.positiveRate.toFixed(1)}%`);
    setText("#analogMedian", formatPct(analogs.medianReturn));
    setText("#analogCount", `${analogs.sampleCount}次`);
    $("#analogRate").className = analogs.positiveRate >= 50 ? "positive-text" : "negative-text";
    $("#analogMedian").className = signedClass(analogs.medianReturn);
  } else {
    setText("#analogRate", "样本不足"); setText("#analogMedian", "--"); setText("#analogCount", `${analogs.sampleCount}次`);
    $("#analogRate").className = ""; $("#analogMedian").className = "";
  }
}

function renderFactors(factors) {
  setText("#factorCount", `${factors.length} 项`);
  $("#factorList").innerHTML = factors.map((factor) => `
    <div class="factor-item ${factor.tone}">
      <i></i><div class="factor-copy"><strong>${escapeHtml(factor.label)}</strong><span title="${escapeHtml(factor.detail)}">${escapeHtml(factor.detail)}</span></div>
      <span class="factor-points">${factor.points > 0 ? "+" : ""}${factor.points}</span>
    </div>`).join("");
}

function renderBacktest(backtest) {
  if (!backtest) {
    ["#strategyReturn", "#benchmarkReturn", "#strategyDrawdown", "#benchmarkDrawdown", "#tradeCount", "#investedRatio", "#transactionCost"].forEach((selector) => setText(selector, "样本不足"));
    return;
  }
  setSignedValue("#strategyReturn", backtest.strategyReturn);
  setSignedValue("#benchmarkReturn", backtest.benchmarkReturn);
  setText("#strategyDrawdown", `最大回撤 ${formatPct(backtest.strategyMaxDrawdown)}`);
  setText("#benchmarkDrawdown", `最大回撤 ${formatPct(backtest.benchmarkMaxDrawdown)}`);
  setText("#tradeCount", `${backtest.trades} 次`);
  setText("#investedRatio", `${backtest.investedRatio.toFixed(1)}%`);
  setText("#transactionCost", `${backtest.transactionCost.toFixed(2)}%`);
  setText("#backtestRange", { "3m": "近3个月", "6m": "近6个月", "1y": "近1年", "3y": "近3年", all: "全部历史" }[state.range]);
}

function formatLargeNumber(value) {
  if (!Number.isFinite(value)) return "--";
  const absolute = Math.abs(value);
  if (absolute >= 100000000) return `${(value / 100000000).toFixed(2)}亿`;
  if (absolute >= 10000) return `${(value / 10000).toFixed(2)}万`;
  return value.toFixed(2);
}

function researchTone(score) {
  if (score == null) return { label: "数据不足", className: "" };
  if (score >= 25) return { label: "基本面偏强", className: "positive-text" };
  if (score <= -25) return { label: "基本面偏弱", className: "negative-text" };
  return { label: "基本面中性", className: "" };
}

function renderFundResearch(research) {
  const tone = researchTone(research.fundamentalScore);
  setText("#fundamentalScore", research.fundamentalScore == null ? "--" : `${research.fundamentalScore > 0 ? "+" : ""}${research.fundamentalScore}`);
  $("#fundamentalScore").className = tone.className;
  setText("#researchCoverage", `财报覆盖前十大权重 ${research.coverage.toFixed(1)}%`);
  setText("#holdingsReportDate", research.reportDate || "--");
  setText("#holdingsConcentration", research.concentration == null ? "--" : `${research.concentration.toFixed(2)}%`);
  setText("#systemTags", research.tags.length ? research.tags.join(" / ") : "未识别");
  const trendScore = state.payload?.analysis?.signal?.score ?? 0;
  const composite = research.fundamentalScore == null ? trendScore : Math.round(trendScore * .75 + research.fundamentalScore * .25);
  setText("#researchConclusion", `${tone.label} · 综合趋势等级 ${formatTrendLevel(composite)}`);

  $("#holdingsRows").innerHTML = research.topHoldings.length ? research.topHoldings.map((stock) => {
    const companyScore = stock.research?.score;
    const financial = stock.research?.financial;
    return `<tr class="holding-company-row" data-company-code="${stock.code}" data-company-name="${escapeHtml(stock.name)}" data-company-industry="${escapeHtml(stock.industry)}">
      <td><strong>${escapeHtml(stock.name)}</strong><span>${stock.code}</span></td>
      <td>${escapeHtml(stock.industry)}</td><td>${stock.weight.toFixed(2)}%</td>
      <td class="${stock.weightChange > 0 ? "positive-text" : stock.weightChange < 0 ? "negative-text" : ""}">${escapeHtml(stock.changeType || "--")} ${stock.weightChange ? `${stock.weightChange > 0 ? "+" : ""}${stock.weightChange.toFixed(2)}%` : ""}</td>
      <td>${financial ? `${escapeHtml(financial.reportType || "财报")}<small>${financial.reportDate || ""}</small>` : "暂无"}</td>
      <td class="${signedClass(companyScore)}">${companyScore == null ? "--" : `${companyScore > 0 ? "+" : ""}${companyScore}`}</td>
    </tr>`;
  }).join("") : '<tr><td colspan="6">暂未取得股票持仓披露</td></tr>';
  $$('[data-company-code]').forEach((row) => row.addEventListener("click", () => loadCompanyResearch(row.dataset.companyCode, row.dataset.companyName, row.dataset.companyIndustry)));
  const first = research.topHoldings.find((stock) => /^\d{6}$/.test(stock.code));
  if (first) loadCompanyResearch(first.code, first.name, first.industry);
}

async function loadFundResearch(code) {
  setText("#researchCoverage", "正在读取持仓与公司财报");
  $("#holdingsRows").innerHTML = '<tr><td colspan="6">正在读取最近披露持仓</td></tr>';
  $("#companyResearch").innerHTML = '<div class="company-placeholder"><strong>研究层计算中</strong><span>正在读取重仓公司财报和公告。</span></div>';
  try {
    const response = await fetch(`/api/research/fund/${code}`);
    const research = await response.json();
    if (!response.ok) throw new Error(research.error || "基金研究数据读取失败");
    renderFundResearch(research);
  } catch (error) {
    setText("#researchCoverage", "研究数据暂不可用");
    $("#holdingsRows").innerHTML = `<tr><td colspan="6">${escapeHtml(error.message)}</td></tr>`;
  }
}

function researchList(title, items, emptyText) {
  return `<section class="company-feed"><h4>${title}</h4>${items?.length ? items.map((item) => {
    const url = /^https:\/\//.test(item.url || "") ? item.url : "#";
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.date || "")} ${item.source ? `· ${escapeHtml(item.source)}` : ""}</span></a>`;
  }).join("") : `<p>${emptyText}</p>`}</section>`;
}

async function loadCompanyResearch(code, name, industry) {
  state.activeCompanyCode = code;
  $("#companyResearch").innerHTML = `<div class="company-placeholder"><strong>${escapeHtml(name)}</strong><span>正在读取财报、公告和行业信息。</span></div>`;
  $$('[data-company-code]').forEach((row) => row.classList.toggle("active", row.dataset.companyCode === code));
  try {
    const response = await fetch(`/api/research/company/${code}?name=${encodeURIComponent(name)}&industry=${encodeURIComponent(industry)}`);
    const research = await response.json();
    if (!response.ok) throw new Error(research.error || "公司研究数据读取失败");
    if (state.activeCompanyCode !== code) return;
    const financial = research.financial;
    const tone = researchTone(research.score);
    $("#companyResearch").innerHTML = `
      <div class="company-title"><div><span>${escapeHtml(industry)}</span><h3>${escapeHtml(name)} <small>${code}</small></h3></div><strong class="${tone.className}">${research.score == null ? "--" : `${research.score > 0 ? "+" : ""}${research.score}`}</strong></div>
      ${financial ? `<div class="company-financials">
        <div><span>报告期</span><strong>${financial.reportType || "--"}</strong><small>${financial.reportDate || ""}</small></div>
        <div><span>营业收入</span><strong>${formatLargeNumber(financial.revenue)}</strong><small class="${signedClass(financial.revenueGrowth)}">同比 ${formatPct(financial.revenueGrowth)}</small></div>
        <div><span>归母净利润</span><strong>${formatLargeNumber(financial.netProfit)}</strong><small class="${signedClass(financial.profitGrowth)}">同比 ${formatPct(financial.profitGrowth)}</small></div>
        <div><span>ROE / 毛利率</span><strong>${formatPct(financial.roe)}</strong><small>毛利率 ${formatPct(financial.grossMargin)}</small></div>
      </div>` : '<p class="research-unavailable">暂未取得标准化财报数据。</p>'}
      ${researchList("公司公告", research.announcements, "近期没有取得公告")}
      ${researchList("公司相关新闻", research.news, "近期没有取得相关新闻")}
      ${researchList("行业与政策信息", research.policyNews, "近期没有取得政策信息")}`;
  } catch (error) {
    $("#companyResearch").innerHTML = `<div class="company-placeholder"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(error.message)}</span></div>`;
  }
}

function renderPayload(payload) {
  state.payload = payload;
  const { fund, analysis } = payload;
  const { current, signal, analogs, rows } = analysis;
  setText("#fundName", fund.name);
  setText("#fundCode", fund.code);
  updateCurrentFundButton();
  setText("#navDate", `最近净值 ${current.date}`);
  setText("#dataSource", `数据源 ${fund.source}`);
  setText("#sourceStatus", fund.cache === "stale" ? "使用本地缓存" : `净值更新至 ${current.date}`);
  setText("#currentNav", formatNumber(current.nav));
  setSignedValue("#dailyChange", current.dailyChange);
  setSignedValue("#returnMonth", current.periodReturns.month);
  setSignedValue("#returnQuarter", current.periodReturns.quarter);
  setSignedValue("#returnYear", current.periodReturns.year);
  setSignedValue("#currentDrawdown", current.drawdown);
  setText("#volatility", current.volatility == null ? "--" : `${current.volatility.toFixed(2)}%`);
  $("#volatility").className = current.volatility >= 30 ? "negative-text" : "";
  setText("#kdjValues", `K ${formatNumber(current.k, 1)} · D ${formatNumber(current.d, 1)} · J ${formatNumber(current.j, 1)}`);
  setText("#macdValues", `DIF ${formatNumber(current.dif, 4)} · DEA ${formatNumber(current.dea, 4)}`);
  setText("#rsiValue", formatNumber(current.rsi, 1));
  renderSignal(signal, analogs);
  renderFactors(signal.factors);
  renderBacktest(analysis.backtest);
  state.charts.forEach((chart) => chart.setData(rows));
  $("#tradeDate").max = localDateString();
  $("#tradeDate").value = current.date || localDateString();
  $("#tradeNav").value = Number(current.nav).toFixed(4);
  $("#tradeAmount").value = "";
  $("#tradeUnits").value = "";
  $("#tradeNote").value = "";
  renderTradeJournal();
  renderWatchlist();
}

async function loadFund(code = state.code) {
  if (!/^\d{6}$/.test(code)) return showToast("请输入6位基金代码");
  showView("detail");
  setLoading(true);
  state.code = code;
  localStorage.setItem("fund-code", code);
  try {
    const response = await fetch(`/api/fund/${code}?profile=${state.profile}&range=${state.range}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "数据读取失败");
    renderPayload(payload);
    loadFundResearch(code);
    if (payload.fund.staleReason) showToast("上游数据暂不可用，当前显示最近一次缓存");
  } catch (error) {
    showToast(error.message);
    setText("#sourceStatus", "数据连接失败");
  } finally {
    setLoading(false);
  }
}

async function searchFunds(query) {
  const results = $("#searchResults");
  if (!query.trim()) { results.hidden = true; return; }
  $("#searchSpinner").classList.add("visible");
  try {
    const response = await fetch("/api/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: query.trim() }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "搜索失败");
    results.innerHTML = payload.results.length ? payload.results.map((fund) => {
      const added = state.portfolio.some((item) => item.code === fund.code);
      return `<div class="search-result">
        <button class="search-result-main" data-search-open="${fund.code}"><strong>${escapeHtml(fund.name)}</strong><span>${fund.code} · ${escapeHtml(fund.type)}${fund.nav ? ` · 净值 ${fund.nav}` : ""}</span></button>
        <button class="icon-button small search-result-add" data-search-add="${fund.code}" data-search-name="${escapeHtml(fund.name)}" title="${added ? "已在自选" : "加入自选"}" aria-label="${added ? "已在自选" : `将${escapeHtml(fund.name)}加入自选`}" ${added ? "disabled" : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${added ? "m5 12 4 4L19 6" : "M12 5v14M5 12h14"}"/></svg></button>
      </div>`;
    }).join("") : '<div class="search-result-empty"><strong>没有找到匹配基金</strong><span>可以直接输入6位基金代码</span></div>';
    results.hidden = false;
    results.querySelectorAll("[data-search-open]").forEach((button) => button.addEventListener("click", () => {
      $("#fundSearch").value = "";
      results.hidden = true;
      loadFund(button.dataset.searchOpen);
    }));
    results.querySelectorAll("[data-search-add]").forEach((button) => button.addEventListener("click", () => {
      if (addFundToPortfolio({ code: button.dataset.searchAdd, name: button.dataset.searchName })) {
        button.disabled = true;
        button.title = "已在自选";
      }
    }));
  } catch (error) { showToast(error.message); }
  finally { $("#searchSpinner").classList.remove("visible"); }
}

function bindControls() {
  const installButton = $("#installButton");
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.installPrompt = event;
    installButton.hidden = false;
  });
  window.addEventListener("appinstalled", () => {
    state.installPrompt = null;
    installButton.hidden = true;
    showToast("净值罗盘已安装到当前设备");
  });
  installButton.addEventListener("click", async () => {
    if (!state.installPrompt) return showToast("可在浏览器菜单中选择“安装应用”或“添加到主屏幕”");
    await state.installPrompt.prompt();
    await state.installPrompt.userChoice;
    state.installPrompt = null;
    installButton.hidden = true;
  });

  $("#shareButton").addEventListener("click", async () => {
    const shareData = { title: document.title, text: "净值罗盘：场外基金趋势与风险研究平台", url: window.location.href };
    try {
      if (navigator.share) await navigator.share(shareData);
      else {
        await navigator.clipboard.writeText(shareData.url);
        showToast("平台网址已复制，可发送到其他手机或电脑");
      }
    } catch (error) {
      if (error?.name !== "AbortError") showToast("分享未完成，请复制浏览器地址栏中的网址");
    }
  });

  $$(".view-switch button").forEach((button) => button.addEventListener("click", () => {
    showView(button.dataset.view);
    if (button.dataset.view === "portfolio" && !state.portfolioPayload) refreshPortfolio();
    if (button.dataset.view === "detail" && !state.payload) loadFund();
  }));

  $("#fundSearch").addEventListener("input", (event) => {
    clearTimeout(state.searchTimer);
    const query = event.target.value;
    state.searchTimer = setTimeout(() => searchFunds(query), 280);
  });
  $("#fundSearch").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && /^\d{6}$/.test(event.target.value.trim())) {
      $("#searchResults").hidden = true;
      loadFund(event.target.value.trim());
    }
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".search-section")) $("#searchResults").hidden = true;
  });

  $$("#rangeControl button").forEach((button) => {
    button.classList.toggle("active", button.dataset.range === state.range);
    button.addEventListener("click", () => {
      if (state.range === button.dataset.range) return;
      state.range = button.dataset.range;
      localStorage.setItem("fund-range", state.range);
      $$("#rangeControl button").forEach((item) => item.classList.toggle("active", item === button));
      loadFund();
    });
  });

  $$("#profileControl button").forEach((button) => {
    button.classList.toggle("active", button.dataset.profile === state.profile);
    button.addEventListener("click", () => {
      if (state.profile === button.dataset.profile) return;
      state.profile = button.dataset.profile;
      localStorage.setItem("fund-profile", state.profile);
      $$("#profileControl button").forEach((item) => item.classList.toggle("active", item === button));
      setText("#profileNote", profileCopy(state.profile));
      if (state.view === "portfolio") refreshPortfolio({ silent: true });
      else loadFund();
      refreshMarketOpportunities();
    });
  });
  setText("#profileNote", profileCopy(state.profile));

  $("#addCurrentButton").addEventListener("click", () => {
    if (!state.payload) return;
    const fund = state.payload.fund;
    const existingIndex = state.portfolio.findIndex((item) => item.code === fund.code);
    if (existingIndex >= 0) {
      if (!window.confirm(`确认从当前浏览器组合中移除“${fund.name}”吗？`)) return;
      state.portfolio.splice(existingIndex, 1);
      delete state.portfolioUnits[fund.code];
      delete state.strategySettings.fundTargets[fund.code];
      delete state.strategySettings.fundCostNavs[fund.code];
      localStorage.setItem("fund-portfolio-units", JSON.stringify(state.portfolioUnits));
      saveStrategySettings(); savePortfolio(); renderGroupOptions(); renderWatchlist(); updateCurrentFundButton();
      showToast("已从当前浏览器组合中移除");
      refreshPortfolio();
      return;
    }
    addFundToPortfolio(fund);
  });

  const savedTheme = localStorage.getItem("fund-theme");
  if (savedTheme === "dark") document.documentElement.dataset.theme = "dark";
  $("#themeButton").addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme !== "dark";
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("fund-theme", dark ? "dark" : "light");
    state.charts.forEach((chart) => chart.render());
  });

  $("#refreshPortfolioButton").addEventListener("click", () => refreshPortfolio());
  $$("#portfolioFilter button").forEach((button) => button.addEventListener("click", () => setPortfolioFilter(button.dataset.filter)));
  $$("[data-summary-action]").forEach((button) => button.addEventListener("click", () => setPortfolioFilter(button.dataset.summaryAction)));
  $("#portfolioGroup").addEventListener("change", (event) => {
    state.portfolioGroup = event.target.value;
    renderPortfolioRows();
  });
  const groupModal = $("#groupModal");
  $("#manageGroupsButton").addEventListener("click", () => { renderGroupModal(); groupModal.hidden = false; });
  $("#closeGroupModal").addEventListener("click", () => { groupModal.hidden = true; });
  groupModal.addEventListener("click", (event) => { if (event.target === groupModal) groupModal.hidden = true; });
  $("#createGroupButton").addEventListener("click", () => {
    const input = $("#newGroupName");
    const name = input.value.trim();
    if (!name) return showToast("请输入分组名称");
    if (state.customGroups.includes(name)) return showToast("该分组已经存在");
    state.customGroups.splice(Math.max(1, state.customGroups.length - 1), 0, name);
    input.value = "";
    savePortfolio(); renderGroupOptions(); renderWatchlist(); renderPortfolioRows();
  });
  $("#newGroupName").addEventListener("keydown", (event) => { if (event.key === "Enter") $("#createGroupButton").click(); });

  $("#tradeEntryForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const date = $("#tradeDate").value;
    const type = $("#tradeType").value;
    const nav = Number($("#tradeNav").value);
    const amountInput = $("#tradeAmount").value.trim();
    const unitsInput = $("#tradeUnits").value.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > localDateString()) return showToast("确认日期不能晚于今天");
    if (!["buy", "sell"].includes(type) || !Number.isFinite(nav) || nav <= 0) return showToast("请输入有效的交易方向和确认净值");
    if (!amountInput && !unitsInput) return showToast("交易金额和确认份额至少填写一项");
    let amount = amountInput ? Number(amountInput) : null;
    let units = unitsInput ? Number(unitsInput) : null;
    if ((amount != null && (!Number.isFinite(amount) || amount <= 0)) || (units != null && (!Number.isFinite(units) || units <= 0))) return showToast("交易金额和确认份额必须大于0");
    if (amount == null) amount = units * nav;
    if (units == null) units = amount / nav;
    const record = {
      id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      date,
      type,
      nav: Number(nav.toFixed(4)),
      amount: Number(amount.toFixed(2)),
      units: Number(units.toFixed(2)),
      note: $("#tradeNote").value.trim(),
      createdAt: new Date().toISOString()
    };
    state.tradeHistory[state.code] = [record, ...tradesFor()].slice(0, 500);
    saveTradeHistory();
    $("#tradeAmount").value = "";
    $("#tradeUnits").value = "";
    $("#tradeNote").value = "";
    renderTradeJournal();
    showToast(`${type === "buy" ? "买入" : "卖出"}记录已保存并标记到净值图`);
  });

  const strategyModal = $("#strategyModal");
  const openStrategyModal = () => {
    state.strategyFundCode = state.portfolio.some((fund) => fund.code === state.code) ? state.code : state.strategyFundCode;
    renderStrategyModal();
    strategyModal.hidden = false;
  };
  $("#strategyButton").addEventListener("click", openStrategyModal);
  $("#targetSettingsButton").addEventListener("click", openStrategyModal);
  $("#closeStrategyModal").addEventListener("click", () => { strategyModal.hidden = true; });
  strategyModal.addEventListener("click", (event) => { if (event.target === strategyModal) strategyModal.hidden = true; });
  $("#strategyFundSelect").addEventListener("change", (event) => { state.strategyFundCode = event.target.value; renderStrategyFundFields(); });
  $("#resetFundStrategyButton").addEventListener("click", () => {
    if (!state.strategyFundCode) return;
    delete state.strategySettings.fundTargets[state.strategyFundCode];
    delete state.strategySettings.fundCostNavs[state.strategyFundCode];
    saveStrategySettings();
    renderStrategyFundFields();
    if (state.portfolioPayload) renderPortfolio(state.portfolioPayload);
    showToast("该基金已恢复默认策略");
  });
  $("#saveStrategyButton").addEventListener("click", () => {
    const defaultTarget = Number($("#defaultTakeProfitInput").value);
    if (!Number.isFinite(defaultTarget) || defaultTarget < 5 || defaultTarget > 200) return showToast("默认止盈目标需在5%至200%之间");
    state.strategySettings.defaultTakeProfitPct = normalizeTarget(defaultTarget);
    const code = state.strategyFundCode;
    const fundTargetValue = $("#fundTakeProfitInput").value.trim();
    const costNavValue = $("#fundCostNavInput").value.trim();
    if (fundTargetValue) {
      const target = Number(fundTargetValue);
      if (!Number.isFinite(target) || target < 5 || target > 200) return showToast("单基金止盈目标需在5%至200%之间");
      state.strategySettings.fundTargets[code] = normalizeTarget(target);
    } else delete state.strategySettings.fundTargets[code];
    if (costNavValue) {
      const costNav = Number(costNavValue);
      if (!Number.isFinite(costNav) || costNav <= 0) return showToast("持仓成本净值必须大于0");
      state.strategySettings.fundCostNavs[code] = costNav;
    } else delete state.strategySettings.fundCostNavs[code];
    saveStrategySettings();
    strategyModal.hidden = true;
    if (state.portfolioPayload) renderPortfolio(state.portfolioPayload);
    if (state.payload) renderSignal(state.payload.analysis.signal, state.payload.analysis.analogs);
    showToast("策略设置已保存");
  });

  const notificationButton = $("#notificationButton");
  const updateNotificationButton = () => {
    const enabled = ("Notification" in window) && Notification.permission === "granted" && localStorage.getItem("fund-notifications") === "on";
    notificationButton.classList.toggle("active", enabled);
    notificationButton.querySelector("span").textContent = enabled ? "提醒已开启" : "开启提醒";
  };
  updateNotificationButton();
  notificationButton.addEventListener("click", async () => {
    if (!("Notification" in window)) return showToast("当前浏览器不支持桌面通知");
    if (Notification.permission === "denied") return showToast("通知权限已被浏览器关闭，请在网站权限中重新开启");
    if (localStorage.getItem("fund-notifications") === "on") {
      localStorage.setItem("fund-notifications", "off");
      updateNotificationButton();
      return showToast("策略变化提醒已关闭");
    }
    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      localStorage.setItem("fund-notifications", "on");
      updateNotificationButton();
      showToast("提醒已开启，仓位动作发生变化时会发送桌面通知");
    }
  });

  const privacyModal = $("#privacyModal");
  $("#privacyButton").addEventListener("click", () => {
    setText("#privateFundCount", `${state.portfolio.length} 只本地基金`);
    $("#vaultPassphrase").value = "";
    $("#vaultPassphraseConfirm").value = "";
    privacyModal.hidden = false;
  });
  $("#closePrivacyModal").addEventListener("click", () => { privacyModal.hidden = true; });
  privacyModal.addEventListener("click", (event) => { if (event.target === privacyModal) privacyModal.hidden = true; });
  $("#exportVaultButton").addEventListener("click", async () => {
    const passphrase = $("#vaultPassphrase").value;
    if (passphrase !== $("#vaultPassphraseConfirm").value) return showToast("两次输入的保险箱密码不一致");
    try {
      const vault = await encryptVault(collectPrivateStorage(), passphrase);
      downloadJsonFile(vault, `fund-trend-vault-${new Date().toISOString().slice(0, 10)}.json`);
      showToast("加密保险箱已导出，请将密码与文件分开保存");
    } catch (error) { showToast(error.message); }
  });
  $("#chooseVaultButton").addEventListener("click", () => $("#vaultFileInput").click());
  $("#clearPrivateDataButton").addEventListener("click", () => {
    const button = $("#clearPrivateDataButton");
    if (button.dataset.confirmed !== "yes") {
      button.dataset.confirmed = "yes";
      button.textContent = "再次点击确认永久清除";
      clearTimeout(button.confirmTimer);
      button.confirmTimer = setTimeout(() => { button.dataset.confirmed = ""; button.textContent = "清除当前浏览器数据"; }, 5000);
      return;
    }
    const keys = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith("fund-")) keys.push(key);
    }
    keys.forEach((key) => localStorage.removeItem(key));
    window.location.reload();
  });
  $("#vaultFileInput").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return showToast("保险箱文件不能超过5MB");
    const passphrase = $("#vaultPassphrase").value;
    try {
      const vault = JSON.parse(await file.text());
      const payload = await decryptVault(vault, passphrase);
      if (!window.confirm("导入会覆盖当前浏览器中的基金、分组、成本和策略设置。确认继续吗？")) return;
      applyPrivateStorage(payload);
      window.location.reload();
    } catch (error) { showToast(error.message); }
  });
}

initCharts();
bindControls();
renderGroupOptions();
renderWatchlist();
localStorage.setItem("fund-watchlist", JSON.stringify(state.watchlist));
showView("portfolio");
refreshPortfolio();
refreshMarketOpportunities();
setInterval(updateRefreshCountdown, 1000);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
