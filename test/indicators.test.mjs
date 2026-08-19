import test from "node:test";
import assert from "node:assert/strict";
import { analyzeFund, kdj, sliceByRange } from "../src/indicators.mjs";
import { parseFundRankRows, parseValue } from "../src/data-source.mjs";
import { filterResearchNews } from "../src/research-source.mjs";
import { buildEntryTiming, decidePortfolioAction, normalizeTarget } from "../public/strategy.js";
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

function lowPositionRecoveryPoints() {
  return Array.from({ length: 420 }, (_, index) => {
    let nav;
    if (index < 300) nav = 1 + index * 0.0005;
    else if (index < 390) nav = 1.15 + (index - 300) * 0.016;
    else if (index < 415) nav = 2.574 - (index - 390) * 0.045;
    else nav = 1.494 + (index - 414) * 0.081;
    return { timestamp: Date.UTC(2025, 0, 1) + index * 24 * 60 * 60 * 1000, nav };
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
  assert.equal(analysis.current.structure.state, "trend");
  assert.equal(analysis.rows.length, 420);
  assert.ok(Number.isFinite(analysis.current.ma5));
  assert.ok(Number.isFinite(analysis.current.ma10));
  assert.ok(Number.isFinite(analysis.current.rsi));
  assert.ok(analysis.backtest.trades >= 1);
});

test("model agreement uses independent evidence-group weights", () => {
  const { signal } = analyzeFund(samplePoints(420, 1), "balanced");
  assert.ok(signal.agreement.total > 0);
  assert.equal(signal.confidence, Math.round(signal.agreement.alignedWeight / signal.agreement.totalWeight * 100));
  assert.equal(signal.model.version, "multi-horizon-v3");
  assert.deepEqual(signal.factors.slice(0, 4).map((factor) => factor.key), ["longRegime", "mediumTrend", "shortTiming", "risk"]);
  assert.equal(signal.factors.reduce((sum, factor) => sum + factor.points, 0), signal.score);
});

test("deep drawdown alone does not turn a low-position recovery into a broken trend", () => {
  const analysis = analyzeFund(lowPositionRecoveryPoints(), "balanced");
  assert.ok(analysis.current.drawdown <= -20);
  assert.equal(analysis.current.structure.state, "repair");
  assert.equal(analysis.current.structure.label, "低位修复");
  assert.ok(analysis.current.structure.repairPower.score >= 65);
  assert.ok(analysis.current.trendNav > analysis.current.ma20);
  assert.ok(analysis.current.trendNav < analysis.current.ma60);
  assert.ok(analysis.current.ma60 > analysis.current.ma120);
  assert.match(analysis.signal.signal, /低位修复/);
  assert.notEqual(analysis.decision.risk.level, "high");
  assert.notEqual(analysis.decision.risk.level, "emergency");
});

test("repair power is an evidence score with explicit heat warnings", () => {
  const analysis = analyzeFund(lowPositionRecoveryPoints(), "balanced");
  const repair = analysis.current.structure.repairPower;
  assert.ok(repair.score >= 0 && repair.score <= 100);
  assert.ok(repair.evidence.includes("MACD 柱已转正"));
  assert.ok(repair.cautions.includes("KDJ 短期过热"));
});

test("recovery classification and score stay objective across risk profiles", () => {
  const results = ["conservative", "balanced", "aggressive"].map((profile) => analyzeFund(lowPositionRecoveryPoints(), profile));
  assert.deepEqual(results.map((analysis) => analysis.current.structure.state), ["repair", "repair", "repair"]);
  assert.deepEqual(results.map((analysis) => analysis.signal.score), [results[0].signal.score, results[0].signal.score, results[0].signal.score]);
  assert.deepEqual(results.map((analysis) => analysis.current.structure.repairPower.score), [results[0].current.structure.repairPower.score, results[0].current.structure.repairPower.score, results[0].current.structure.repairPower.score]);
});

test("analysis produces a negative trend score for a falling series", () => {
  const analysis = analyzeFund(samplePoints(420, -1), "balanced");
  assert.ok(analysis.signal.score < 0);
  assert.ok(analysis.signal.score <= analysis.signal.threshold.reduce);
  assert.match(analysis.signal.signal, /趋势破坏/);
  assert.ok(analysis.current.drawdown < 0);
  assert.equal(analysis.current.structure.state, "broken");
});

test("objective structure score does not change with customer risk profile", () => {
  const points = samplePoints(420, -1);
  const results = ["conservative", "balanced", "aggressive"].map((profile) => analyzeFund(points, profile));
  assert.deepEqual(results.map((analysis) => analysis.signal.score), [results[0].signal.score, results[0].signal.score, results[0].signal.score]);
  assert.deepEqual(results.map((analysis) => analysis.current.structure.state), ["broken", "broken", "broken"]);
});

test("analysis distinguishes a short pullback from a broken long-term trend", () => {
  const points = samplePoints(420, 1).map((point, index) => index > 408
    ? { ...point, nav: point.nav - (index - 408) * 0.0025 }
    : point);
  const analysis = analyzeFund(points, "balanced");
  assert.equal(analysis.current.structure.state, "pullback");
  assert.ok(analysis.current.trendNav > analysis.current.ma60);
  assert.ok(analysis.signal.score > analysis.signal.threshold.reduce);
  assert.ok(analysis.signal.score < analysis.signal.threshold.attention);
  assert.match(analysis.signal.signal, /短期回调/);
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
  const confirmed = { confirmation: { trend: { passed: true }, momentum: { passed: true }, underlying: { passed: true }, passed: 3 }, risk: { level: "normal", reasons: [] } };
  assert.equal(decidePortfolioAction({ ...shared, technicalState: "candidate", structureState: "trend", decision: confirmed }).state, "base");
  assert.equal(decidePortfolioAction({ ...shared, technicalState: "watch", compositeScore: 30, confidence: 60, hasHolding: true }).state, "hold");
  assert.equal(decidePortfolioAction({ ...shared, technicalState: "risk", compositeScore: -45 }).state, "avoid");
  assert.equal(decidePortfolioAction({ ...shared, technicalState: "candidate", confidence: 69 }).state, "wait");
});

test("portfolio strategy treats pullbacks differently from broken trends", () => {
  const shared = { technicalState: "candidate", score: 55, compositeScore: 55, confidence: 78, attentionThreshold: 40, reduceThreshold: -40, targetPct: 20, dataQuality: "verified", lagBusinessDays: 0 };
  assert.equal(decidePortfolioAction({ ...shared, structureState: "pullback" }).state, "wait");
  assert.equal(decidePortfolioAction({ ...shared, structureState: "pullback", hasHolding: true }).state, "hold");
  assert.equal(decidePortfolioAction({ ...shared, structureState: "broken", hasHolding: true }).state, "reduce");
});

test("a single golden cross is only a timing trigger, not a build signal", () => {
  const analysis = analyzeFund(lowPositionRecoveryPoints(), "balanced");
  assert.notEqual(analysis.decision.confirmation.trend.passed && analysis.decision.confirmation.momentum.passed, true);
  const action = decidePortfolioAction({
    technicalState: "candidate",
    score: 45,
    compositeScore: 45,
    confidence: 75,
    attentionThreshold: 36,
    reduceThreshold: -36,
    structureState: "repair",
    dataQuality: "verified",
    lagBusinessDays: 0,
    decision: analysis.decision
  });
  assert.notEqual(action.state, "base");
});

test("three-layer confirmation is required for a full build candidate", () => {
  const decision = {
    confirmation: {
      trend: { passed: true }, momentum: { passed: true }, underlying: { passed: true }, passed: 3
    },
    risk: { level: "normal", reasons: [] },
    nextCheck: "下一净值日复核"
  };
  const shared = { technicalState: "candidate", score: 55, compositeScore: 55, confidence: 78, attentionThreshold: 36, reduceThreshold: -36, structureState: "trend", dataQuality: "verified", lagBusinessDays: 0, decision };
  assert.equal(decidePortfolioAction(shared).state, "base");
  decision.confirmation.underlying.passed = null;
  decision.confirmation.passed = 2;
  assert.equal(decidePortfolioAction(shared).state, "trial");
});

test("emergency risk overrides take-profit and all positive signals", () => {
  const decision = { confirmation: { passed: 3, underlying: { passed: true } }, risk: { level: "emergency", reasons: ["近5个净值日快速回撤超过15%"] } };
  const action = decidePortfolioAction({ technicalState: "candidate", score: 80, compositeScore: 80, confidence: 90, attentionThreshold: 36, reduceThreshold: -36, structureState: "trend", holdingReturnPct: 30, hasHolding: true, targetPct: 20, dataQuality: "verified", lagBusinessDays: 0, decision });
  assert.equal(action.state, "emergency");
});

test("watchlist and holding receive different defensive actions", () => {
  const decision = { confirmation: { passed: 0, underlying: { passed: false } }, risk: { level: "high", reasons: ["中长期结构已确认破坏"] } };
  const shared = { technicalState: "risk", score: -50, compositeScore: -50, confidence: 80, attentionThreshold: 36, reduceThreshold: -36, structureState: "broken", dataQuality: "verified", lagBusinessDays: 0, decision };
  assert.equal(decidePortfolioAction(shared).state, "avoid");
  assert.equal(decidePortfolioAction({ ...shared, hasHolding: true }).state, "reduce");
});

test("entry timing separates ready, pullback and defensive windows", () => {
  const decision = {
    horizon: { short: { label: "短期转强" }, long: { label: "长期偏强" } },
    confirmation: { trend: { passed: true }, momentum: { passed: true }, passed: 3 },
    risk: { level: "normal", reasons: [] }
  };
  const shared = {
    dataQuality: "verified",
    lagBusinessDays: 0,
    structureState: "trend",
    decision,
    returns: { week: 2, month: 6, quarter: 12, halfYear: 18 }
  };
  assert.equal(buildEntryTiming({ ...shared, actionState: "base" }).state, "ready");
  assert.equal(buildEntryTiming({ ...shared, actionState: "trial" }).state, "near");
  assert.equal(buildEntryTiming({ ...shared, actionState: "base", returns: { ...shared.returns, month: 16 } }).state, "wait_pullback");
  assert.equal(buildEntryTiming({ ...shared, actionState: "base", returns: { ...shared.returns, quarter: 36 } }).state, "ready");
  assert.equal(buildEntryTiming({ ...shared, role: "holding", actionState: "hold", rsi: 80 }).label, "暂缓加仓");
  assert.equal(buildEntryTiming({ ...shared, actionState: "avoid", structureState: "broken" }).state, "defensive");
});

test("entry timing treats recovery as near instead of a confirmed buy point", () => {
  const timing = buildEntryTiming({
    role: "watchlist",
    actionState: "wait",
    dataQuality: "verified",
    lagBusinessDays: 0,
    structureState: "repair",
    returns: { week: 1.5, month: -1, quarter: -8, halfYear: 2 },
    decision: { horizon: { short: { state: "positive", label: "短期转强" }, long: { state: "neutral", label: "长期震荡" } }, risk: { level: "watch", reasons: [] }, nextCheck: "等待 MA20 走平" }
  });
  assert.equal(timing.state, "near");
  assert.match(timing.trigger, /MA20/);
});

test("multi-strategy backtest reports golden-cross and three-layer comparisons", () => {
  const analysis = analyzeFund(samplePoints(420, 1), "balanced");
  assert.ok(analysis.backtest.methods.goldenCross);
  assert.ok(analysis.backtest.methods.threeLayer);
  assert.ok(analysis.backtest.methods.buyHold);
  assert.match(analysis.backtest.validation, /下一净值日生效/);
});

test("historical decisions do not change when future NAV data is appended", () => {
  const base = samplePoints(300, 1);
  const extended = [...base, ...samplePoints(60, -1).map((point, index) => ({ ...point, timestamp: base.at(-1).timestamp + (index + 1) * 24 * 60 * 60 * 1000, nav: base.at(-1).nav - index * 0.003 }))];
  const baseAnalysis = analyzeFund(base, "balanced");
  const extendedAnalysis = analyzeFund(extended, "balanced");
  const historical = extendedAnalysis.rows[base.length - 1];
  assert.equal(historical.score, baseAnalysis.rows.at(-1).score);
  assert.equal(historical.decision.setup, baseAnalysis.rows.at(-1).decision.setup);
  assert.equal(historical.decision.risk.level, baseAnalysis.rows.at(-1).decision.risk.level);
});

test("encrypted vault round-trips private portfolio data", async () => {
  const payload = { "fund-portfolio": JSON.stringify({ items: [{ code: "000001", userGroup: "测试" }] }) };
  const vault = await encryptVault(payload, "test-password", { iterations: 1000 });
  assert.deepEqual(await decryptVault(vault, "test-password"), payload);
  await assert.rejects(() => decryptVault(vault, "wrong-password"), /密码错误/);
});
