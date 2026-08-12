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
  structureState,
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
  if (structureState === "broken") return { state: "sell", label: "风险退出", priority: 5, detail: "净值与中长期均线已构成趋势破坏，停止新增仓位；结合赎回费用、持有期限和替代方案分批降低风险" };

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
    && (!structureState || structureState === "trend")
    && fundamentalsPass
    && riskPass;
  if (entryPass) {
    return { state: "base", label: "分批建仓", priority: 3, detail: `正式净值已校验，趋势阈值通过，有效指标同向率 ${Number(confidence).toFixed(0)}%，基本面与风险过滤未触发否决；建议按计划分批执行` };
  }

  if (hasHolding && Number(compositeScore) > exitLine) {
    const detail = structureState === "pullback"
      ? "中长期骨架暂未破坏，当前属于短期回调；继续观察 MA20 是否止跌，若长期与中期指标同步恶化再升级防守"
      : structureState === "repair"
        ? "短期与中期修复证据正在增加，但反转尚未确认；已有持仓继续观察 MA20 拐头、MA60 位置和波动收敛"
        : "尚未达到新增仓位或退出阈值，已有持仓继续观察长期骨架、中期动量与回撤变化";
    return { state: "hold", label: "持有观察", priority: 2, detail };
  }

  const reason = structureState === "pullback"
    ? "中长期骨架尚未破坏，但短期动量正在回调；等待 MA20 止跌或动能转正后再研究建仓"
    : structureState === "repair"
      ? "修复证据正在形成，但尚未完成中期反转；等待 MA20 拐头并重新站回 MA60 后再研究分批建仓"
      : Number(score) < 0 ? "中长期趋势仍偏弱，等待均线结构和60日动量修复" : "指标尚未形成足够一致性，等待正式净值后的下一次确认";
  return { state: "wait", label: "等待确认", priority: 1, detail: reason };
}
