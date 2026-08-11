import http from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeFund, sliceByRange } from "./src/indicators.mjs";
import { fetchFund, fetchFundRankings, fetchFundSnapshots, searchFunds } from "./src/data-source.mjs";
import {
  fetchCompanyAnnouncements,
  fetchCompanyFinancial,
  fetchFundHoldings,
  holdingSimilarity,
  scoreCompanyResearch,
  searchResearchNews,
  summarizeFundResearch
} from "./src/research-source.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const cacheDir = path.join(root, ".cache");
const researchCacheDir = path.join(cacheDir, "research");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";
const allowIndexing = process.env.ALLOW_INDEXING === "true";
const memoryCache = new Map();
const researchMemoryCache = new Map();
const rateBuckets = new Map();
const DETAIL_CACHE_TTL = 15 * 60 * 1000;
const PORTFOLIO_CACHE_TTL = 6 * 60 * 60 * 1000;
const MARKET_OPPORTUNITY_TTL = 30 * 60 * 1000;

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function applySecurityHeaders(response) {
  response.setHeader("content-security-policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("x-robots-tag", allowIndexing ? "index, follow" : "noindex, nofollow");
  response.setHeader("cross-origin-opener-policy", "same-origin");
  response.setHeader("cross-origin-resource-policy", "same-origin");
  response.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
}

async function readJsonBody(request) {
  if (request.method !== "POST") return {};
  let total = 0;
  const chunks = [];
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 64 * 1024) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("请求格式无效"); }
}

function clientAddress(request) {
  return String(request.headers["cf-connecting-ip"] || request.headers["x-forwarded-for"] || request.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function rateLimit(request, response) {
  const now = Date.now();
  const key = clientAddress(request);
  const current = rateBuckets.get(key);
  const bucket = !current || now - current.startedAt >= 60_000 ? { startedAt: now, count: 0 } : current;
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  if (rateBuckets.size > 2000) {
    for (const [address, entry] of rateBuckets) if (now - entry.startedAt >= 120_000) rateBuckets.delete(address);
  }
  response.setHeader("x-ratelimit-limit", "120");
  response.setHeader("x-ratelimit-remaining", String(Math.max(0, 120 - bucket.count)));
  if (bucket.count <= 120) return false;
  response.setHeader("retry-after", "60");
  json(response, 429, { error: "请求过于频繁，请稍后再试" });
  return true;
}

function cachedFundDate(data) {
  const timestamp = data?.points?.at(-1)?.timestamp;
  if (!timestamp) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(timestamp));
}

function cacheIsUsable(entry, maxAge, snapshot) {
  if (!entry || Date.now() - entry.savedAt >= maxAge) return false;
  return !snapshot?.date || cachedFundDate(entry.data) === snapshot.date;
}

async function getFundWithCache(code, { maxAge = DETAIL_CACHE_TTL, snapshot = null } = {}) {
  const inMemory = memoryCache.get(code);
  if (cacheIsUsable(inMemory, maxAge, snapshot)) return { ...inMemory.data, cache: "memory" };
  const cacheFile = path.join(cacheDir, `${code}.json`);
  try {
    const cached = JSON.parse(await readFile(cacheFile, "utf8"));
    if (cacheIsUsable(cached, maxAge, snapshot)) {
      memoryCache.set(code, cached);
      return { ...cached.data, cache: "disk" };
    }
  } catch {}
  try {
    const data = await fetchFund(code);
    const entry = { savedAt: Date.now(), data };
    memoryCache.set(code, entry);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cacheFile, JSON.stringify(entry), "utf8");
    return { ...data, cache: "fresh" };
  } catch (error) {
    try {
      const cached = JSON.parse(await readFile(cacheFile, "utf8"));
      return { ...cached.data, cache: "stale", staleReason: error.message };
    } catch { throw error; }
  }
}

