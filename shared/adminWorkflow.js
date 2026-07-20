import { getOrderedSetupTeams } from "./competitionSetup.js";

function getTeamLabel(team, index) {
  return `${index + 1}. ${team.teamName}`;
}

export function deriveDispatchControlState({
  activeGroupId,
  currentAssignment = {},
  currentSummary,
  recommendedTeamId,
  selectedTeamId,
  selectionRevision,
} = {}) {
  const currentTeamId = currentAssignment.teamId ?? null;
  const assignmentRevision = Number.isInteger(currentAssignment.assignmentRevision)
    ? currentAssignment.assignmentRevision
    : 0;
  const hasCurrentSelection = selectionRevision === assignmentRevision
    && selectedTeamId
    && selectedTeamId !== currentTeamId;
  const suggestedTeamId = hasCurrentSelection
    ? selectedTeamId
    : recommendedTeamId && recommendedTeamId !== currentTeamId
      ? recommendedTeamId
      : "";
  const submittedCount = Math.max(0, Number(currentSummary?.submittedCount) || 0);
  const rosterCount = Math.max(0, Number(currentSummary?.rosterCount) || 0);
  const missingCount = Math.max(0, rosterCount - submittedCount);
  const completedAssignment = ["final", "closed"].includes(currentAssignment.status);

  if (!activeGroupId) {
    return {
      suggestedTeamId: "",
      canDispatch: false,
      tone: "blocked",
      label: "尚未开启比赛组别",
      reason: "请先在开赛配置中确认本场队伍和评委并开启比赛。",
      missingCount,
      actionLabel: "等待开赛",
    };
  }

  if (!suggestedTeamId) {
    return {
      suggestedTeamId: "",
      canDispatch: false,
      tone: completedAssignment ? "complete" : "blocked",
      label: completedAssignment ? "暂无下一支未完成队伍" : "请选择待派发队伍",
      reason: completedAssignment
        ? "当前组已没有可继续派发的未完成队伍，请按顶部流程发布成绩或结束赛次。"
        : "服务器尚未给出可派发队伍，请核对开赛配置和抽签顺序。",
      missingCount,
      actionLabel: "暂无可派发队伍",
    };
  }

  if (!currentTeamId) {
    return {
      suggestedTeamId,
      canDispatch: true,
      tone: "ready",
      label: "可以派发首支队伍",
      reason: "已从服务器恢复本场配置，首支队伍已按抽签顺序选中。",
      missingCount: 0,
      actionLabel: "派发首支队伍",
    };
  }

  if (completedAssignment) {
    return {
      suggestedTeamId,
      canDispatch: true,
      tone: "ready",
      label: "已满足下一队派发条件",
      reason: `当前队 ${submittedCount}/${rosterCount} 位评委已提交，下一队已按抽签顺序选中。`,
      missingCount: 0,
      actionLabel: "派发下一队",
    };
  }

  if (rosterCount > 0 && submittedCount >= rosterCount) {
    return {
      suggestedTeamId,
      canDispatch: false,
      tone: "syncing",
      label: "评分已齐，等待服务器确认",
      reason: `已收到 ${submittedCount}/${rosterCount} 份提交，但当前派发尚未转为已完成。请等待同步或刷新，不要重复派发当前队。`,
      missingCount: 0,
      actionLabel: "等待服务器确认",
    };
  }

  return {
    suggestedTeamId,
    canDispatch: false,
    tone: "blocked",
    label: rosterCount ? `还差 ${missingCount} 位评委提交` : "等待当前队评分",
    reason: rosterCount
      ? `当前队已提交 ${submittedCount}/${rosterCount}。全部有效评委提交后会自动解锁下一队派发。`
      : "当前队评分快照尚未同步，请等待服务器确认。",
    missingCount,
    actionLabel: "等待当前队完成",
  };
}

