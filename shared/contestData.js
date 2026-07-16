// Shared competition baseline used by browser, server, and operational scripts.
export const defaultGroupId = "gaozhi";

export const contestGroups = [
  { id: "gaozhi", label: "高职组", shortLabel: "高职", prefix: "GZ" },
  { id: "zhongzhi", label: "中职组", shortLabel: "中职", prefix: "ZZ" },
  { id: "benke", label: "本科组", shortLabel: "本科", prefix: "BK" },
  { id: "shehui", label: "社会组", shortLabel: "社会", prefix: "SH" },
];

const gaozhiTeamNames = [
  "从容应队",
  "我们都对队",
  "奶龙大王",
  "智启南洋",
  "饭醉团伙",
  "Trisilk",
  "电亮星光",
  "硅屿",
  "LAST.K",
  "“AI“上东南亚",
  "数航AI社",
  "启航跨境",
  "五哈队",
  "全球链通",
  "战神队",
  "织境·泰",
  "智澜南洋",
  "斯莱特林",
  "活着就知组",
  "AI跨境电商小组",
];

const gaozhiRegistrationNumbers = [
  "CT-1903",
  "CT-1867",
  "CT-1847",
  "CT-1766",
  "CT-1682",
  "CT-1485",
  "CT-0882",
  "CT-0718",
  "CT-0592",
  "CT-0586",
  "CT-0568",
  "CT-0559",
  "CT-0464",
  "CT-0276",
  "CT-0271",
  "CT-0062",
  "CT-0045",
  "CT-0756",
  "CT-1633",
  "CT-1693",
];

const zhongzhiTeamNames = [
  "灵犀东盟",
  "猪猪特攻队",
  "Light",
  "智胜千里",
  "鱼儿快游",
  "数启新程",
  "盟未来",
  "云龙风虎",
  "潜龙起云",
  "破晓星芒队",
  "星途队",
  "跨界智创",
  "王牌战队",
  "壮乡福贸团队",
  "跨海极速",
  "跨境先锋队",
  "四衡制胜队",
  "GCBT ASEAN Smart",
  "Ai破浪小分队",
  "逐浪跨境社",
];

const zhongzhiRegistrationNumbers = [
  "CT-1681",
  "CT-1640",
  "CT-1476",
  "CT-1322",
  "CT-1278",
  "CT-0871",
  "CT-0837",
  "CT-0803",
  "CT-0801",
  "CT-0796",
  "CT-0777",
  "CT-0749",
  "CT-0699",
  "CT-0599",
  "CT-0539",
  "CT-0515",
  "CT-0416",
  "CT-0319",
  "CT-0313",
  "CT-0311",
];

const benkeTeamNames = [
  "GOAT",
  "ai智创",
  "畅通无组",
  "伍限热度",
  "东盟智航队",
  "东盟启航队",
  "以人民为组",
  "椒你致富",
  "你说的都队",
  "一键爆单队",
  "越智云航",
  "拓境AI",
  "说的都队",
  "创意无限队",
  "最美F4队",
  "探险队",
  "PureX",
  "IMFEARLESS",
  "数境南洋",
  "天生一对",
];

const benkeRegistrationNumbers = [
  "CT-0169",
  "CT-0700",
  "CT-0851",
  "CT-0123",
  "CT-0594",
  "CT-0122",
  "CT-1818",
  "CT-0367",
  "CT-0805",
  "CT-0628",
  "CT-1737",
  "CT-1280",
  "CT-0199",
  "CT-0787",
  "CT-0758",
  "CT-0806",
  "CT-0248",
  "CT-1924",
  "CT-0823",
  "CT-0120",
];

const shehuiTeamNames = [
  "跨境电商综合试验区全链路AI赋能公共服务平台建设项目团队",
  "Flyelep飞象全球电商内容智能体",
  "LaungPro AI Thailand",
  "零探路径",
  "羽飞科技AI跨境智造团队",
  "未来清研TSINGTEC",
  "信人智连",
  "乘AI出海",
  "STARGO",
  "中国通服广西设计公司团队",
  "TURING",
  "智关通团队",
  "破浪有时",
  "丝路智汇队",
  "折叠视觉",
  "铭阅科技",
  "跨境鸟",
  "中南踢卡团队",
  "Gate",
  "星屿 AI 跨境团",
];