async function getResearchCached(key, maxAge, worker) {
  const memory = researchMemoryCache.get(key);
  if (memory && Date.now() - memory.savedAt < maxAge) return memory.data;
  const file = path.join(researchCacheDir, `${key.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
  try {
    const cached = JSON.parse(await readFile(file, "utf8"));
    if (Date.now() - cached.savedAt < maxAge) {
      researchMemoryCache.set(key, cached);
      return cached.data;
    }
  } catch {}
  const data = await worker();
  const entry = { savedAt: Date.now(), data };
  researchMemoryCache.set(key, entry);
  await mkdir(researchCacheDir, { recursive: true });
  await writeFile(file, JSON.stringify(entry), "utf8");
  return data;
}

const getHoldings = (code) => getResearchCached(`holdings-${code}`, 12 * 60 * 60 * 1000, () => fetchFundHoldings(code));
const getFinancial = (code) => getResearchCached(`financial-${code}`, 24 * 60 * 60 * 1000, () => fetchCompanyFinancial(code));
const getAnnouncements = (code) => getResearchCached(`announcements-${code}`, 60 * 60 * 1000, () => fetchCompanyAnnouncements(code, 6));
const getNews = (key, keyword, filters) => getResearchCached(`news-v3-${key}`, 30 * 60 * 1000, () => searchResearchNews(keyword, 6, filters));
const policyTerms = ["政策", "产业规划", "通知", "意见", "办法", "方案", "指引", "国务院", "发改委", "工信部", "财政部", "监管", "补贴", "税收", "关税", "出口管制", "国家标准"];

async function getCompanyResearch(code) {
  const [financial, announcements] = await Promise.all([getFinancial(code), getAnnouncements(code)]);
  return { code, financial, announcements, ...scoreCompanyResearch(financial, announcements) };
}

async function buildSingleFundResearch(code, companyLimit = 10) {
  const holdings = await getHoldings(code);
  const eligible = holdings.stocks.filter((stock) => /^\d{6}$/.test(stock.code)).slice(0, companyLimit);
  const companies = await mapLimited(eligible, 4, async (stock) => {
    try { return await getCompanyResearch(stock.code); }
    catch (error) { return { code: stock.code, error: error.message, score: null }; }
  });
  return summarizeFundResearch(holdings, companies);
}

async function buildPortfolioResearch(codes) {
  const holdingsList = await mapLimited(codes, 4, async (code) => {
    try { return await getHoldings(code); }
    catch (error) { return { code, reportDate: null, stocks: [], error: error.message }; }
  });
  const companyCodes = [...new Set(holdingsList.flatMap((holding) => holding.stocks.filter((stock) => /^\d{6}$/.test(stock.code)).slice(0, 10).map((stock) => stock.code)))];
  const companyList = await mapLimited(companyCodes, 5, async (code) => {
    try {
      const financial = await getFinancial(code);
      return { code, financial, announcements: [], ...scoreCompanyResearch(financial, []) };
    }
    catch (error) { return { code, error: error.message, score: null }; }
  });
  const companyMap = new Map(companyList.map((company) => [company.code, company]));
  const items = holdingsList.map((holdings) => {
    const companies = holdings.stocks.slice(0, 10).map((stock) => companyMap.get(stock.code)).filter(Boolean);
    const summary = summarizeFundResearch(holdings, companies);
    return { code: holdings.code, error: holdings.error, ...summary };
  });
  for (let i = 0; i < items.length; i += 1) {
    const similarities = [];
    for (let j = 0; j < items.length; j += 1) {
      if (i === j) continue;
      const value = holdingSimilarity(holdingsList[i], holdingsList[j]);
      if (value >= 8) similarities.push({ code: items[j].code, overlap: value });
    }
    items[i].similarFunds = similarities.sort((a, b) => b.overlap - a.overlap).slice(0, 5);
  }
  return { generatedAt: new Date().toISOString(), items };
}

function chinaClock(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { ...parts, hour: Number(parts.hour), minute: Number(parts.minute) };
}

function dateString(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function previousBusinessDay(date) {
  const result = new Date(date);
  do { result.setUTCDate(result.getUTCDate() - 1); } while ([0, 6].includes(result.getUTCDay()));
  return result;
}

function expectedOfficialDate(now = new Date()) {
  const clock = chinaClock(now);
  let date = new Date(`${clock.year}-${clock.month}-${clock.day}T00:00:00Z`);
  const weekday = date.getUTCDay();
  if (weekday === 0 || weekday === 6) {
    while ([0, 6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() - 1);
    return dateString(date);
  }
  if (clock.hour < 20) date = previousBusinessDay(date);
  return dateString(date);
}

function businessLag(actualDate, expectedDate) {
  if (!actualDate || actualDate >= expectedDate) return 0;
  const cursor = new Date(`${actualDate}T00:00:00Z`);
  const end = new Date(`${expectedDate}T00:00:00Z`);
  let count = 0;
  while (cursor < end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (![0, 6].includes(cursor.getUTCDay())) count += 1;
  }
  return count;
}

function marketStatus() {
  const clock = chinaClock();
  const date = new Date(`${clock.year}-${clock.month}-${clock.day}T00:00:00Z`);
  const weekday = date.getUTCDay();
  const minutes = clock.hour * 60 + clock.minute;
  const tradingDay = weekday >= 1 && weekday <= 5;
  const open = tradingDay && ((minutes >= 570 && minutes < 690) || (minutes >= 780 && minutes < 900));
  const updateWindow = tradingDay && minutes >= 1080 && minutes < 1440;
  return { open, updateWindow, label: open ? "A股交易时段" : updateWindow ? "等待官方净值更新" : "非交易时段" };
}

function assessEntry(analysis) {
  const { current, signal } = analysis;
  if (analysis.rows.length < 120) return { state: "neutral", label: "样本不足", priority: 1, detail: "历史净值少于120个净值日，暂不触发中长期入仓信号" };
  const confirmations = [
    current.trendNav > current.ma20,
    current.k > current.d,
    current.macdHist > 0,
    current.rsi >= 45 && current.rsi < 73
  ].filter(Boolean).length;
  if (signal.score >= signal.threshold.attention && signal.confidence >= 70 && confirmations >= 3) {
    return { state: "candidate", label: "可分批建仓", priority: 4, detail: `20-120日趋势达到阈值，${signal.confidence}%有效指标同向且至少三项核心指标确认` };
  }
  if (signal.score >= signal.threshold.attention - 14 && signal.confidence >= 55 && confirmations >= 2) {
    return { state: "watch", label: "转强观察", priority: 3, detail: "中长期趋势正在改善，但还未达到建仓阈值" };
  }
  if (signal.score <= signal.threshold.reduce) {
    return { state: "risk", label: "弱势防守", priority: 2, detail: "中长期弱势指标达到风险阈值" };
  }
  return signal.score >= 0
    ? { state: "neutral", label: "持有观察", priority: 1, detail: "趋势未达到新增仓位阈值，已有仓位继续观察" }
    : { state: "neutral", label: "等待企稳", priority: 1, detail: "趋势等级偏弱，但尚未达到防守阈值" };
}

async function mapLimited(items, limit, worker) {
  const results = Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function buildPortfolio(codes, profile) {
  let snapshots = new Map();
  try { snapshots = await fetchFundSnapshots(codes); } catch {}
  const expectedDate = expectedOfficialDate();
  const items = await mapLimited(codes, 4, async (code) => {
    try {
      const snapshot = snapshots.get(code);
      const fund = await getFundWithCache(code, { maxAge: PORTFOLIO_CACHE_TTL, snapshot });
      const analysis = analyzeFund(fund.points, profile);
      const dateMatches = snapshot?.date === analysis.current.date;
      const navMatches = snapshot && Math.abs(snapshot.nav - analysis.current.nav) < 0.000001;
      const lag = businessLag(analysis.current.date, expectedDate);
      const quality = dateMatches && navMatches ? "verified" : snapshot ? "mismatch" : "single-source";
      let entry = assessEntry(analysis);
      if ((quality === "mismatch" || lag > 0) && entry.state === "candidate") {
        entry = { state: "watch", label: "数据待确认", priority: 3, detail: "数据日期或净值交叉校验未通过，暂停入仓提示" };
      }
      return {
        code,
        name: fund.name,
        current: analysis.current,
        signal: {
          score: analysis.signal.score,
          signal: analysis.signal.signal,
          tone: analysis.signal.tone,
          confidence: analysis.signal.confidence,
          agreement: analysis.signal.agreement,
          threshold: analysis.signal.threshold
        },
        entry,
        data: {
          quality,
          lagBusinessDays: lag,
          expectedDate,
          sourceDate: analysis.current.date,
          source: fund.source,
          cache: fund.cache
        }
      };
    } catch (error) {
      return { code, error: error.message, entry: { state: "error", label: "数据异常", priority: 0 } };
    }
  });
  items.sort((left, right) => (right.entry?.priority ?? 0) - (left.entry?.priority ?? 0) || (right.signal?.score ?? -999) - (left.signal?.score ?? -999));
  return {
    items,
    generatedAt: new Date().toISOString(),
    expectedOfficialDate: expectedDate,
    market: marketStatus(),
    refreshAfterSeconds: 300,
    methodology: "仅使用官方已披露净值生成信号；盘中估值不作为入仓依据。"
  };
}

function fundFamilyName(name) {
  return String(name ?? "").replace(/[ACIE]$/i, "").replace(/\s+/g, "").toLowerCase();
}

function opportunityBaseScore(candidate) {
  const clampValue = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));
  const { analysis, ranking } = candidate;
  const riskPenalty = Math.max(0, (analysis.current.volatility ?? 0) - 30) * 0.35 + Math.max(0, -(analysis.current.drawdown ?? 0) - 15) * 0.45;
  return analysis.signal.score * 0.5
    + clampValue(ranking.quarterReturn, -40, 80) * 0.28
    + clampValue(ranking.monthReturn, -20, 30) * 0.22
    - riskPenalty;
}

async function buildOpportunityFundamental(holdings) {
  const eligible = holdings.stocks.filter((stock) => /^\d{6}$/.test(stock.code)).slice(0, 5);
  const companies = await mapLimited(eligible, 4, async (stock) => {
    try {
      const financial = await getFinancial(stock.code);
      return { code: stock.code, financial, announcements: [], ...scoreCompanyResearch(financial, []) };
    } catch (error) { return { code: stock.code, error: error.message, score: null }; }
  });
  return summarizeFundResearch(holdings, companies);
}

function assessMarketOpportunity(candidate) {
  const { analysis, dataQuality, ranking, research } = candidate;
  const technical = assessEntry(analysis);
  const fundamentalsUsable = research.fundamentalScore != null && research.coverage >= 15;
  const fundamentalsPass = fundamentalsUsable && research.fundamentalScore >= -10;
  const overextended = analysis.current.rsi >= 74
    || analysis.current.volatility >= 45
    || ranking.monthReturn >= 25;
  if (dataQuality !== "verified") return { state: "wait", label: "数据待确认", detail: "排行净值与正式历史净值尚未完成一致性校验，暂不用于建仓参考" };
  if (technical.state === "risk") return { state: "sell", label: "暂不跟随", detail: "中长期趋势处于防守区，即使区间收益靠前也不作为建仓候选" };
  if (technical.state === "candidate" && fundamentalsPass && !overextended) {
    return { state: "base", label: "可研究建仓", detail: "趋势、动能、风险和持仓基本面均通过当前阈值；只适合作为分批研究候选，不建议追涨一次买入" };
  }
  if (technical.state === "candidate" && overextended) return { state: "wait", label: "等待回撤", detail: "中期趋势较强，但RSI、波动或近1月涨幅显示追涨风险，等待回撤后重新验证" };
  if (!fundamentalsUsable) return { state: "hold", label: "仅作强势对比", detail: "区间收益和技术趋势较强，但持仓财务覆盖不足，暂不生成建仓参考" };
  return { state: "hold", label: "继续跟踪", detail: "基金位于强势样本中，但有效指标同向率或基本面尚未达到建仓阈值" };
}

async function buildMarketOpportunities(profile) {
  const [quarterRankings, monthRankings] = await Promise.all([
    fetchFundRankings({ pageSize: 100, sort: "3yzf" }),
    fetchFundRankings({ pageSize: 100, sort: "1yzf" })
  ]);
  const unique = [];
  const families = new Set();
  for (let index = 0; index < 80 && unique.length < 60; index += 1) {
    for (const ranking of [quarterRankings[index], monthRankings[index]]) {
      if (!ranking) continue;
      const family = fundFamilyName(ranking.name);
      if (families.has(family)) continue;
      families.add(family);
      unique.push(ranking);
    }
  }
  const sectorPool = await mapLimited(unique, 6, async (ranking) => {
    try {
      const holdings = await getHoldings(ranking.code);
      if (!holdings.stocks.length) return null;
      const sectorSummary = summarizeFundResearch(holdings, []);
      if (!sectorSummary.dominantSector || sectorSummary.dominantSector === "其他") return null;
      const growthScore = Math.min(80, ranking.quarterReturn ?? 0) * 0.55 + Math.min(35, ranking.monthReturn ?? 0) * 0.45;
      return { ranking, holdings, sectorSummary, growthScore };
    } catch { return null; }
  });
  const sectorShortlist = new Map();
  for (const candidate of sectorPool.filter(Boolean)) {
    const key = candidate.sectorSummary.dominantSector;
    const list = sectorShortlist.get(key) ?? [];
    list.push(candidate);
    list.sort((left, right) => right.growthScore - left.growthScore);
    sectorShortlist.set(key, list.slice(0, 2));
  }
  const shortlist = [...sectorShortlist.values()].flat().sort((left, right) => right.growthScore - left.growthScore).slice(0, 16);
  const snapshots = await fetchFundSnapshots(shortlist.map((item) => item.ranking.code));
  const analyzed = await mapLimited(shortlist, 4, async (candidate) => {
    try {
      const { ranking, holdings, sectorSummary } = candidate;
      const fund = await getFundWithCache(ranking.code, { maxAge: PORTFOLIO_CACHE_TTL, snapshot: snapshots.get(ranking.code) });
      const analysis = analyzeFund(fund.points, profile);
      const snapshot = snapshots.get(ranking.code);
      const verified = snapshot?.date === analysis.current.date && Math.abs(snapshot.nav - analysis.current.nav) < 0.000001;
      const enriched = { ranking, fund, holdings, sectorSummary, analysis, dataQuality: verified ? "verified" : "mismatch" };
      return { ...enriched, comparisonScore: opportunityBaseScore(enriched) };
    } catch { return null; }
  });
  const sectorBest = new Map();
  for (const candidate of analyzed.filter(Boolean)) {
    const current = sectorBest.get(candidate.sectorSummary.dominantSector);
    if (!current || candidate.comparisonScore > current.comparisonScore) sectorBest.set(candidate.sectorSummary.dominantSector, candidate);
  }
  const finalists = [...sectorBest.values()].sort((left, right) => right.comparisonScore - left.comparisonScore).slice(0, 6);
  const withFundamentals = await mapLimited(finalists, 3, async (candidate) => {
    const research = await buildOpportunityFundamental(candidate.holdings);
    const comparisonScore = Math.round(candidate.comparisonScore + (research.fundamentalScore ?? 0) * 0.15);
    const enriched = { ...candidate, research, comparisonScore };
    return { ...enriched, suggestion: assessMarketOpportunity(enriched) };
  });
  const items = withFundamentals.sort((left, right) => right.comparisonScore - left.comparisonScore).slice(0, 3).map((candidate) => ({
    code: candidate.ranking.code,
    name: candidate.fund.name,
    sector: candidate.sectorSummary.dominantSector,
    sectorTags: candidate.sectorSummary.tags,
    holdingsReportDate: candidate.sectorSummary.reportDate,
    rankDate: candidate.ranking.date,
    returns: {
      day: candidate.ranking.dailyChange,
      week: candidate.ranking.weekReturn,
      month: candidate.ranking.monthReturn,
      quarter: candidate.ranking.quarterReturn,
      halfYear: candidate.ranking.halfYearReturn,
      year: candidate.ranking.yearReturn
    },
    trend: {
      score: candidate.analysis.signal.score,
      confidence: candidate.analysis.signal.confidence,
      drawdown: candidate.analysis.current.drawdown,
      volatility: candidate.analysis.current.volatility,
      rsi: candidate.analysis.current.rsi
    },
    fundamental: { score: candidate.research.fundamentalScore, coverage: candidate.research.coverage },
    dataQuality: candidate.dataQuality,
    comparisonScore: candidate.comparisonScore,
    suggestion: candidate.suggestion
  }));
  return {
    generatedAt: new Date().toISOString(),
    rankDate: quarterRankings[0]?.date ?? monthRankings[0]?.date ?? null,
    source: "东方财富公开基金排行、正式净值与最近披露持仓",
    methodology: "从近3个月公开排行抽取候选，合并同一基金不同份额，按最近披露持仓识别主导板块，同一板块只保留一只，再用趋势、动能、回撤、波动和持仓财务覆盖进行过滤。",
    items
  };
}

async function handleApi(request, response, url) {
  if (url.pathname === "/api/health") return json(response, 200, { ok: true, time: new Date().toISOString() });
  if (url.pathname === "/api/search") {
    const body = await readJsonBody(request);
    const query = request.method === "POST" ? body.q : url.searchParams.get("q");
    if (!query) return json(response, 200, { results: [] });
    try { return json(response, 200, { results: await searchFunds(query) }); }
    catch (error) { return json(response, 502, { error: error.message }); }
  }
  if (url.pathname === "/api/portfolio") {
    const body = await readJsonBody(request);
    const requestedProfile = request.method === "POST" ? body.profile : url.searchParams.get("profile");
    const rawCodes = request.method === "POST" ? body.codes : (url.searchParams.get("codes") ?? "").split(",");
    const profile = ["conservative", "balanced", "aggressive"].includes(requestedProfile) ? requestedProfile : "balanced";
    const codes = [...new Set((Array.isArray(rawCodes) ? rawCodes : []).filter((code) => /^\d{6}$/.test(code)))].slice(0, 40);
    try { return json(response, 200, await buildPortfolio(codes, profile)); }
    catch (error) { return json(response, 502, { error: error.message }); }
  }
  if (url.pathname === "/api/portfolio/research") {
    const body = await readJsonBody(request);
    const rawCodes = request.method === "POST" ? body.codes : (url.searchParams.get("codes") ?? "").split(",");
    const codes = [...new Set((Array.isArray(rawCodes) ? rawCodes : []).filter((code) => /^\d{6}$/.test(code)))].slice(0, 40);
    try { return json(response, 200, await buildPortfolioResearch(codes)); }
    catch (error) { return json(response, 502, { error: error.message }); }
  }
  if (url.pathname === "/api/market/opportunities") {
    const requestedProfile = url.searchParams.get("profile");
    const profile = ["conservative", "balanced", "aggressive"].includes(requestedProfile) ? requestedProfile : "balanced";
    try {
      const payload = await getResearchCached(`market-opportunities-v4-${profile}`, MARKET_OPPORTUNITY_TTL, () => buildMarketOpportunities(profile));
      return json(response, 200, payload);
    } catch (error) { return json(response, 502, { error: error.message }); }
  }
  const fundResearchMatch = url.pathname.match(/^\/api\/research\/fund\/(\d{6})$/);
  if (fundResearchMatch) {
    try { return json(response, 200, await buildSingleFundResearch(fundResearchMatch[1], 10)); }
    catch (error) { return json(response, 502, { error: error.message }); }
  }
  const companyResearchMatch = url.pathname.match(/^\/api\/research\/company\/(\d{6})$/);
  if (companyResearchMatch) {
    const code = companyResearchMatch[1];
    const name = url.searchParams.get("name") ?? code;
    const industry = url.searchParams.get("industry") ?? "";
    try {
      const [company, news, policyNews] = await Promise.all([
        getCompanyResearch(code),
        getNews(`company-${code}`, name, { requiredAllInTitle: [name] }),
        industry ? getNews(`policy-${encodeURIComponent(industry)}`, `${industry} 政策`, { requiredAllInTitle: [industry], requiredAnyInTitle: policyTerms }) : Promise.resolve([])
      ]);
      return json(response, 200, { ...company, news, policyNews });
    } catch (error) { return json(response, 502, { error: error.message }); }
  }
  const match = url.pathname.match(/^\/api\/fund\/(\d{6})$/);
  if (match) {
    const profile = ["conservative", "balanced", "aggressive"].includes(url.searchParams.get("profile")) ? url.searchParams.get("profile") : "balanced";
    const range = ["3m", "6m", "1y", "3y", "all"].includes(url.searchParams.get("range")) ? url.searchParams.get("range") : "1y";
    try {
      const fund = await getFundWithCache(match[1]);
      const analysis = analyzeFund(fund.points, profile);
      const selectedRows = sliceByRange(analysis.rows, range);
      const selectedBacktest = selectedRows.length >= 90 ? analyzeFund(selectedRows, profile).backtest : null;
      return json(response, 200, {
        fund: { code: fund.code, name: fund.name, source: fund.source, fetchedAt: fund.fetchedAt, cache: fund.cache, staleReason: fund.staleReason },
        analysis: { ...analysis, rows: selectedRows, backtest: range === "all" ? analysis.backtest : selectedBacktest },
        range
      });
    } catch (error) {
      return json(response, 502, { error: error.message });
    }
  }
  return json(response, 404, { error: "接口不存在" });
}

async function serveStatic(response, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  const filePath = path.resolve(publicDir, requested);
  const relativePath = path.relative(publicDir, filePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath) || !existsSync(filePath)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  const revalidate = [".html", ".css", ".js", ".webmanifest"].includes(path.extname(requested));
  response.writeHead(200, {
    "content-type": types[path.extname(filePath)] ?? "application/octet-stream",
    "cache-control": revalidate ? "no-cache" : "public, max-age=3600"
  });
  response.end(await readFile(filePath));
}

const server = http.createServer(async (request, response) => {
  try {
    applySecurityHeaders(response);
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname !== "/api/health" && rateLimit(request, response)) return;
      return await handleApi(request, response, url);
    }
    if (!["GET", "HEAD"].includes(request.method)) {
      response.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" });
      return response.end("Method not allowed");
    }
    return await serveStatic(response, decodeURIComponent(url.pathname));
  } catch (error) {
    return json(response, 500, { error: error.message });
  }
});

server.listen(port, host, () => {
  const displayHost = host === "0.0.0.0" ? "localhost" : host;
  console.log(`净值罗盘已启动：http://${displayHost}:${port}`);
});
server.headersTimeout = 15_000;
server.requestTimeout = 120_000;
