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

function finiteNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function directionalLabel(shortValue, longValue, labels) {
  const short = finiteNumber(shortValue);
  const long = finiteNumber(longValue);
  if (short == null && long == null) return labels.unknown;
  if ((short ?? 0) > 0 && (long ?? 0) > 0) return labels.strong;
  if ((short ?? 0) < 0 && (long ?? 0) > 0) return labels.pullback;
  if ((short ?? 0) > 0 && (long ?? 0) <= 0) return labels.repair;
  if ((short ?? 0) < 0 && (long ?? 0) < 0) return labels.weak;
  return labels.mixed;
}

export function buildEntryTiming({
  role = "watchlist",
  actionState,
  dataQuality,
  lagBusinessDays,
  returns = {},
  rsi,
  j,
  volatility,
  structureState,
  decision,
  asOfDate
}) {
  const isHolding = role === "holding";
  const reliable = dataQuality === "verified" && Number(lagBusinessDays || 0) === 0;
  const week = finiteNumber(returns.week);
  const month = finiteNumber(returns.month);
  const quarter = finiteNumber(returns.quarter);
  const halfYear = finiteNumber(returns.halfYear);
  const longRunStrong = (quarter != null && quarter >= 35) || (halfYear != null && halfYear >= 60);
  const riskLevel = decision?.risk?.level ?? (structureState === "broken" ? "high" : "normal");
  const trendPassed = decision?.confirmation?.trend?.passed === true;
  const momentumPassed = decision?.confirmation?.momentum?.passed === true;
  const shortLabel = decision?.horizon?.short?.label || directionalLabel(week, month, {
    strong: "短期偏强", pullback: "短期回调", repair: "短期修复", weak: "短期走弱", mixed: "短期震荡", unknown: "短期待确认"
  });
  const longLabel = decision?.horizon?.long?.label || directionalLabel(quarter, halfYear, {
    strong: "长期偏强", pullback: "长期仍强", repair: "长期修复", weak: "长期走弱", mixed: "长期震荡", unknown: "长期待确认"
  });
  const heatReasons = [
    week != null && week >= 8 ? `近5日上涨 ${week.toFixed(1)}%` : null,
    month != null && month >= 15 ? `近20日上涨 ${month.toFixed(1)}%` : null,
    finiteNumber(rsi) >= 74 ? `RSI ${finiteNumber(rsi).toFixed(0)}，短期偏热` : null,
    finiteNumber(j) >= 105 ? `KDJ-J ${finiteNumber(j).toFixed(0)}，短期偏热` : null
  ].filter(Boolean);
  const riskReasons = decision?.risk?.reasons ?? [];
  const highVolatility = finiteNumber(volatility) >= 45;
  const base = {
    role,
    asOfDate: asOfDate || "--",
    observedRange: "短期 5-20日 · 中期 20-60日 · 长期 60-120日",
    shortLabel,
    longLabel,
    returns: { week, month, quarter, halfYear },
    longRunStrong,
    heatReasons,
    highVolatility
  };

  if (riskLevel === "emergency" || riskLevel === "high" || structureState === "broken" || ["emergency", "reduce", "avoid", "sell"].includes(actionState)) {
    return {
      ...base,
      state: "defensive",
      label: isHolding ? "持仓风险防守" : "暂不新增",
      detail: riskReasons[0] || "中长期结构或独立风险条件尚未恢复，不考虑新增仓位。",
      trigger: "等待风险条件解除，并重新站回关键中长期均线后再评估。"
    };
  }

  if (!reliable) {
    return {
      ...base,
      state: "waiting",
      label: "等待净值确认",
      detail: "正式净值尚未完成校验，本轮只观察波动，不生成新增仓位提示。",
      trigger: "下一次正式净值完成校验后复核。"
    };
  }

  if (heatReasons.length) {
    return {
      ...base,
      state: "wait_pullback",
      label: isHolding ? "暂缓加仓" : "涨幅偏大，等待回撤",
      detail: `${heatReasons.join("；")}。趋势可能仍强，但此处追入的盈亏比下降。`,
      trigger: "等待短期热度回落、净值靠近 MA20，且 MACD/KDJ 再次同向。"
    };
  }

  if (actionState === "trial") {
    return {
      ...base,
      state: "near",
      label: "技术面转强，待基本面核验",
      detail: "趋势与动能已经改善，但最近披露持仓或财务覆盖不足，不把技术信号当作完整入场依据。",
      trigger: "补充最近一期持仓与公司研究后，再决定是否分批研究。"
    };
  }

  const fullyConfirmedHolding = isHolding
    && actionState === "hold"
    && Number(decision?.confirmation?.passed ?? 0) >= 3
    && trendPassed
    && momentumPassed;
  if (actionState === "base" || fullyConfirmedHolding) {
    return {
      ...base,
      state: "ready",
      label: isHolding ? "加仓条件较完整" : "可分批研究入场",
      detail: longRunStrong
        ? "趋势与动能已形成同向验证；中长期涨幅较大，仍应控制批次，避免一次性追入。"
        : "趋势与动能已形成同向验证，且未触发短期过热或风险否决。",
      trigger: isHolding ? "按原计划分批执行，并以 MA20 失守作为下一次复核点。" : "避免一次性买入，可按计划分批验证。"
    };
  }

  const improving = structureState === "repair"
    || structureState === "pullback"
    || decision?.horizon?.short?.state === "positive"
    || (week != null && week > 0 && month != null && month > -3);
  if (improving) {
    const trigger = decision?.nextCheck || (structureState === "pullback"
      ? "等待 MA20 止跌，并确认短期动能重新转正。"
      : "等待 MA20 走平向上，且 MACD/KDJ 至少两项继续改善。");
    return {
      ...base,
      state: "near",
      label: isHolding ? "持仓观察企稳" : "接近入场窗口",
      detail: structureState === "pullback" ? "长期骨架尚未破坏，短期正在回调，重点观察止跌确认。" : "修复或短期动能正在改善，但验证尚未完整。",
      trigger
    };
  }

  return {
    ...base,
    state: "waiting",
    label: isHolding ? "持仓继续观察" : "等待明显转强",
    detail: highVolatility ? "波动仍偏高，趋势与动能尚未形成稳定同向。" : "当前证据不足以形成清晰入场窗口。",
    trigger: decision?.nextCheck || "等待短期动能与中长期结构形成同向信号。"
  };
}