const shehuiRegistrationNumbers = [
  "ST-0022",
  "ST-0036",
  "ST-0161",
  "ST-2103",
  "ST-0529",
  "ST-0260",
  "ST-2105",
  "ST-0265",
  "ST-0788",
  "ST-0692",
  "ST-1537",
  "ST-1940",
  "ST-1898",
  "ST-1783",
  "ST-1931",
  "ST-2102",
  "ST-1786",
  "ST-1936",
  "ST-2100",
  "ST-2095",
];

const teamNamesByGroup = {
  gaozhi: gaozhiTeamNames,
  zhongzhi: zhongzhiTeamNames,
  benke: benkeTeamNames,
  shehui: shehuiTeamNames,
};

const registrationNumbersByGroup = {
  gaozhi: gaozhiRegistrationNumbers,
  zhongzhi: zhongzhiRegistrationNumbers,
  benke: benkeRegistrationNumbers,
  shehui: shehuiRegistrationNumbers,
};

function createCandidate(group, index, team, registrationNumber = "") {
  const code = String(index + 1).padStart(2, "0");
  return {
    id: `${group.prefix}${code}`,
    code,
    registrationNumber,
    groupId: group.id,
    groupLabel: group.label,
    team,
    product: "",
    order: `${index + 1} / 20`,
  };
}

function createGroupCandidates(group, names) {
  const registrationNumbers = registrationNumbersByGroup[group.id] ?? [];
  return Array.from({ length: 20 }, (_, index) => {
    const fallbackName = `${group.label}待定${String(index + 1).padStart(2, "0")}`;
    return createCandidate(group, index, names[index] ?? fallbackName, registrationNumbers[index] ?? "");
  });
}

export const defaultCandidates = contestGroups.flatMap((group) =>
  createGroupCandidates(group, teamNamesByGroup[group.id] ?? []),
);

export const candidateIds = defaultCandidates.map((candidate) => candidate.id);

export const defaultCandidateOrderByGroup = Object.fromEntries(
  contestGroups.map((group) => [
    group.id,
    defaultCandidates.filter((candidate) => candidate.groupId === group.id).map((candidate) => candidate.id),
  ]),
);

export function getGroupById(groupId) {
  return contestGroups.find((group) => group.id === groupId) ?? contestGroups[0];
}

export function getCandidateById(candidateId, candidates = defaultCandidates) {
  return candidates.find((candidate) => candidate.id === candidateId) ?? null;
}

export function getCandidateGroupId(candidateId, candidates = defaultCandidates) {
  return getCandidateById(candidateId, candidates)?.groupId ?? defaultGroupId;
}

export function getCandidatesByGroup(candidates, groupId) {
  const selectedGroup = getGroupById(groupId);
  return candidates.filter((candidate) => candidate.groupId === selectedGroup.id);
}

export function sanitizeCandidateOrderByGroup(savedOrderByGroup = {}) {
  const sourceOrderByGroup = savedOrderByGroup && typeof savedOrderByGroup === "object" ? savedOrderByGroup : {};

  return Object.fromEntries(
    contestGroups.map((group) => {
      const defaultOrder = defaultCandidateOrderByGroup[group.id] ?? [];
      const allowedIds = new Set(defaultOrder);
      const seenIds = new Set();
      const savedOrder = Array.isArray(sourceOrderByGroup[group.id]) ? sourceOrderByGroup[group.id] : [];
      const sanitizedOrder = savedOrder.filter((candidateId) => {
        if (!allowedIds.has(candidateId) || seenIds.has(candidateId)) return false;
        seenIds.add(candidateId);
        return true;
      });

      defaultOrder.forEach((candidateId) => {
        if (!seenIds.has(candidateId)) sanitizedOrder.push(candidateId);
      });

      return [group.id, sanitizedOrder];
    }),
  );
}

export function applyCandidateOrder(candidates, orderByGroup) {
  const sanitizedOrderByGroup = sanitizeCandidateOrderByGroup(orderByGroup);
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));

  return contestGroups.flatMap((group) => {
    const groupOrder = sanitizedOrderByGroup[group.id] ?? defaultCandidateOrderByGroup[group.id] ?? [];
    return groupOrder
      .map((candidateId, index) => {
        const candidate = candidatesById.get(candidateId);
        if (!candidate) return null;
        return {
          ...candidate,
          order: `${index + 1} / ${groupOrder.length}`,
          sortIndex: index + 1,
        };
      })
      .filter(Boolean);
  });
}