export function deriveCompetitionPreflight(
  state,
  { groupId, passwordReady = true, teamIds, judgeIds } = {},
) {
  const setup = state.competitionSetup?.groups?.[groupId];
  const selectedTeamIds = teamIds ?? setup?.teamIds ?? [];
  const selectedJudgeIds = judgeIds ?? setup?.judgeIds ?? [];
  const uniqueTeamIds = [...new Set(selectedTeamIds)];
  const uniqueJudgeIds = [...new Set(selectedJudgeIds)];
  const hasDuplicateTeams = uniqueTeamIds.length !== selectedTeamIds.length;
  const hasDuplicateJudges = uniqueJudgeIds.length !== selectedJudgeIds.length;
  const teamsById = new Map((state.teams ?? []).map((team) => [team.id, team]));
  const accountsById = new Map((state.accounts ?? []).map((account) => [account.id, account]));
  const selectedTeams = uniqueTeamIds.map((id) => teamsById.get(id)).filter(Boolean);
  const teamSelectionReady = !hasDuplicateTeams && uniqueTeamIds.length > 0 && selectedTeams.length === uniqueTeamIds.length && selectedTeams.every(
    (team) => team.groupId === groupId && team.status === "active",
  );
  const teamInformationReady = selectedTeams.length > 0 && selectedTeams.every(
    (team) => team.teamName?.trim() && team.registrationNumber?.trim(),
  );
  const judgeAccountsReady = !hasDuplicateJudges && uniqueJudgeIds.length > 0 && uniqueJudgeIds.every((id) => {
    const account = accountsById.get(id);
    return account?.role === "judge" && account.status === "active";
  });
  return [
    { id: "admin_password", label: "管理员密码", status: passwordReady ? "complete" : "blocked" },
    { id: "team_information", label: "队伍资料", status: teamInformationReady ? "complete" : "blocked" },
    { id: "team_count", label: "本场队伍", status: teamSelectionReady ? "complete" : "blocked", value: uniqueTeamIds.length },
    { id: "judge_accounts", label: "评委账号", status: judgeAccountsReady ? "complete" : "blocked" },
    { id: "judge_count", label: "本场评委", status: judgeAccountsReady && uniqueJudgeIds.length >= 3 ? "complete" : "blocked", value: uniqueJudgeIds.length },
  ];
}

