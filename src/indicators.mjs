const DAY_MS = 24 * 60 * 60 * 1000;

const round = (value, digits = 4) => {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const chinaDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

function sma(values, period) {
  const result = Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) result[i] = sum / period;
  }
  return result;
}

function ema(values, period) {
  const result = Array(values.length).fill(null);
  if (!values.length) return result;
  const alpha = 2 / (period + 1);
  let current = values[0];
  result[0] = current;
  for (let i = 1; i < values.length; i += 1) {
    current = alpha * values[i] + (1 - alpha) * current;
    result[i] = current;
  }
  return result;
}

function rsi(values, period = 14) {
  const result = Array(values.length).fill(null);
  if (values.length <= period) return result;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = values[i] - values[i - 1];
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

function kdj(values, period = 9) {
  const k = Array(values.length).fill(null);
  const d = Array(values.length).fill(null);
  const j = Array(values.length).fill(null);
  let previousK = 50;
  let previousD = 50;
  for (let i = 0; i < values.length; i += 1) {
    const start = Math.max(0, i - period + 1);
    const window = values.slice(start, i + 1);
    const low = Math.min(...window);
    const high = Math.max(...window);
    const rsv = high === low ? 50 : ((values[i] - low) / (high - low)) * 100;
    previousK = (2 * previousK + rsv) / 3;
    previousD = (2 * previousD + previousK) / 3;
    k[i] = previousK;
    d[i] = previousD;
    j[i] = 3 * previousK - 2 * previousD;
  }
  return { k, d, j };
}

function rollingVolatility(values, period = 20) {
  const result = Array(values.length).fill(null);
  const returns = values.map((value, index) => index === 0 ? 0 : value / values[index - 1] - 1);
  for (let i = period; i < values.length; i += 1) {
    const sample = returns.slice(i - period + 1, i + 1);
    const mean = sample.reduce((sum, value) => sum + value, 0) / sample.length;
    const variance = sample.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sample.length;
    result[i] = Math.sqrt(variance) * Math.sqrt(250) * 100;
  }
  return result;
}

function rollingDrawdown(values, period = 250) {
  const result = Array(values.length).fill(0);
  for (let i = 0; i < values.length; i += 1) {
    const start = Math.max(0, i - period + 1);
    const peak = Math.max(...values.slice(start, i + 1));
    result[i] = peak === 0 ? 0 : (values[i] / peak - 1) * 100;
  }
  return result;
}

function rollingUpRatio(values, period = 20) {
  const result = Array(values.length).fill(null);
  for (let i = period; i < values.length; i += 1) {
    let upDays = 0;
    for (let day = i - period + 1; day <= i; day += 1) if (values[day] > values[day - 1]) upDays += 1;
    result[i] = upDays / period * 100;
  }
  return result;
}

function crossedAbove(left, right, index, lookback = 3) {
  for (let i = Math.max(1, index - lookback + 1); i <= index; i += 1) {
    if (left[i] != null && right[i] != null && left[i] > right[i] && left[i - 1] <= right[i - 1]) return true;
  }
  return false;
}

function crossedBelow(left, right, index, lookback = 3) {
  for (let i = Math.max(1, index - lookback + 1); i <= index; i += 1) {
    if (left[i] != null && right[i] != null && left[i] < right[i] && left[i - 1] >= right[i - 1]) return true;
  }
  return false;
}

function pctChange(values, index, periods) {
  if (index < periods || !values[index - periods]) return null;
  return (values[index] / values[index - periods] - 1) * 100;
}

function crossoverEvent(rows, index, leftKey, rightKey, lookback = 8) {
  for (let age = 0; age < lookback; age += 1) {
    const cursor = index - age;
    if (cursor < 1) break;
    const currentLeft = rows[cursor]?.[leftKey];
    const currentRight = rows[cursor]?.[rightKey];
    const previousLeft = rows[cursor - 1]?.[leftKey];
    const previousRight = rows[cursor - 1]?.[rightKey];
    if (![currentLeft, currentRight, previousLeft, previousRight].every(Number.isFinite)) continue;
    if (currentLeft > currentRight && previousLeft <= previousRight) return { direction: "golden", age, date: rows[cursor].date };
    if (currentLeft < currentRight && previousLeft >= previousRight) return { direction: "dead", age, date: rows[cursor].date };
  }
  return { direction: "none", age: null, date: null };
}

function horizonState(score, positive, negative, labels) {
  if (score >= positive) return { state: "positive", label: labels.positive, score: Math.round(score) };
  if (score <= negative) return { state: "negative", label: labels.negative, score: Math.round(score) };
  return { state: "neutral", label: labels.neutral, score: Math.round(score) };
}

function buildDecisionMatrix(rows, index, signal, structure, periodReturns) {
  const row = rows[index];
  const previous = rows[Math.max(0, index - 1)] ?? row;
  const dailyChange = previous.trendNav ? (row.trendNav / previous.trendNav - 1) * 100 : 0;
  const groups = Object.fromEntries((signal.groups ?? []).map((group) => [group.key, group]));
  const longScore = (groups.longRegime?.value ?? 0) * 100;
  const mediumScore = (groups.mediumTrend?.value ?? 0) * 100;
  const shortScore = (groups.shortTiming?.value ?? 0) * 100;
  const maCross = crossoverEvent(rows, index, "ma5", "ma10", 8);
  const mediumCross = crossoverEvent(rows, index, "ma20", "ma60", 15);
  const macdCross = crossoverEvent(rows, index, "dif", "dea", 8);
  const kdjCross = crossoverEvent(rows, index, "k", "d", 5);
  const momentum5 = pctChange(rows.map((item) => item.trendNav), index, 5);

  const short = horizonState(shortScore, 18, -18, { positive: "短期转强", negative: "短期转弱", neutral: "短期震荡" });
  const medium = horizonState(mediumScore, 18, -22, { positive: "中期改善", negative: "中期走弱", neutral: "中期确认中" });
  const long = horizonState(longScore, 18, -22, { positive: "长期偏强", negative: "长期偏弱", neutral: "长期震荡" });

  const trendEvidence = [
    row.trendNav >= row.ma20 ? "净值位于 MA20 上方" : null,
    row.trendNav >= row.ma60 ? "净值位于 MA60 上方" : null,
    row.ma20 >= row.ma60 ? "MA20 不低于 MA60" : null,
    longScore > 10 ? "长期状态为正" : null
  ].filter(Boolean);
  const momentumEvidence = [
    row.ma5 > row.ma10 ? "MA5 高于 MA10" : null,
    maCross.direction === "golden" ? `MA5/MA10 ${maCross.age === 0 ? "当日" : `${maCross.age}个净值日前`}金叉` : null,
    row.macdHist > 0 ? "MACD 柱为正" : null,
    row.macdHist > previous.macdHist ? "MACD 动能改善" : null,
    row.k > row.d && row.j < 105 ? "KDJ 同向且未严重过热" : null,
    Number.isFinite(momentum5) && momentum5 > 0 ? "近5日动量为正" : null
  ].filter(Boolean);
  const trendPassed = structure.state === "trend" && trendEvidence.length >= 3;
  const momentumPassed = shortScore >= 12 && momentumEvidence.length >= 3;

  const emergencyReasons = [
    dailyChange <= -8 ? "单个净值日跌幅达到异常阈值" : null,
    Number(periodReturns.week) <= -15 ? "近5个净值日快速回撤超过15%" : null,
    Number(periodReturns.month) <= -25 && Number(row.volatility) >= 55 ? "近20日深跌且波动率急升" : null
  ].filter(Boolean);
  const highReasons = [
    structure.state === "broken" ? "中长期结构已确认破坏" : null,
    mediumScore <= -25 && longScore <= -20 ? "中期与长期方向同步走弱" : null,
    row.trendNav < row.ma60 && row.ma20 < row.ma60 && mediumScore < -15 ? "净值与 MA20 位于 MA60 下方且中期强度为负" : null,
    mediumCross.direction === "dead" && longScore < -10 ? "MA20/MA60 近期死叉且长期状态转弱" : null,
    Number(row.volatility) >= 70 && Number(periodReturns.month) < 0 ? "极高波动伴随近20日收益为负" : null
  ].filter(Boolean);
  const watchReasons = [
    structure.state === "pullback" ? "短期回调，长期骨架暂完整" : null,
    structure.state === "repair" ? "低位修复尚未完成中期确认" : null,
    Number(row.drawdown) <= -25 ? "历史回撤较深，仅作风险背景，不单独否决修复" : null,
    row.trendNav < row.ma60 && mediumScore >= -15 ? "净值尚未站回 MA60，等待中期确认" : null,
    Number(row.rsi) >= 74 || Number(row.j) >= 105 ? "短期指标过热" : null,
    Number(row.volatility) >= 45 ? "波动率处于较高区间" : null
  ].filter(Boolean);
  const risk = emergencyReasons.length
    ? { level: "emergency", label: "紧急避险", reasons: emergencyReasons, blocksEntry: true }
    : structure.state === "broken" || (longScore <= -10 && highReasons.length >= 2)
      ? { level: "high", label: "高风险", reasons: highReasons, blocksEntry: true }
      : watchReasons.length
        ? { level: "watch", label: "风险关注", reasons: watchReasons, blocksEntry: false }
        : { level: "normal", label: "常规风险", reasons: ["未触发独立风险门控"], blocksEntry: false };

  const technicalPassed = [trendPassed, momentumPassed].filter(Boolean).length;
  let setup = "wait";
  let setupLabel = "等待确认";
  if (risk.level === "emergency") { setup = "emergency"; setupLabel = "紧急避险"; }
  else if (risk.level === "high") { setup = "defensive"; setupLabel = "停止新增"; }
  else if (trendPassed && momentumPassed) { setup = "candidate"; setupLabel = "技术面候选"; }
  else if (structure.state === "repair" || short.state === "positive") { setup = "watch"; setupLabel = "转强观察"; }

  const nextTriggers = [];
  if (!trendPassed) nextTriggers.push("净值站稳 MA60，且 MA20 走平向上");
  if (!momentumPassed) nextTriggers.push("MA5/MA10、MACD 与5日动量至少三项同向");
  if (risk.level === "watch") nextTriggers.push("过热或波动风险回落后重新验证");
  if (risk.blocksEntry) nextTriggers.push("风险门控解除后再评估任何新增仓位");

  return {
    horizon: { short, medium, long },
    crossovers: { maShort: maCross, maMedium: mediumCross, macd: macdCross, kdj: kdjCross },
    confirmation: {
      trend: { passed: trendPassed, label: "趋势结构", evidence: trendEvidence },
      momentum: { passed: momentumPassed, label: "动能触发", evidence: momentumEvidence },
      underlying: { passed: null, label: "持仓基本面", evidence: ["需结合最近披露持仓、财报与行业信息"] },
      passed: technicalPassed,
      total: 3
    },
    risk,
    setup,
    setupLabel,
    nextCheck: nextTriggers[0] ?? "维持当前纪律，并在下一次正式净值更新后复核",
    nextTriggers,
    note: "金叉只是一项时点触发；只有趋势、动能和底层持仓验证通过，且风险门控未否决时，才进入分批建仓候选。"
  };
}

const profileThresholds = {
  conservative: { attention: 50, reduce: -28 },
  balanced: { attention: 36, reduce: -36 },
  aggressive: { attention: 25, reduce: -46 }
};

function weightedMean(items) {
  const usable = items.filter((item) => Number.isFinite(item.value) && item.weight > 0);
  const weight = usable.reduce((sum, item) => sum + item.weight, 0);
  return weight ? usable.reduce((sum, item) => sum + item.value * item.weight, 0) / weight : 0;
}

function normalizedGap(value, benchmark, scalePct) {
  if (!Number.isFinite(value) || !Number.isFinite(benchmark) || benchmark === 0) return null;
  return Math.tanh(((value / benchmark - 1) * 100) / scalePct);
}

function normalizedValue(value, scale) {
  return Number.isFinite(value) ? Math.tanh(value / scale) : null;
}

function scoreNarrative(score, threshold) {
  if (score >= threshold.attention) return { signal: "趋势证据通过", action: "独立证据组达到当前模式阈值，仍需结合结构状态、数据质量和基本面决定动作", tone: "positive" };
  if (score <= threshold.reduce) return { signal: "弱势证据占优", action: "综合证据已进入防守区，等待结构重新修复", tone: "negative" };
  return { signal: "证据尚未统一", action: "综合分未达到建仓或退出阈值，继续等待结构和动量形成一致", tone: "neutral" };
}

function agreementForGroups(groups, score) {
  const direction = Math.sign(score);
  const effective = groups.filter((group) => Math.abs(group.value) >= 0.08 && group.key !== "risk");
  const aligned = effective.filter((group) => Math.sign(group.value) === direction);
  const totalWeight = effective.reduce((sum, group) => sum + group.weight, 0);
  const alignedWeight = aligned.reduce((sum, group) => sum + group.weight, 0);
  return {
    confidence: direction && totalWeight ? Math.round(alignedWeight / totalWeight * 100) : 0,
    agreement: { aligned: aligned.length, total: effective.length, alignedWeight: round(alignedWeight, 3), totalWeight: round(totalWeight, 3) }
  };
}

function scoreAt(rows, index, profile = "balanced") {
  const row = rows[index];
  const values = rows.map((item) => item.trendNav);
  const volatility = Number.isFinite(row.volatility) ? row.volatility : 25;
  const gapScale = clamp(volatility / Math.sqrt(250) * 2.5, 2, 6);
  const ma20FiveDaysAgo = rows[Math.max(0, index - 5)]?.ma20;
  const ma60TenDaysAgo = rows[Math.max(0, index - 10)]?.ma60;
  const macdFiveDaysAgo = rows[Math.max(0, index - 5)]?.macdHist;
  const momentum5 = pctChange(values, index, 5);
  const momentum20 = pctChange(values, index, 20);
  const momentum60 = pctChange(values, index, 60);
  const momentum120 = pctChange(values, index, 120);

  const longRegimeValue = weightedMean([
    { value: normalizedGap(row.ma60, row.ma120, gapScale * 1.35), weight: 0.45 },
    { value: normalizedGap(row.ma60, ma60TenDaysAgo, Math.max(1, gapScale * 0.8)), weight: 0.3 },
    { value: normalizedValue(momentum120, Math.max(12, volatility * Math.sqrt(120 / 250) * 1.2)), weight: 0.25 }
  ]);
  const mediumTrendValue = weightedMean([
    { value: normalizedGap(row.trendNav, row.ma20, gapScale), weight: 0.25 },
    { value: normalizedGap(row.ma20, row.ma60, gapScale * 1.15), weight: 0.25 },
    { value: normalizedGap(row.ma20, ma20FiveDaysAgo, Math.max(1, gapScale * 0.55)), weight: 0.2 },
    { value: normalizedValue(momentum20, Math.max(4, volatility * Math.sqrt(20 / 250) * 1.2)), weight: 0.15 },
    { value: normalizedValue(momentum60, Math.max(8, volatility * Math.sqrt(60 / 250) * 1.2)), weight: 0.15 }
  ]);
  const macdValue = Number.isFinite(row.macdHist) && row.trendNav ? Math.tanh((row.macdHist / row.trendNav * 100) / 0.35) : null;
  const macdImprovement = Number.isFinite(row.macdHist) && Number.isFinite(macdFiveDaysAgo) && row.trendNav
    ? Math.tanh(((row.macdHist - macdFiveDaysAgo) / row.trendNav * 100) / 0.3)
    : null;
  const rsiValue = Number.isFinite(row.rsi) ? Math.tanh((row.rsi - 50) / 15) : null;
  const kdjValue = Number.isFinite(row.k) && Number.isFinite(row.d) ? Math.tanh((row.k - row.d) / 12) : null;
  const persistenceValue = Number.isFinite(row.upRatio20) ? Math.tanh((row.upRatio20 - 50) / 12) : null;
  const shortValue = weightedMean([
    { value: normalizedGap(row.ma5, row.ma10, Math.max(1, gapScale * 0.5)), weight: 0.2 },
    { value: normalizedValue(momentum5, Math.max(2, volatility * Math.sqrt(5 / 250) * 1.15)), weight: 0.15 },
    { value: macdValue, weight: 0.2 },
    { value: macdImprovement, weight: 0.15 },
    { value: rsiValue, weight: 0.12 },
    { value: kdjValue, weight: 0.08 },
    { value: persistenceValue, weight: 0.1 }
  ]);
  const drawdownPenalty = clamp((-(row.drawdown ?? 0) - 10) / 20, 0, 1);
  const volatilityPenalty = clamp((volatility - 25) / 35, 0, 1);
  const rsiHeatPenalty = clamp(((row.rsi ?? 50) - 70) / 18, 0, 1);
  const kdjHeatPenalty = clamp(((row.j ?? 50) - 100) / 40, 0, 1);
  const verticalRisePenalty = clamp(((momentum5 ?? 0) - 10) / 15, 0, 1);
  const riskValue = -(drawdownPenalty * 0.35 + volatilityPenalty * 0.35 + rsiHeatPenalty * 0.1 + kdjHeatPenalty * 0.1 + verticalRisePenalty * 0.1);

  const groups = [
    { key: "longRegime", label: "长期状态", value: longRegimeValue, weight: 0.35, detail: `MA60/MA120、MA60十日方向和120日动量共同判断长期骨架；不再用历史回撤单独判定趋势破坏` },
    { key: "mediumTrend", label: "中期趋势与修复", value: mediumTrendValue, weight: 0.3, detail: `净值/MA20、MA20/MA60、MA20方向及20/60日动量共同衡量修复是否能延续` },
    { key: "shortTiming", label: "短期择时", value: shortValue, weight: 0.25, detail: `MA5/MA10、5日动量、MACD及其改善、RSI、NAV-KDJ与上涨日占比在组内验证：5日 ${momentum5 == null ? "--" : `${momentum5.toFixed(1)}%`}` },
    { key: "risk", label: "风险约束", value: riskValue, weight: 0.1, detail: `当前回撤 ${(row.drawdown ?? 0).toFixed(1)}%，年化波动 ${volatility.toFixed(1)}%；过热、急涨、回撤和高波动只降低可操作性，不直接证明趋势继续恶化` }
  ];
  const factors = groups.map((group) => {
    const points = Math.round(group.value * group.weight * 100);
    return { key: group.key, label: group.label, points, detail: group.detail, tone: points > 2 ? "positive" : points < -2 ? "negative" : "neutral" };
  });
  const score = Math.round(clamp(factors.reduce((sum, factor) => sum + factor.points, 0), -100, 100));
  const threshold = profileThresholds[profile] ?? profileThresholds.balanced;
  const narrative = scoreNarrative(score, threshold);
  const agreement = agreementForGroups(groups, score);
  return {
    score,
    ...narrative,
    confidence: agreement.confidence,
    agreement: agreement.agreement,
    factors,
    groups,
    threshold,
    model: { version: "multi-horizon-v3", weights: { longRegime: 35, mediumTrend: 30, shortTiming: 25, risk: 10 } }
  };
}

function calculateAnalogStats(rows, index, currentScore, horizon = 20) {
  const outcomes = [];
  const currentDirection = Math.sign(currentScore);
  for (let i = 80; i < index - horizon; i += 1) {
    const historicalScore = rows[i].score;
    if (historicalScore == null || Math.abs(historicalScore - currentScore) > 12) continue;
    if (currentDirection !== 0 && Math.sign(historicalScore) !== currentDirection) continue;
    outcomes.push((rows[i + horizon].trendNav / rows[i].trendNav - 1) * 100);
  }
  if (!outcomes.length) return { horizon, sampleCount: 0, positiveRate: null, medianReturn: null, downsideQuartile: null };
  outcomes.sort((a, b) => a - b);
  const percentile = (p) => outcomes[Math.min(outcomes.length - 1, Math.floor((outcomes.length - 1) * p))];
  return {
    horizon,
    sampleCount: outcomes.length,
    positiveRate: round(outcomes.filter((value) => value > 0).length / outcomes.length * 100, 1),
    medianReturn: round(percentile(0.5), 2),
    downsideQuartile: round(percentile(0.25), 2)
  };
}

function maxDrawdown(equity) {
  let peak = equity[0] ?? 1;
  let worst = 0;
  for (const value of equity) {
    peak = Math.max(peak, value);
    worst = Math.min(worst, value / peak - 1);
  }
  return worst * 100;
}

function simulateStrategy(rows, rule, transactionCost = 0.0015) {
  if (rows.length < 90) return null;
  let position = 0;
  let strategy = 1;
  let trades = 0;
  let investedDays = 0;
  let completedTrades = 0;
  let winningTrades = 0;
  let entryValue = null;
  const equity = [1];
  for (let i = 120; i < rows.length - 1; i += 1) {
    const nextPosition = rule(rows, i, position);
    if (nextPosition !== position) {
      strategy *= 1 - transactionCost;
      trades += 1;
      if (nextPosition === 1) entryValue = strategy;
      else if (entryValue != null) {
        completedTrades += 1;
        if (strategy > entryValue) winningTrades += 1;
        entryValue = null;
      }
    }
    position = nextPosition;
    if (position) investedDays += 1;
    const nextReturn = rows[i + 1].trendNav / rows[i].trendNav - 1;
    strategy *= 1 + position * nextReturn;
    equity.push(strategy);
  }
  return {
    return: round((strategy - 1) * 100, 2),
    maxDrawdown: round(maxDrawdown(equity), 2),
    trades,
    winRate: completedTrades ? round(winningTrades / completedTrades * 100, 1) : null,
    completedTrades,
    investedRatio: round(investedDays / Math.max(1, rows.length - 121) * 100, 1),
    transactionCost: transactionCost * 100
  };
}

function backtest(rows, profile = "balanced", transactionCost = 0.0015) {
  if (rows.length < 130) return null;
  const threshold = profileThresholds[profile] ?? profileThresholds.balanced;
  const benchmarkStart = rows[120].trendNav;
  const benchmarkReturn = (rows.at(-1).trendNav / benchmarkStart - 1) * 100;
  const benchmarkEquity = rows.slice(120).map((row) => row.trendNav / benchmarkStart);
  const scoreRule = (series, index, position) => {
    if (series[index].score >= threshold.attention) return 1;
    if (series[index].score <= threshold.reduce) return 0;
    return position;
  };
  const goldenCrossRule = (series, index, position) => {
    const current = series[index];
    const previous = series[index - 1];
    if (current.ma5 > current.ma10 && previous.ma5 <= previous.ma10) return 1;
    if (current.ma5 < current.ma10 && previous.ma5 >= previous.ma10) return 0;
    return position;
  };
  const confirmationRule = (series, index, position) => {
    const decision = series[index].decision;
    if (decision?.risk?.level === "emergency" || decision?.risk?.level === "high" || series[index].structureState === "broken") return 0;
    if (decision?.confirmation?.trend?.passed && decision?.confirmation?.momentum?.passed) return 1;
    if (series[index].ma20 < series[index].ma60 && series[index].macdHist < 0) return 0;
    return position;
  };
  const legacy = simulateStrategy(rows, scoreRule, transactionCost);
  const goldenCross = simulateStrategy(rows, goldenCrossRule, transactionCost);
  const threeLayer = simulateStrategy(rows, confirmationRule, transactionCost);
  return {
    strategyReturn: threeLayer.return,
    benchmarkReturn: round(benchmarkReturn, 2),
    strategyMaxDrawdown: threeLayer.maxDrawdown,
    benchmarkMaxDrawdown: round(maxDrawdown(benchmarkEquity), 2),
    trades: threeLayer.trades,
    investedRatio: threeLayer.investedRatio,
    transactionCost: transactionCost * 100,
    methods: {
      threeLayer: { ...threeLayer, label: "三层技术确认" },
      goldenCross: { ...goldenCross, label: "单一 MA5/MA10 金叉" },
      legacyScore: { ...legacy, label: "旧综合分规则" },
      buyHold: { label: "同期持有", return: round(benchmarkReturn, 2), maxDrawdown: round(maxDrawdown(benchmarkEquity), 2), trades: 1, winRate: null, investedRatio: 100 }
    },
    validation: "所有规则仅使用当日及以前数据，信号于下一净值日生效；结果已扣除每次切换0.15%的成本假设。"
  };
}

function calculateRepairPower(rows, index, periodReturns) {
  const row = rows[index];
  const fiveDaysAgo = rows[Math.max(0, index - 5)];
  const tenDaysAgo = rows[Math.max(0, index - 10)];
  const positive = [];
  const cautions = [];
  let score = 0;
  const add = (condition, points, evidence) => {
    if (!condition) return;
    score += points;
    positive.push(evidence);
  };

  add(Number.isFinite(row.ma20) && row.trendNav >= row.ma20, 18, "净值已站回 MA20");
  add(Number.isFinite(row.ma5) && Number.isFinite(row.ma10) && row.ma5 > row.ma10, 12, "MA5 高于 MA10");
  add(Number.isFinite(row.macdHist) && row.macdHist > 0, 18, "MACD 柱已转正");
  add(Number.isFinite(row.macdHist) && Number.isFinite(fiveDaysAgo?.macdHist) && row.macdHist > fiveDaysAgo.macdHist, 12, "MACD 较五日前改善");
  add(Number.isFinite(row.rsi) && row.rsi >= 48 && row.rsi <= 68, 10, "RSI 回到中性偏强区");
  add(Number.isFinite(periodReturns.week) && periodReturns.week > 0, 10, "近5日收益转正");
  add(Number.isFinite(periodReturns.month) && periodReturns.month > 0, 6, "近20日收益转正");
  add(Number.isFinite(row.ma60) && Number.isFinite(tenDaysAgo?.ma60) && row.ma60 >= tenDaysAgo.ma60, 8, "MA60 仍在走平或向上");
  add(Number.isFinite(row.ma60) && Number.isFinite(row.ma120) && row.ma60 >= row.ma120, 6, "MA60 仍高于 MA120");

  if (Number.isFinite(row.j) && row.j > 100) {
    score -= clamp((row.j - 100) / 3, 6, 12);
    cautions.push("KDJ 短期过热");
  }
  if (Number.isFinite(row.volatility) && row.volatility > 55) {
    score -= clamp((row.volatility - 55) / 3, 6, 16);
    cautions.push("波动率很高");
  }
  if (Number.isFinite(periodReturns.week) && periodReturns.week > 15) {
    score -= clamp((periodReturns.week - 15) / 2, 3, 10);
    cautions.push("近5日反弹过快");
  }

  const bounded = Math.round(clamp(score, 0, 100));
  const label = bounded >= 65 ? "较强" : bounded >= 50 ? "中等" : bounded >= 30 ? "偏弱" : "尚未形成";
  return { score: bounded, label, evidence: positive, cautions };
}

function classifyTrendStructure(rows, index, signal, periodReturns) {
  const row = rows[index];
  const ma20FiveDaysAgo = rows[Math.max(0, index - 5)]?.ma20;
  const ma60TenDaysAgo = rows[Math.max(0, index - 10)]?.ma60;
  const above20 = Number.isFinite(row.ma20) && row.trendNav >= row.ma20;
  const above60 = Number.isFinite(row.ma60) && row.trendNav >= row.ma60;
  const above120 = Number.isFinite(row.ma120) && row.trendNav >= row.ma120;
  const ma20Above60 = Number.isFinite(row.ma20) && Number.isFinite(row.ma60) && row.ma20 >= row.ma60;
  const ma60Above120 = Number.isFinite(row.ma60) && Number.isFinite(row.ma120) && row.ma60 >= row.ma120;
  const ma20Rising = Number.isFinite(row.ma20) && Number.isFinite(ma20FiveDaysAgo) && row.ma20 >= ma20FiveDaysAgo;
  const ma60Rising = Number.isFinite(row.ma60) && Number.isFinite(ma60TenDaysAgo) && row.ma60 >= ma60TenDaysAgo;
  const monthWeak = Number.isFinite(periodReturns.month) && periodReturns.month < 0;
  const quarterWeak = Number.isFinite(periodReturns.quarter) && periodReturns.quarter < 0;
  const longMomentumWeak = Number.isFinite(periodReturns.year) && periodReturns.year < 0;
  const shortMomentumWeak = !above20 || monthWeak || row.rsi < 45 || row.macdHist < 0;
  const longStructureIntact = above60 && ma60Above120 && ma60Rising;
  const longDeterioration = [!above120, !ma60Above120, !ma60Rising, quarterWeak, longMomentumWeak].filter(Boolean).length;
  const mediumDeterioration = [!above20, !above60, !ma20Above60, !ma20Rising, monthWeak, row.macdHist < 0].filter(Boolean).length;
  const longGroup = signal.groups?.find((group) => group.key === "longRegime")?.value ?? 0;
  const mediumGroup = signal.groups?.find((group) => group.key === "mediumTrend")?.value ?? 0;
  const hardBreak = (longDeterioration >= 3 && mediumDeterioration >= 3)
    || (longGroup <= -0.55 && mediumGroup <= -0.45 && longDeterioration >= 2);
  const repairPower = calculateRepairPower(rows, index, periodReturns);

  if (hardBreak) {
    return {
      state: "broken",
      label: "趋势破坏",
      severity: "high",
      detail: "长期骨架与中期趋势同时恶化，弱势已不再只是一次短期回调。历史回撤仅作为风险背景，不参与一票否决。",
      advice: "停止新增仓位；已有持仓结合赎回费用、持有期限和替代方案控制风险，等待长期骨架与中期趋势同时修复。",
      evidence: [!above120 ? "净值低于 MA120" : null, !ma60Above120 ? "MA60 低于 MA120" : null, !ma60Rising ? "MA60 近十日向下" : null, quarterWeak ? "近60日动量为负" : null, !above60 ? "净值低于 MA60" : null, !ma20Rising ? "MA20 仍向下" : null].filter(Boolean),
      repairPower
    };
  }

  if (longStructureIntact && shortMomentumWeak) {
    return {
      state: "pullback",
      label: "短期回调",
      severity: "watch",
      detail: "短期动量转弱，但净值仍在 MA60 上方且 MA60 未跌破 MA120，中长期骨架暂未破坏。",
      advice: "不因单个净值日下跌直接退出；等待 MA20 止跌或动能转正。若净值跌破 MA60 且 MA20 下穿 MA60，升级为趋势破坏。",
      evidence: [!above20 ? "净值低于 MA20" : null, monthWeak ? "近一月收益转负" : null, row.rsi < 45 ? "RSI 偏弱" : null, row.macdHist < 0 ? "MACD 动能为负" : null].filter(Boolean),
      repairPower
    };
  }

  if (above20 && ma20Above60 && ma60Above120 && ma20Rising) {
    return {
      state: "trend",
      label: "上行结构",
      severity: "normal",
      detail: "净值位于 MA20 上方，MA20、MA60、MA120 保持多头排列，且 MA20 近五个净值日未转弱。",
      advice: "已有持仓以跟踪和分批纪律为主；新增仓位仍需避免在短期过热时一次追入。",
      evidence: ["净值高于 MA20", "MA20 高于 MA60", "MA60 高于 MA120"],
      repairPower
    };
  }

  if (above20 && repairPower.score >= 40 && (!above60 || !ma20Above60 || !ma20Rising)) {
    return {
      state: "repair",
      label: "低位修复",
      severity: "watch",
      detail: `短期与中期修复证据正在增加，修复动力${repairPower.label}；但尚未完成中期反转确认。`,
      advice: "不追涨、不按趋势破坏处理；已有持仓以观察为主，无持仓等待 MA20 拐头并重新站回 MA60 后再研究分批建仓。",
      evidence: [...repairPower.evidence.slice(0, 4), !above60 ? "净值尚未站回 MA60" : null, !ma20Rising ? "MA20 尚未拐头向上" : null].filter(Boolean),
      repairPower
    };
  }

  return {
    state: "mixed",
    label: "震荡混合",
    severity: "watch",
    detail: "短中长期证据仍有分歧，暂时不能归类为健康回调或明确趋势破坏。",
    advice: "保持观察，等待净值与 MA20、MA60 的位置以及 MA20 方向形成一致信号。",
    evidence: [above60 ? "净值仍高于 MA60" : "净值低于 MA60", ma60Above120 ? "长期排列尚可" : "长期排列偏弱"],
    repairPower
  };
}

function reconcileSignalWithStructure(signal, structure) {
  const threshold = signal.threshold;
  let score = signal.score;
  let adjustment = 0;
  let signalText = signal.signal;
  let action = signal.action;
  let tone = signal.tone;
  let conflict = null;

  if (structure.state === "broken") {
    const capped = Math.min(score, -40);
    adjustment = capped - score;
    score = capped;
    signalText = "趋势破坏，进入防守";
    action = structure.advice;
    tone = "negative";
    if (adjustment) conflict = "短期动能与中长期风险结构存在重大分歧；模型按风险优先原则执行结构约束。";
  } else if (structure.state === "pullback") {
    const capped = clamp(score, -20, 30);
    adjustment = capped - score;
    score = capped;
    signalText = "短期回调，中期结构仍完整";
    action = structure.advice;
    tone = "neutral";
    if (adjustment) conflict = "原始动量分超出回调状态允许区间，已按中长期结构进行校准。";
  } else if (structure.state === "repair") {
    const capped = clamp(score, -10, 35);
    adjustment = capped - score;
    score = capped;
    signalText = `低位修复，动力${structure.repairPower?.label ?? "待确认"}，中期反转未确认`;
    action = structure.advice;
    tone = "neutral";
    if (adjustment) conflict = "短期指标已回暖，但 MA20 方向与 MA60 位置尚未确认，综合分仍限制在观察区。";
  } else if (structure.state === "mixed") {
    const capped = clamp(score, -25, 25);
    adjustment = capped - score;
    score = capped;
    signalText = "结构混合，等待统一";
    action = structure.advice;
    tone = "neutral";
    if (adjustment) conflict = "不同期限证据方向不一致，综合分已限制在观察区间。";
  } else {
    signalText = score >= threshold.attention ? "上行结构，趋势证据通过" : "上行结构，等待强度确认";
    action = structure.advice;
    tone = score >= 0 ? "positive" : "neutral";
  }

  const factors = [...signal.factors];
  if (adjustment) {
    factors.push({
      key: "structureGate",
      label: "结构一致性约束",
      points: adjustment,
      detail: `${structure.label}对原始分 ${signal.score > 0 ? "+" : ""}${signal.score} 进行校准，避免短期指标与中长期风险结论互相矛盾`,
      tone: adjustment > 2 ? "positive" : adjustment < -2 ? "negative" : "neutral"
    });
  }
  const groupAgreement = agreementForGroups(signal.groups, score);
  return {
    ...signal,
    score,
    signal: signalText,
    action,
    tone,
    confidence: groupAgreement.confidence,
    agreement: groupAgreement.agreement,
    factors,
    conflict,
    rawScore: signal.score,
    structureState: structure.state
  };
}

export function analyzeFund(points, profile = "balanced") {
  const clean = points
    .filter((point) => Number.isFinite(point.nav) && Number.isFinite(point.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);
  const values = clean.map((point) => Number.isFinite(point.adjustedNav) ? point.adjustedNav : point.nav);
  const ma5 = sma(values, 5);
  const ma10 = sma(values, 10);
  const ma20 = sma(values, 20);
  const ma60 = sma(values, 60);
  const ma120 = sma(values, 120);
  const ema12 = ema(values, 12);
  const ema26 = ema(values, 26);
  const dif = values.map((_, index) => ema12[index] - ema26[index]);
  const dea = ema(dif, 9);
  const macdHist = dif.map((value, index) => (value - dea[index]) * 2);
  const rsi14 = rsi(values, 14);
  const kdjValues = kdj(values, 9);
  const volatility = rollingVolatility(values, 20);
  const drawdown = rollingDrawdown(values);
  const upRatio20 = rollingUpRatio(values, 20);
  const rows = clean.map((point, index) => ({
    ...point,
    trendNav: round(values[index]),
    date: chinaDateFormatter.format(new Date(point.timestamp)),
    ma5: round(ma5[index]),
    ma10: round(ma10[index]),
    ma20: round(ma20[index]),
    ma60: round(ma60[index]),
    ma120: round(ma120[index]),
    k: round(kdjValues.k[index], 2),
    d: round(kdjValues.d[index], 2),
    j: round(kdjValues.j[index], 2),
    dif: round(dif[index], 5),
    dea: round(dea[index], 5),
    macdHist: round(macdHist[index], 5),
    rsi: round(rsi14[index], 2),
    volatility: round(volatility[index], 2),
    drawdown: round(drawdown[index], 2),
    upRatio20: round(upRatio20[index], 1)
  }));
  let currentSignal = null;
  let currentStructure = null;
  for (let index = 0; index < rows.length; index += 1) {
    if (index < 60) {
      rows[index].score = null;
      continue;
    }
    const rawSignal = scoreAt(rows, index, profile);
    const indexReturns = {
      week: round(pctChange(values, index, 5), 2),
      month: round(pctChange(values, index, 20), 2),
      quarter: round(pctChange(values, index, 60), 2),
      year: round(pctChange(values, index, 250), 2)
    };
    const structure = classifyTrendStructure(rows, index, rawSignal, indexReturns);
    const reconciled = reconcileSignalWithStructure(rawSignal, structure);
    rows[index].score = reconciled.score;
    rows[index].structureState = structure.state;
    rows[index].decision = buildDecisionMatrix(rows, index, reconciled, structure, indexReturns);
    if (index === rows.length - 1) {
      currentSignal = reconciled;
      currentStructure = structure;
    }
  }
  const currentIndex = rows.length - 1;
  const current = rows[currentIndex];
  const previous = rows[currentIndex - 1] ?? current;
  const periodReturns = {};
  for (const [key, period] of Object.entries({ week: 5, month: 20, quarter: 60, year: 250 })) {
    periodReturns[key] = round(pctChange(values, currentIndex, period), 2);
  }
  const rawSignal = currentSignal ?? scoreAt(rows, currentIndex, profile);
  const structure = currentStructure ?? classifyTrendStructure(rows, currentIndex, rawSignal, periodReturns);
  const signal = currentStructure ? currentSignal : reconcileSignalWithStructure(rawSignal, structure);
  const decision = current?.decision ?? buildDecisionMatrix(rows, currentIndex, signal, structure, periodReturns);
  return {
    rows,
    current: {
      ...current,
      dailyChange: round(current.dailyChange ?? (current.nav / previous.nav - 1) * 100, 2),
      periodReturns,
      structure,
      decision
    },
    signal,
    decision,
    analogs: calculateAnalogStats(rows, currentIndex, signal.score, 20),
    backtest: backtest(rows, profile),
    methodology: {
      indicatorName: "NAV-KDJ",
      note: "场外基金没有日内最高、最低和收盘价，本工具使用滚动净值高低区间计算随机指标，因此不等同于证券标准KDJ。",
      scoreRange: [-100, 100],
      modelVersion: "multi-horizon-v4",
      scoreMethod: "长期、中期和短期分别判断；金叉只作动能触发，趋势结构、动能与底层持仓采用三层确认，风险门控拥有独立否决权",
      profile
    }
  };
}

export function sliceByRange(rows, range) {
  if (!rows.length || range === "all") return rows;
  const days = { "3m": 92, "6m": 183, "1y": 366, "3y": 1096 }[range] ?? 366;
  const cutoff = rows.at(-1).timestamp - days * DAY_MS;
  return rows.filter((row) => row.timestamp >= cutoff);
}

export { buildDecisionMatrix, classifyTrendStructure, kdj, reconcileSignalWithStructure, rsi, scoreAt, profileThresholds };
