const finite = (value) => Number.isFinite(Number(value));

export function normalizeTarget(value, fallback = 20) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(200, Math.max(5, parsed)) : fallback;
}

export function decidePortfolioAction({
  technicalState,
  technicalLabel,
  score,
  compositeScore,
  confidence,
  attentionThreshold,
  reduceThreshold,
  fundamentalScore,
  fundamentalUsable,
  drawdown,
  volatility,
  holdingReturnPct,
  hasHolding,
  targetPct,
  dataQuality,
  lagBusinessDays
}) {
  const target = normalizeTarget(targetPct);
  const reliable = dataQuality === "verified" && Number(lagBusinessDays || 0) === 0;
  if (!reliable) return { state: "wait", label: "等待确认", priority: 1, detail: "正式净值尚未完成双源校验，本次只展示风险信息，不生成交易建议" };
  if (technicalLabel === "样本不足") return { state: "wait", label: "等待确认", priority: 1, detail: "历史净值少于120个净值日，趋势样本不足，暂不生成交易建议" };

  if (finite(holdingReturnPct) && Number(holdingReturnPct) >= target) {
    return {
      state: "take-profit",
      label: "分批止盈",
      priority: 5,
      detail: `持有收益 ${Number(holdingReturnPct).toFixed(1)}% 已达到目标 ${target.toFixed(1)}%，参考分2至3次止盈`
    };
  }

  const exitLine = finite(reduceThreshold) ? Number(reduceThreshold) : -35;
  if (technicalState === "risk" || Number(compositeScore) <= exitLine) {
    return { state: "sell", label: "风险退出", priority: 4, detail: "20至120日趋势和动能达到防守阈值，执行前需核对赎回费、持有期限及组合替代方案" };
  }

  const entryLine = finite(attentionThreshold) ? Number(attentionThreshold) : 40;
  const fundamentalsPass = !fundamentalUsable || !finite(fundamentalScore) || Number(fundamentalScore) >= -10;
  const riskPass = (!finite(drawdown) || Number(drawdown) >= -25) && (!finite(volatility) || Number(volatility) <= 85);
  const entryPass = technicalState === "candidate"
    && Number(compositeScore) >= entryLine
    && Number(confidence) >= 70
    && fundamentalsPass
    && riskPass;
  if (entryPass) {
    return { state: "base", label: "分批建仓", priority: 3, detail: `正式净值已校验，趋势阈值通过，有效指标同向率 ${Number(confidence).toFixed(0)}%，基本面与风险过滤未触发否决；建议按计划分批执行` };
  }

  if (hasHolding && Number(compositeScore) > exitLine) {
    return { state: "hold", label: "持有观察", priority: 2, detail: "尚未达到新增仓位或退出阈值，已有持仓继续观察均线结构、60日动量与回撤变化" };
  }

  const reason = Number(score) < 0 ? "中长期趋势仍偏弱，等待均线结构和60日动量修复" : "指标尚未形成足够一致性，等待正式净值后的下一次确认";
  return { state: "wait", label: "等待确认", priority: 1, detail: reason };
}