export function deriveAdminWorkflowStatus(
  state,
  { groupId, requireAdminPasswordRotation = false, adminAccountId = "" } = {},
) {
  const setup = state.competitionSetup?.groups?.[groupId];
  const admin = (state.accounts ?? []).find((account) => account.id === adminAccountId);
  const passwordReady = !requireAdminPasswordRotation || Number(admin?.passwordVersion) > 1;
  const orderedTeams = getOrderedSetupTeams(state, groupId);
  const assignment = state.activeAssignment ?? {};
  const currentTeam = assignment.groupId === groupId
    ? orderedTeams.find((team) => team.id === assignment.teamId) ?? null
    : null;
  const currentSummary = currentTeam ? state.summariesByTeam?.[currentTeam.id] : null;
  const completedTeams = orderedTeams.filter((team) => state.summariesByTeam?.[team.id]?.isFinal).length;
  const progress = {
    completedTeams,
    totalTeams: orderedTeams.length,
    percentage: orderedTeams.length ? Math.round((completedTeams / orderedTeams.length) * 100) : 0,
    currentTeamId: currentTeam?.id ?? null,
    currentSubmittedCount: currentSummary?.submittedCount ?? 0,
    currentRosterCount: currentSummary?.rosterCount ?? (currentTeam ? setup?.judgeIds?.length ?? 0 : 0),
  };
  const checks = deriveCompetitionPreflight(state, { groupId, passwordReady });

  if (!passwordReady) {
    return {
      phase: "security_check",
      groupId,
      recommendedTeamId: null,
      checks,
      progress,
      primaryAction: { id: "rotate_admin_password", label: "修改管理员密码" },
    };
  }

  if (setup?.status === "closed") {
    return {
      phase: "competition_complete",
      groupId,
      currentTeamId: null,
      recommendedTeamId: null,
      checks,
      progress,
      primaryAction: { id: "review_rankings", label: "查看本组排名", groupId },
    };
  }

  if (!setup || setup.status !== "open" || state.competitionSetup?.activeGroupId !== groupId) {
    return {
      phase: "setup_required",
      groupId,
      recommendedTeamId: orderedTeams[0]?.id ?? null,
      checks,
      progress,
      primaryAction: { id: "review_competition_setup", label: "核对开赛配置", groupId },
    };
  }

  const nextTeam = orderedTeams.find(
    (team) => team.id !== currentTeam?.id && !state.summariesByTeam?.[team.id]?.isFinal,
  ) ?? null;
  const currentIndex = currentTeam ? orderedTeams.findIndex((team) => team.id === currentTeam.id) : -1;
  const openingBatchTeams = orderedTeams.slice(0, 3);
  const openingBatchReady = openingBatchTeams.length === 3 && openingBatchTeams.every(
    (team) => state.summariesByTeam?.[team.id]?.isFinal,
  );

  if (
    orderedTeams.length >= 3 &&
    currentTeam &&
    currentSummary?.isFinal &&
    currentIndex >= 0 &&
    currentIndex < 2 &&
    nextTeam
  ) {
    const nextIndex = orderedTeams.findIndex((team) => team.id === nextTeam.id);
    return {
      phase: "opening_scores_held",
      groupId,
      currentTeamId: currentTeam.id,
      recommendedTeamId: nextTeam.id,
      checks,
      progress,
      primaryAction: {
        id: "dispatch_recommended_team",
        label: `选择并核对 ${getTeamLabel(nextTeam, nextIndex)}`,
        teamId: nextTeam.id,
      },
    };
  }

  if (openingBatchReady && currentIndex < 3) {
    return {
      phase: "opening_batch_ready",
      groupId,
      currentTeamId: currentTeam?.id ?? null,
      recommendedTeamId: nextTeam?.id ?? null,
      checks,
      progress,
      primaryAction: {
        id: "publish_opening_batch",
        label: "按顺序公布前三队成绩",
        teamIds: openingBatchTeams.map((team) => team.id),
      },
      ...(completedTeams === orderedTeams.length ? {
        secondaryAction: {
          id: "close_competition_group",
          label: "暂不展示，直接结束本组",
          groupId,
        },
      } : {}),
    };
  }

  if (
    currentTeam &&
    currentSummary?.isFinal &&
    (state.displaySelection?.teamId !== currentTeam.id || state.displaySelection?.publicationStatus !== "final")
  ) {
    return {
      phase: "result_ready",
      groupId,
      currentTeamId: currentTeam.id,
      recommendedTeamId: nextTeam?.id ?? null,
      checks,
      progress,
      primaryAction: { id: "publish_current_result", label: `发布 ${currentTeam.teamName} 成绩`, teamId: currentTeam.id },
      ...(completedTeams === orderedTeams.length ? {
        secondaryAction: {
          id: "close_competition_group",
          label: "暂不展示，直接结束本组",
          groupId,
        },
      } : {}),
    };
  }

  if (orderedTeams.length > 0 && completedTeams === orderedTeams.length) {
    return {
      phase: "ready_to_close",
      groupId,
      currentTeamId: currentTeam?.id ?? null,
      recommendedTeamId: null,
      checks,
      progress,
      primaryAction: { id: "close_competition_group", label: "结束本组比赛", groupId },
    };
  }

  if (currentTeam && ["scoring", "awaiting_submissions"].includes(assignment.status)) {
    return {
      phase: "scoring",
      groupId,
      currentTeamId: currentTeam.id,
      recommendedTeamId: nextTeam?.id ?? null,
      checks,
      progress,
      primaryAction: { id: "monitor_current_team", label: "查看当前队评分进度", teamId: currentTeam.id },
    };
  }

  const nextIndex = orderedTeams.findIndex((team) => team.id === nextTeam.id);
  return {
    phase: "ready_to_dispatch",
    groupId,
    currentTeamId: currentTeam?.id ?? null,
    recommendedTeamId: nextTeam.id,
    checks,
    progress,
    primaryAction: {
      id: "dispatch_recommended_team",
      label: `选择并核对 ${getTeamLabel(nextTeam, nextIndex)}`,
      teamId: nextTeam.id,
    },
  };
}
