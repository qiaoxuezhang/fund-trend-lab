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

const profileThresholds = {
  conservative: { attention: 50, reduce: -28 },
  balanced: { attention: 36, reduce: -36 },
  aggressive: { attention: 25, reduce: -46 }
};

function scoreAt(rows, index, profile = "balanced") {
  const row = rows[index];
  const previous = rows[Math.max(0, index - 1)];
  const values = rows.map((item) => item.trendNav);
  const factors = [];
  let score = 0;

  const add = (key, label, points, detail) => {
    score += points;
    factors.push({ key, label, points, detail, tone: points > 2 ? "positive" : points < -2 ? "negative" : "neutral" });
  };

  if (row.ma20 != null) add("ma20", "20日趋势", row.trendNav >= row.ma20 ? 10 : -10, row.trendNav >= row.ma20 ? "累计净值位于20日均线上方" : "累计净值位于20日均线下方");
  if (row.ma60 != null && row.ma20 != null) add("ma60", "20-60日排列", row.ma20 >= row.ma60 ? 10 : -10, row.ma20 >= row.ma60 ? "20日均线高于60日均线" : "20日均线低于60日均线");
  if (row.ma120 != null && row.ma60 != null) add("ma120", "60-120日排列", row.ma60 >= row.ma120 ? 12 : -12, row.ma60 >= row.ma120 ? "60日均线高于120日均线" : "60日均线低于120日均线");
  if (index >= 5 && row.ma20 != null && rows[index - 5].ma20 != null) add("slope", "均线方向", row.ma20 >= rows[index - 5].ma20 ? 8 : -8, row.ma20 >= rows[index - 5].ma20 ? "20日均线近5日向上" : "20日均线近5日向下");

  const golden = crossedAbove(rows.map((item) => item.k), rows.map((item) => item.d), index);
  const dead = crossedBelow(rows.map((item) => item.k), rows.map((item) => item.d), index);
  add("kdj", "NAV-KDJ", golden ? 10 : dead ? -10 : row.k >= row.d ? 5 : -5, golden ? "近3个净值日形成金叉，仅作为短周期辅助" : dead ? "近3个净值日形成死叉，仅作为短周期辅助" : row.k >= row.d ? "K值保持在D值上方" : "K值处于D值下方");

  const macdCrossUp = previous.macdHist != null && previous.macdHist <= 0 && row.macdHist > 0;
  const macdCrossDown = previous.macdHist != null && previous.macdHist >= 0 && row.macdHist < 0;
  add("macd", "MACD动能", macdCrossUp ? 12 : macdCrossDown ? -12 : row.macdHist >= 0 ? 8 : -8, macdCrossUp ? "柱体刚转为正值" : macdCrossDown ? "柱体刚转为负值" : row.macdHist >= 0 ? "中短期动能为正" : "中短期动能为负");

  let rsiPoints = 0;
  let rsiDetail = "RSI处于中性区间";
  if (row.rsi != null) {
    if (row.rsi >= 75) { rsiPoints = -6; rsiDetail = "RSI较高，追涨风险上升"; }
    else if (row.rsi >= 55) { rsiPoints = 4; rsiDetail = "RSI显示趋势动能健康"; }
    else if (row.rsi < 30) { rsiPoints = row.rsi > (previous.rsi ?? row.rsi) ? 4 : -3; rsiDetail = rsiPoints > 0 ? "超卖区出现回升" : "仍在超卖区，尚待转向"; }
    else if (row.rsi < 45) { rsiPoints = -4; rsiDetail = "RSI偏弱"; }
  }
  add("rsi", "RSI强弱", rsiPoints, rsiDetail);

  const momentum20 = pctChange(values, index, 20);
  const momentum60 = pctChange(values, index, 60);
  const momentum120 = pctChange(values, index, 120);
  if (momentum20 != null) add("momentum", "20日动量", momentum20 >= 0 ? 5 : -5, `近20个净值日${momentum20 >= 0 ? "上涨" : "下跌"}${Math.abs(momentum20).toFixed(2)}%`);
  if (momentum60 != null) add("medium", "60日动量", momentum60 >= 0 ? 8 : -8, `近60个净值日${momentum60 >= 0 ? "上涨" : "下跌"}${Math.abs(momentum60).toFixed(2)}%`);
  if (momentum120 != null) add("longMomentum", "120日动量", momentum120 >= 0 ? 10 : -10, `近120个净值日${momentum120 >= 0 ? "上涨" : "下跌"}${Math.abs(momentum120).toFixed(2)}%`);
  if (row.upRatio20 != null) {
    const persistencePoints = row.upRatio20 >= 55 ? 6 : row.upRatio20 <= 45 ? -6 : 0;
    add("persistence", "趋势持续性", persistencePoints, `近20个净值日中上涨日占${row.upRatio20.toFixed(0)}%`);
  }

  let riskPoints = 0;
  const riskNotes = [];
  if (row.drawdown <= -25) { riskPoints -= 8; riskNotes.push("近250净值日回撤超过25%"); }
  else if (row.drawdown <= -15) { riskPoints -= 4; riskNotes.push("近250净值日回撤超过15%"); }
  if (row.volatility >= 35) { riskPoints -= 6; riskNotes.push("年化波动较高"); }
  else if (row.volatility >= 25) { riskPoints -= 4; riskNotes.push("年化波动偏高"); }
  add("risk", "风险过滤", riskPoints, riskNotes.length ? riskNotes.join("，") : "回撤和波动未触发额外扣分");

  score = Math.round(clamp(score, -100, 100));
  const threshold = profileThresholds[profile] ?? profileThresholds.balanced;
  let signal = score >= 0 ? "方向不清，继续观察" : "震荡偏弱，等待企稳";
  let action = score >= 0 ? "中长期指标仍有分歧，暂不新增仓位" : "趋势尚未企稳，等待60日动量或均线结构改善";
  let tone = "neutral";
  if (score >= Math.max(65, threshold.attention + 15)) {
    signal = "中期趋势偏强";
    action = "中长期趋势保持向上；已有持仓可观察，新增仓位仍应分批";
    tone = "positive";
  } else if (score >= threshold.attention) {
    signal = "可分批建仓";
    action = "20-120日趋势达到当前阈值，可结合估值和仓位分批执行";
    tone = "positive";
  } else if (score <= Math.min(-65, threshold.reduce - 15)) {
    signal = "中期趋势偏弱";
    action = "优先控制仓位，等待60日动量和均线结构重新转强";
    tone = "negative";
  } else if (score <= threshold.reduce) {
    signal = "弱势防守";
    action = "中期弱势证据较多，可结合持有期限与费用降低风险暴露";
  } else if (score >= 15) {
    signal = "震荡偏强，等待突破";
    action = "趋势正在改善，但尚未达到建仓阈值，继续观察60日动量";
    tone = "positive";
  }
  const effectiveFactors = factors.filter((factor) => factor.points !== 0);
  const alignedFactors = effectiveFactors.filter((factor) => Math.sign(factor.points) === Math.sign(score));
  const confidence = score === 0 ? 0 : Math.round(alignedFactors.length / Math.max(1, effectiveFactors.length) * 100);
  return {
    score,
    signal,
    action,
    tone,
    confidence,
    agreement: { aligned: alignedFactors.length, total: effectiveFactors.length },
    factors,
    threshold
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

function backtest(rows, profile = "balanced", transactionCost = 0.0015) {
  if (rows.length < 90) return null;
  const threshold = profileThresholds[profile] ?? profileThresholds.balanced;
  let position = 0;
  let strategy = 1;
  let benchmark = 1;
  let trades = 0;
  let investedDays = 0;
  const equity = [1];
  const benchmarkEquity = [1];
  for (let i = 60; i < rows.length - 1; i += 1) {
    const score = rows[i].score;
    let nextPosition = position;
    if (score >= threshold.attention) nextPosition = 1;
    if (score <= threshold.reduce) nextPosition = 0;
    if (nextPosition !== position) {
      strategy *= 1 - transactionCost;
      trades += 1;
    }
    position = nextPosition;
    if (position) investedDays += 1;
    const nextReturn = rows[i + 1].trendNav / rows[i].trendNav - 1;
    strategy *= 1 + position * nextReturn;
    benchmark *= 1 + nextReturn;
    equity.push(strategy);
    benchmarkEquity.push(benchmark);
  }
  return {
    strategyReturn: round((strategy - 1) * 100, 2),
    benchmarkReturn: round((benchmark - 1) * 100, 2),
    strategyMaxDrawdown: round(maxDrawdown(equity), 2),
    benchmarkMaxDrawdown: round(maxDrawdown(benchmarkEquity), 2),
    trades,
    investedRatio: round(investedDays / Math.max(1, rows.length - 61) * 100, 1),
    transactionCost: transactionCost * 100
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
  for (let index = 0; index < rows.length; index += 1) {
    rows[index].score = index < 60 ? null : scoreAt(rows, index, profile).score;
  }
  const currentIndex = rows.length - 1;
  const signal = scoreAt(rows, currentIndex, profile);
  const current = rows[currentIndex];
  const previous = rows[currentIndex - 1] ?? current;
  const periodReturns = {};
  for (const [key, period] of Object.entries({ week: 5, month: 20, quarter: 60, year: 250 })) {
    periodReturns[key] = round(pctChange(values, currentIndex, period), 2);
  }
  return {
    rows,
    current: {
      ...current,
      dailyChange: round(current.dailyChange ?? (current.nav / previous.nav - 1) * 100, 2),
      periodReturns
    },
    signal,
    analogs: calculateAnalogStats(rows, currentIndex, signal.score, 20),
    backtest: backtest(rows, profile),
    methodology: {
      indicatorName: "NAV-KDJ",
      note: "场外基金没有日内最高、最低和收盘价，本工具使用滚动净值高低区间计算随机指标，因此不等同于证券标准KDJ。",
      scoreRange: [-100, 100],
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

export { kdj, rsi, scoreAt, profileThresholds };
