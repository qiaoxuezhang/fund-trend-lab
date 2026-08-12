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
  lagBusinessDays,
  decision
}) {
  const target = normalizeTarget(targetPct);
  const reliable = dataQuality === "verified" && Number(lagBusinessDays || 0) === 0;
  const riskLevel = decision?.risk?.level ?? (structureState === "broken" ? "high" : "normal");
  const technicalConfirmations = Number(decision?.confirmation?.passed ?? 0);
  const underlyingPassed = decision?.confirmation?.underlying?.passed;
  const nextCheck = decision?.nextCheck || "等待下一次正式净值更新后复核";

  if (riskLevel === "emergency") {
    return hasHolding
      ? { state: "emergency", label: "紧急避险", priority: 7, detail: `独立风险门控已触发：${decision.risk.reasons.join("；")}。先核对是否存在分红、巨额赎回或数据异常，再结合赎回限制尽快降低暴露` }
      : { state: "avoid", label: "暂不介入", priority: 7, detail: `独立风险门控已触发：${decision.risk.reasons.join("；")}。风险解除前不研究新增仓位` };
  }
  if (!reliable) return { state: "wait", label: "等待净值确认", priority: 1, detail: "正式净值尚未完成双源校验，本次只展示风险信息，不生成新增仓位建议" };
  if (technicalLabel === "样本不足") return { state: "wait", label: "等待确认", priority: 1, detail: "历史净值少于120个净值日，趋势样本不足，暂不生成交易建议" };

  if (riskLevel === "high" || structureState === "broken") {
    return hasHolding
      ? { state: "reduce", label: "降低仓位", priority: 6, detail: `中长期风险门控已触发：${decision?.risk?.reasons?.join("；") || "趋势结构破坏"}。停止加仓，并结合持有期限、赎回费和替代方案分批降低风险` }
      : { state: "avoid", label: "暂不介入", priority: 6, detail: "中长期风险门控已触发，停止研究新增仓位，等待结构修复" };
  }

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
    return hasHolding
      ? { state: "reduce", label: "暂停加仓", priority: 4, detail: "20至120日趋势和动能进入防守区，但尚未触发紧急门控；保留观察仓位并核对赎回费与持有期限" }
      : { state: "avoid", label: "暂不介入", priority: 4, detail: "20至120日趋势和动能进入防守区，等待修复后再评估" };
  }

  const entryLine = finite(attentionThreshold) ? Number(attentionThreshold) : 40;
  const fundamentalsPass = !fundamentalUsable || !finite(fundamentalScore) || Number(fundamentalScore) >= -10;
  const riskPass = (!finite(drawdown) || Number(drawdown) >= -25) && (!finite(volatility) || Number(volatility) <= 85);
  const entryPass = technicalState === "candidate"
    && Number(compositeScore) >= entryLine
    && Number(confidence) >= 70
    && (!structureState || structureState === "trend")
    && fundamentalsPass
    && riskPass
    && technicalConfirmations >= 2
    && underlyingPassed === true;
  if (entryPass) {
    return hasHolding
      ? { state: "hold", label: "持有并按计划加仓", priority: 3, detail: `趋势结构、动能触发和底层持仓三层确认通过，风险门控正常；只按预设批次执行，下一检查：${nextCheck}` }
      : { state: "base", label: "分批建仓候选", priority: 3, detail: `趋势结构、动能触发和底层持仓三层确认通过，风险门控正常；建议分2至4批执行，下一检查：${nextCheck}` };
  }

  const trialPass = technicalState === "candidate"
    && technicalConfirmations >= 2
    && underlyingPassed == null
    && Number(compositeScore) >= entryLine
    && Number(confidence) >= 70
    && riskPass;
  if (trialPass && !hasHolding) {
    return { state: "trial", label: "小额试仓候选", priority: 2, detail: `趋势与动能已确认，但最近披露持仓或财务覆盖不足，不能视为完整三层通过；仅可用计划仓位的小比例验证，下一检查：${nextCheck}` };
  }

  if (hasHolding && Number(compositeScore) > exitLine) {
    const detail = structureState === "pullback"
      ? "中长期骨架暂未破坏，当前属于短期回调；继续观察 MA20 是否止跌，若长期与中期指标同步恶化再升级防守"
      : structureState === "repair"
        ? "短期与中期修复证据正在增加，但反转尚未确认；已有持仓继续观察 MA20 拐头、MA60 位置和波动收敛"
        : "尚未达到新增仓位或退出阈值，已有持仓继续观察长期骨架、中期动量与回撤变化";
    const label = structureState === "pullback" ? "持有，暂停加仓" : "持有观察";
    return { state: "hold", label, priority: 2, detail: `${detail}；下一检查：${nextCheck}` };
  }

  const reason = structureState === "pullback"
    ? "中长期骨架尚未破坏，但短期动量正在回调；等待 MA20 止跌或动能转正后再研究建仓"
    : structureState === "repair"
      ? "修复证据正在形成，但尚未完成中期反转；等待 MA20 拐头并重新站回 MA60 后再研究分批建仓"
      : Number(score) < 0 ? "中长期趋势仍偏弱，等待均线结构和60日动量修复" : "指标尚未形成足够一致性，等待正式净值后的下一次确认";
  return { state: "wait", label: "自选等待确认", priority: 1, detail: `${reason}；下一检查：${nextCheck}` };
}
