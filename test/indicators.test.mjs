import test from "node:test";
import assert from "node:assert/strict";
import { analyzeFund, kdj, sliceByRange } from "../src/indicators.mjs";
import { parseFundRankRows, parseValue } from "../src/data-source.mjs";
import { filterResearchNews } from "../src/research-source.mjs";
import { decidePortfolioAction, normalizeTarget } from "../public/strategy.js";
import { decryptVault, encryptVault } from "../public/vault.js";

function samplePoints(length = 420, direction = 1) {
  return Array.from({ length }, (_, index) => {
    const trend = 1 + direction * index * 0.0015;
    const cycle = Math.sin(index / 8) * 0.018;
    const nav = Math.max(.2, trend + cycle);
    return {
      timestamp: Date.UTC(2024, 0, 1) + index * 24 * 60 * 60 * 1000,
      nav,
      dailyChange: index === 0 ? 0 : null
    };
  });
}

test("NAV-KDJ stays finite for flat data", () => {
  const result = kdj(Array(30).fill(1));
  assert.equal(result.k.at(-1), 50);
  assert.equal(result.d.at(-1), 50);
  assert.equal(result.j.at(-1), 50);
});

test("analysis produces a positive trend score for a rising series", () => {
  const analysis = analyzeFund(samplePoints(420, 1), "balanced");
  assert.ok(analysis.signal.score > 0);
  assert.equal(analysis.rows.length, 420);
  assert.ok(Number.isFinite(analysis.current.ma5));
  assert.ok(Number.isFinite(analysis.current.ma10));
  assert.ok(Number.isFinite(analysis.current.rsi));
  assert.ok(analysis.backtest.trades >= 1);
});

test("indicator agreement is the share of effective factors aligned with the final direction", () => {
  const { signal } = analyzeFund(samplePoints(420, 1), "balanced");
  assert.ok(signal.agreement.total > 0);
  assert.equal(signal.confidence, Math.round(signal.agreement.aligned / signal.agreement.total * 100));
});

test("analysis produces a negative trend score for a falling series", () => {
  const analysis = analyzeFund(samplePoints(420, -1), "balanced");
  assert.ok(analysis.signal.score < 0);
  assert.ok(analysis.current.drawdown < 0);
});

test("range slicing keeps only the selected calendar window", () => {
  const analysis = analyzeFund(samplePoints(800, 1));
  const quarter = sliceByRange(analysis.rows, "3m");
  const selected = sliceByRange(analysis.rows, "6m");
  const quarterElapsed = quarter.at(-1).timestamp - quarter[0].timestamp;
  const elapsed = selected.at(-1).timestamp - selected[0].timestamp;
  assert.ok(quarterElapsed <= 92 * 24 * 60 * 60 * 1000);
  assert.ok(quarter.length > 80);
  assert.ok(elapsed <= 183 * 24 * 60 * 60 * 1000);
  assert.ok(selected.length > 170);
});

test("Eastmoney assignment parser reads arrays and strings without eval", () => {
  const source = 'var fS_name = "示例基金"; var Data_netWorthTrend = [{"x":1,"y":2}];';
  assert.equal(parseValue(source, "fS_name"), "示例基金");
  assert.deepEqual(parseValue(source, "Data_netWorthTrend"), [{ x: 1, y: 2 }]);
});

test("Eastmoney ranking parser reads interval returns without eval", () => {
  const source = 'var rankData = {datas:["000001,示例基金A,SLJJA,2026-08-10,1.2345,1.5678,1.20,2.30,4.50,12.60,18.20,25.40,,,16.80,56.78"],allRecords:1};';
  const [row] = parseFundRankRows(source);
  assert.equal(row.code, "000001");
  assert.equal(row.monthReturn, 4.5);
  assert.equal(row.quarterReturn, 12.6);
});

test("analysis uses accumulated NAV to avoid a false dividend sell signal", () => {
  const points = samplePoints(420, 1).map((point, index) => ({
    ...point,
    nav: index < 360 ? point.nav : point.nav - 0.35,
    adjustedNav: point.nav
  }));
  const analysis = analyzeFund(points, "balanced");
  assert.ok(Math.abs(analysis.current.trendNav - points.at(-1).adjustedNav) < 0.0001);
  assert.ok(analysis.signal.score > 0);
});

test("Eastmoney timestamp is displayed in China Standard Time", () => {
  const points = samplePoints(90, 1);
  points[89].timestamp = 1786032000000;
  const analysis = analyzeFund(points);
  assert.equal(analysis.current.date, "2026-08-07");
});

test("research news filtering removes generic and unrelated results", () => {
  const items = [
    { title: "中科飞测发布半年度业绩预告", summary: "中科飞测订单增长" },
    { title: "半导体设备板块上涨", summary: "行业资金流入" },
    { title: "电子行业数字化转型实施方案发布", summary: "工信部公布相关政策" },
    { title: "景旺电子龙虎榜", summary: "交易公开信息" }
  ];
  assert.deepEqual(filterResearchNews(items, { requiredAllInTitle: ["中科飞测"] }).map((item) => item.title), ["中科飞测发布半年度业绩预告"]);
  assert.deepEqual(filterResearchNews(items, { requiredAllInTitle: ["电子"], requiredAnyInTitle: ["政策", "方案"] }).map((item) => item.title), ["电子行业数字化转型实施方案发布"]);
});

test("portfolio strategy prioritizes customer take-profit targets", () => {
  const action = decidePortfolioAction({ technicalState: "candidate", score: 60, compositeScore: 60, confidence: 80, attentionThreshold: 40, reduceThreshold: -40, holdingReturnPct: 22, targetPct: 20, dataQuality: "verified", lagBusinessDays: 0 });
  assert.equal(action.state, "take-profit");
  assert.equal(normalizeTarget(1), 5);
});

test("portfolio strategy separates build, hold and exit signals", () => {
  const shared = { score: 55, compositeScore: 55, confidence: 75, attentionThreshold: 40, reduceThreshold: -40, fundamentalScore: 12, fundamentalUsable: true, drawdown: -12, volatility: 40, targetPct: 20, dataQuality: "verified", lagBusinessDays: 0 };
  assert.equal(decidePortfolioAction({ ...shared, technicalState: "candidate" }).state, "base");
  assert.equal(decidePortfolioAction({ ...shared, technicalState: "watch", compositeScore: 30, confidence: 60, hasHolding: true }).state, "hold");
  assert.equal(decidePortfolioAction({ ...shared, technicalState: "risk", compositeScore: -45 }).state, "sell");
  assert.equal(decidePortfolioAction({ ...shared, technicalState: "candidate", confidence: 69 }).state, "wait");
});

test("encrypted vault round-trips private portfolio data", async () => {
  const payload = { "fund-portfolio": JSON.stringify({ items: [{ code: "000001", userGroup: "测试" }] }) };
  const vault = await encryptVault(payload, "test-password", { iterations: 1000 });
  assert.deepEqual(await decryptVault(vault, "test-password"), payload);
  await assert.rejects(() => decryptVault(vault, "wrong-password"), /密码错误/);
});
