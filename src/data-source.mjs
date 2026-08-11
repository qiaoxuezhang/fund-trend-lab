const FUND_DATA_URL = "https://fund.eastmoney.com/pingzhongdata";
const FUND_SEARCH_URL = "https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx";
const FUND_SNAPSHOT_URL = "https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo";
const FUND_RANK_URL = "https://fund.eastmoney.com/data/rankhandler.aspx";

function readAssignment(source, name) {
  const matcher = new RegExp(`var\\s+${name}\\s*=\\s*`);
  const match = matcher.exec(source);
  if (!match) return null;
  const start = match.index + match[0].length;
  let quote = null;
  let escaped = false;
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'") { quote = char; continue; }
    if (char === "[" || char === "{") depth += 1;
    if (char === "]" || char === "}") depth -= 1;
    if (char === ";" && depth === 0) return source.slice(start, index).trim();
  }
  return null;
}

function parseValue(source, name) {
  const raw = readAssignment(source, name);
  if (raw == null) return null;
  if (raw.startsWith("'")) return raw.slice(1, -1).replace(/\\'/g, "'");
  try { return JSON.parse(raw); } catch { return raw.replace(/^['\"]|['\"]$/g, ""); }
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "accept": "application/json,text/javascript,*/*;q=0.8",
      "user-agent": "Mozilla/5.0 FundTrendLab/1.0",
      "referer": "https://fund.eastmoney.com/"
    },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`上游数据请求失败（HTTP ${response.status}）`);
  return response.text();
}

export async function fetchFund(code) {
  if (!/^\d{6}$/.test(code)) throw new Error("基金代码应为6位数字");
  const source = await fetchText(`${FUND_DATA_URL}/${code}.js?v=${Date.now()}`);
  const trend = parseValue(source, "Data_netWorthTrend");
  const accumulatedTrend = parseValue(source, "Data_ACWorthTrend");
  const name = parseValue(source, "fS_name");
  if (!Array.isArray(trend) || !trend.length || !name) throw new Error("没有找到该基金的历史净值，请检查基金代码");
  const adjustedByTimestamp = new Map(
    (Array.isArray(accumulatedTrend) ? accumulatedTrend : [])
      .filter((item) => Array.isArray(item) && item.length >= 2)
      .map((item) => [Number(item[0]), Number(item[1])])
  );
  const points = trend.map((item) => ({
    timestamp: Number(item.x),
    nav: Number(item.y),
    adjustedNav: adjustedByTimestamp.get(Number(item.x)) ?? Number(item.y),
    dailyChange: Number.isFinite(Number(item.equityReturn)) ? Number(item.equityReturn) : null
  })).filter((item) => Number.isFinite(item.timestamp) && Number.isFinite(item.nav));
  return {
    code,
    name,
    points,
    source: "东方财富公开基金页面",
    fetchedAt: new Date().toISOString()
  };
}

export async function searchFunds(query) {
  const clean = String(query ?? "").trim();
  if (!clean) return [];
  const text = await fetchText(`${FUND_SEARCH_URL}?m=1&key=${encodeURIComponent(clean)}`);
  const payload = JSON.parse(text);
  return (payload.Datas ?? [])
    .filter((item) => /^\d{6}$/.test(item.CODE ?? ""))
    .slice(0, 10)
    .map((item) => ({
      code: item.CODE,
      name: item.NAME,
      type: item.FundBaseInfo?.FTYPE ?? item.CATEGORYDESC ?? "基金",
      nav: Number(item.FundBaseInfo?.DWJZ) || null,
      navDate: item.FundBaseInfo?.FSRQ ?? null
    }));
}

export async function fetchFundSnapshots(codes) {
  const validCodes = [...new Set(codes)].filter((code) => /^\d{6}$/.test(code)).slice(0, 50);
  if (!validCodes.length) return new Map();
  const params = new URLSearchParams({
    pageIndex: "1",
    pageSize: String(validCodes.length),
    plat: "Android",
    appType: "ttjj",
    product: "EFund",
    Version: "1",
    deviceid: "fund-trend-lab",
    Fcodes: validCodes.join(",")
  });
  const text = await fetchText(`${FUND_SNAPSHOT_URL}?${params}`);
  const payload = JSON.parse(text);
  return new Map((payload.Datas ?? []).map((item) => [item.FCODE, {
    code: item.FCODE,
    name: item.SHORTNAME,
    date: item.PDATE,
    nav: Number(item.NAV),
    accumulatedNav: Number(item.ACCNAV),
    dailyChange: Number(item.NAVCHGRT)
  }]));
}

export function parseFundRankRows(source) {
  const match = /datas\s*:\s*/.exec(String(source ?? ""));
  if (!match) return [];
  const start = source.indexOf("[", match.index + match[0].length);
  if (start < 0) return [];
  let quote = null;
  let escaped = false;
  let depth = 0;
  let end = -1;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "[") depth += 1;
    if (char === "]") {
      depth -= 1;
      if (depth === 0) { end = index + 1; break; }
    }
  }
  if (end < 0) return [];
  let rows;
  try { rows = JSON.parse(source.slice(start, end)); } catch { return []; }
  return rows.map((row) => {
    const fields = String(row).split(",");
    const number = (index) => {
      const value = Number(fields[index]);
      return Number.isFinite(value) ? value : null;
    };
    return {
      code: fields[0],
      name: fields[1],
      date: fields[3],
      nav: number(4),
      accumulatedNav: number(5),
      dailyChange: number(6),
      weekReturn: number(7),
      monthReturn: number(8),
      quarterReturn: number(9),
      halfYearReturn: number(10),
      yearReturn: number(11),
      yearToDateReturn: number(14),
      inceptionReturn: number(15)
    };
  }).filter((item) => /^\d{6}$/.test(item.code) && item.name && Number.isFinite(item.quarterReturn));
}

export async function fetchFundRankings({ pageSize = 60, sort = "3yzf" } = {}) {
  const now = new Date();
  const end = now.toISOString().slice(0, 10);
  const startDate = new Date(now);
  startDate.setUTCFullYear(startDate.getUTCFullYear() - 1);
  const params = new URLSearchParams({
    op: "ph",
    dt: "kf",
    ft: "all",
    rs: "",
    gs: "0",
    sc: ["1yzf", "3yzf", "6yzf", "1nzf"].includes(sort) ? sort : "3yzf",
    st: "desc",
    sd: startDate.toISOString().slice(0, 10),
    ed: end,
    qdii: "",
    tabSubtype: ",,,,,",
    pi: "1",
    pn: String(Math.min(100, Math.max(20, pageSize))),
    dx: "1",
    v: String(Date.now())
  });
  return parseFundRankRows(await fetchText(`${FUND_RANK_URL}?${params}`));
}

export { parseValue };
