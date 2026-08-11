const HOLDINGS_URL = "https://fundmobapi.eastmoney.com/FundMNewApi/FundMNInverstPosition";
const FINANCIAL_URL = "https://datacenter-web.eastmoney.com/api/data/v1/get";
const ANNOUNCEMENT_URL = "https://np-anotice-stock.eastmoney.com/api/security/ann";
const NEWS_URL = "https://search-api-web.eastmoney.com/search/jsonp";

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value, digits = 2) => Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null;

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json,text/javascript,*/*;q=0.8",
      "user-agent": "Mozilla/5.0 FundTrendLab/1.0",
      referer: "https://fund.eastmoney.com/"
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`研究数据请求失败（HTTP ${response.status}）`);
  return response.text();
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

export async function fetchFundHoldings(code) {
  const params = new URLSearchParams({
    FCODE: code,
    deviceid: "fund-trend-lab",
    plat: "Android",
    product: "EFund",
    version: "6.3.8"
  });
  const payload = await fetchJson(`${HOLDINGS_URL}?${params}`);
  const stocks = payload.Datas?.fundStocks ?? [];
  return {
    code,
    reportDate: payload.Expansion ?? null,
    stocks: stocks.map((item) => ({
      code: item.GPDM,
      name: item.GPJC,
      weight: Number(item.JZBL) || 0,
      changeType: item.PCTNVCHGTYPE || null,
      weightChange: Number(item.PCTNVCHG) || 0,
      industry: item.INDEXNAME || "其他",
      industryCode: item.INDEXCODE || null,
      exchange: item.TEXCH || null
    }))
  };
}

export async function fetchCompanyFinancial(code) {
  if (!/^\d{6}$/.test(code)) return null;
  const params = new URLSearchParams({
    reportName: "RPT_LICO_FN_CPD",
    columns: "ALL",
    filter: `(SECURITY_CODE=\"${code}\")`,
    pageNumber: "1",
    pageSize: "4",
    sortColumns: "REPORTDATE",
    sortTypes: "-1"
  });
  const payload = await fetchJson(`${FINANCIAL_URL}?${params}`);
  const data = payload.result?.data ?? [];
  if (!data.length) return null;
  const latest = data[0];
  return {
    code,
    name: latest.SECURITY_NAME_ABBR,
    reportDate: latest.REPORTDATE?.slice(0, 10) ?? null,
    reportType: latest.DATATYPE ?? null,
    publishDate: latest.NOTICE_DATE?.slice(0, 10) ?? null,
    industry: latest.BOARD_NAME ?? latest.PUBLISHNAME ?? null,
    revenue: Number(latest.TOTAL_OPERATE_INCOME),
    revenueGrowth: round(Number(latest.YSTZ)),
    netProfit: Number(latest.PARENT_NETPROFIT),
    profitGrowth: round(Number(latest.SJLTZ)),
    roe: round(Number(latest.WEIGHTAVG_ROE)),
    grossMargin: round(Number(latest.XSMLL)),
    eps: round(Number(latest.BASIC_EPS), 4),
    operatingCashFlowPerShare: round(Number(latest.MGJYXJJE), 4),
    recentReports: data.map((item) => ({
      reportDate: item.REPORTDATE?.slice(0, 10) ?? null,
      reportType: item.DATATYPE ?? null,
      revenueGrowth: round(Number(item.YSTZ)),
      profitGrowth: round(Number(item.SJLTZ)),
      netProfit: Number(item.PARENT_NETPROFIT),
      roe: round(Number(item.WEIGHTAVG_ROE))
    }))
  };
}

export async function fetchCompanyAnnouncements(code, limit = 6) {
  if (!/^\d{6}$/.test(code)) return [];
  const params = new URLSearchParams({
    sr: "-1",
    page_size: String(limit),
    page_index: "1",
    ann_type: "A",
    client_source: "web",
    stock_list: code
  });
  const payload = await fetchJson(`${ANNOUNCEMENT_URL}?${params}`);
  return (payload.data?.list ?? []).slice(0, limit).map((item) => ({
    code: item.art_code,
    title: item.title,
    date: item.notice_date?.slice(0, 10) ?? item.display_time?.slice(0, 10) ?? null,
    categories: (item.columns ?? []).map((column) => column.column_name),
    url: `https://data.eastmoney.com/notices/detail/${code}/${item.art_code}.html`
  }));
}

const normalizeResearchText = (value) => String(value ?? "")
  .replace(/<[^>]+>/g, " ")
  .replace(/&[a-z]+;/gi, " ")
  .replace(/\s+/g, " ")
  .trim();

export function filterResearchNews(items, {
  requiredAll = [],
  requiredAny = [],
  requiredAllInTitle = [],
  requiredAnyInTitle = []
} = {}) {
  const allTerms = requiredAll.map(normalizeResearchText).filter(Boolean);
  const anyTerms = requiredAny.map(normalizeResearchText).filter(Boolean);
  const titleAllTerms = requiredAllInTitle.map(normalizeResearchText).filter(Boolean);
  const titleAnyTerms = requiredAnyInTitle.map(normalizeResearchText).filter(Boolean);
  return items.filter((item) => {
    const title = normalizeResearchText(item.title);
    const text = normalizeResearchText(`${item.title} ${item.summary}`);
    return allTerms.every((term) => text.includes(term))
      && (!anyTerms.length || anyTerms.some((term) => text.includes(term)))
      && titleAllTerms.every((term) => title.includes(term))
      && (!titleAnyTerms.length || titleAnyTerms.some((term) => title.includes(term)));
  });
}

export async function searchResearchNews(keyword, limit = 6, filters = {}) {
  if (!keyword) return [];
  const pageSize = Math.min(50, Math.max(20, limit * 5));
  const parameter = {
    uid: "",
    keyword,
    type: ["cmsArticleWebOld"],
    client: "web",
    clientType: "web",
    clientVersion: "curr",
    param: { cmsArticleWebOld: { searchScope: "default", sort: "time", pageIndex: 1, pageSize, preTag: "", postTag: "" } }
  };
  const callback = "fundTrendLab";
  const text = await fetchText(`${NEWS_URL}?cb=${callback}&param=${encodeURIComponent(JSON.stringify(parameter))}`);
  const raw = text.replace(new RegExp(`^${callback}\\(`), "").replace(/\)\s*$/, "");
  const payload = JSON.parse(raw);
  const items = (payload.result?.cmsArticleWebOld ?? []).map((item) => ({
    code: item.code,
    title: normalizeResearchText(item.title),
    summary: normalizeResearchText(item.content),
    date: item.date,
    source: item.mediaName,
    url: item.url?.replace(/^http:/, "https:")
  }));
  return filterResearchNews(items, filters).slice(0, limit);
}

const positiveKeywords = ["增长", "扭亏", "回购", "增持", "中标", "补助", "分红", "突破", "预增"];
const negativeKeywords = ["亏损", "减持", "立案", "处罚", "诉讼", "终止", "风险提示", "问询", "退市", "预减"];

function eventTone(items) {
  let score = 0;
  const flags = [];
  for (const item of items) {
    const positive = positiveKeywords.filter((keyword) => item.title.includes(keyword));
    const negative = negativeKeywords.filter((keyword) => item.title.includes(keyword));
    score += positive.length * 3 - negative.length * 4;
    if (positive.length || negative.length) flags.push({ title: item.title, tone: positive.length >= negative.length ? "positive" : "negative" });
  }
  return { score: clamp(score, -20, 20), flags: flags.slice(0, 5) };
}

export function scoreCompanyResearch(financial, announcements = []) {
  if (!financial) return { score: null, financialScore: null, eventScore: null, flags: [] };
  let financialScore = 0;
  if (Number.isFinite(financial.revenueGrowth)) financialScore += clamp(financial.revenueGrowth, -50, 50) * 0.35;
  if (Number.isFinite(financial.profitGrowth)) financialScore += clamp(financial.profitGrowth, -80, 80) * 0.25;
  if (Number.isFinite(financial.netProfit) && financial.netProfit < 0) financialScore -= 18;
  if (Number.isFinite(financial.roe)) financialScore += clamp((financial.roe - 5) * 1.6, -18, 18);
  if (Number.isFinite(financial.grossMargin)) financialScore += clamp((financial.grossMargin - 20) * 0.35, -8, 12);
  if (Number.isFinite(financial.operatingCashFlowPerShare)) financialScore += financial.operatingCashFlowPerShare >= 0 ? 4 : -4;
  financialScore = clamp(financialScore, -80, 80);
  const events = eventTone(announcements);
  const score = financialScore * 0.85 + events.score * 0.15;
  return { score: round(score), financialScore: round(financialScore), eventScore: events.score, flags: events.flags };
}

export function summarizeFundResearch(holdings, companies) {
  const sectorWeights = new Map();
  for (const stock of holdings.stocks) sectorWeights.set(stock.industry, (sectorWeights.get(stock.industry) ?? 0) + stock.weight);
  const sectors = [...sectorWeights.entries()].map(([name, weight]) => ({ name, weight: round(weight) })).sort((a, b) => b.weight - a.weight);
  const companyMap = new Map(companies.map((company) => [company.code, company]));
  let weightedScore = 0;
  let coveredWeight = 0;
  const companyResearch = holdings.stocks.map((stock) => {
    const research = companyMap.get(stock.code);
    if (research?.score != null) {
      weightedScore += research.score * stock.weight;
      coveredWeight += stock.weight;
    }
    return { ...stock, research: research ?? null };
  });
  const totalWeight = holdings.stocks.reduce((sum, stock) => sum + stock.weight, 0);
  return {
    reportDate: holdings.reportDate,
    tags: sectors.slice(0, 3).map((sector) => sector.name),
    dominantSector: sectors[0]?.name ?? "其他",
    sectors,
    concentration: round(totalWeight),
    topHoldings: companyResearch,
    fundamentalScore: coveredWeight ? round(weightedScore / coveredWeight) : null,
    coverage: totalWeight ? round(coveredWeight / totalWeight * 100, 1) : 0
  };
}

export function holdingSimilarity(left, right) {
  const rightWeights = new Map(right.stocks.map((stock) => [stock.code, stock.weight]));
  const overlap = left.stocks.reduce((sum, stock) => sum + Math.min(stock.weight, rightWeights.get(stock.code) ?? 0), 0);
  const base = Math.min(left.stocks.reduce((sum, stock) => sum + stock.weight, 0), right.stocks.reduce((sum, stock) => sum + stock.weight, 0));
  return base ? round(overlap / base * 100, 1) : 0;
}
