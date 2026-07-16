// Scores are stored and calculated in hundredths to preserve 0.01 precision.
export const scoreScale = 100;

export const rubric = [
  {
    id: "marketing",
    title: "商品数字化营销实践",
    max: 25,
    accent: "teal",
    items: [
      { id: "content", title: "商品营销内容完成情况", max: 10, desc: "围绕平台随机商品，完成产品推广图文、短视频、营销文案等数字化营销素材的设计与制作，成果较为完整，内容较丰富。" },
      { id: "scenario", title: "场景贴合度", max: 8, desc: "商品选择与营销设计能够体现东盟区域经贸合作背景，符合跨境电商业务逻辑和目标市场需求，应用场景明确。" },
      { id: "quality", title: "营销设计质量", max: 7, desc: "图文、短视频、文案等内容具有一定吸引力、传播力和转化导向，整体表达较专业，能够较好支撑商品推广。" },
    ],
  },
  {
    id: "ai",
    title: "AI 技术应用能力",
    max: 30,
    accent: "blue",
    items: [
      { id: "breadth", title: "AI 技术应用广度", max: 10, desc: "能够将 AI 技术应用于内容生成、短视频制作、数字人展示、智能推荐、多语种语音合成、数据分析等多个跨境电商环节。" },
      { id: "depth", title: "AI 技术应用深度", max: 10, desc: "对 AI 工具、模型或工作流使用较熟练，能够体现流程整合、自动化处理和系统化应用能力。" },
      { id: "rationality", title: "技术应用合理性", max: 10, desc: "AI 技术应用逻辑清晰，能够针对跨境电商业务中的实际问题提出解决方案，具有较强可行性与推广价值。" },
    ],
  },
  {
    id: "result",
    title: "应用成效与优化思路",
    max: 20,
    accent: "green",
    items: [
      { id: "complete", title: "应用成果完整性", max: 10, desc: "能够较为完整地展示项目实施过程、AI 应用路径与成果内容，成果呈现较系统。" },
      { id: "analysis", title: "优化分析能力", max: 10, desc: "能够基于实践过程识别业务痛点，提出针对性的 AI 优化思路与改进方案，体现较好的总结、分析与提升能力。" },
    ],
  },
  {
    id: "roadshow",
    title: "路演展示表现",
    max: 15,
    accent: "amber",
    items: [
      { id: "logic", title: "路演逻辑与表达效果", max: 8, desc: "路演内容结构清晰、层次分明、表达准确，能够围绕实践、AI 工具应用过程及实战成效进行系统展示。" },
      { id: "materials", title: "展示材料与现场呈现", max: 7, desc: "PPT、视频或其他展示材料制作规范、内容清晰，现场展示流畅自然，时间把控合理。" },
    ],
  },
  {
    id: "report",
    title: "实践报告质量",
    max: 10,
    accent: "rose",
    items: [
      { id: "reportQuality", title: "《AI 跨境电商应用实践报告》质量", max: 10, desc: "报告内容完整，能够系统呈现项目背景、实施过程、AI 应用路径、成果展示与优化建议，逻辑清楚、分析扎实、格式规范。" },
    ],
  },
];

export const allItems = rubric.flatMap((dimension) => dimension.items.map((item) => ({ ...item, dimensionId: dimension.id })));
export const itemIds = allItems.map((item) => item.id);
export const itemMax = Object.fromEntries(allItems.map((item) => [item.id, item.max]));
export const itemTitles = Object.fromEntries(allItems.map((item) => [item.id, item.title]));

function clampInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.trunc(numeric) : fallback;
}

function boundedText(value, maxLength = 64) {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

export function createBlankScores() {
  return Object.fromEntries(itemIds.map((id) => [id, ""]));
}

export function createEntry() {
  return {
    scores: createBlankScores(),
    submitted: false,
    updatedAt: "",
    clientUpdatedAt: 0,
    serverRevision: 0,
    serverUpdatedAt: "",
  };
}

export function toScore(value, max) {
  if (value === "") return "";
  const numeric = Number(String(value).trim().replace(",", "."));
  if (!Number.isFinite(numeric)) return "";
  return Math.round(Math.min(max, Math.max(0, numeric)) * scoreScale) / scoreScale;
}

export function sanitizeEntry(savedEntry = {}) {
  const source = savedEntry && typeof savedEntry === "object" ? savedEntry : {};
  const scores = Object.fromEntries(itemIds.map((id) => [id, toScore(source.scores?.[id] ?? "", itemMax[id])]));
  return {
    scores,
    submitted: Boolean(source.submitted) && itemIds.every((id) => scores[id] !== ""),
    updatedAt: boundedText(source.updatedAt),
    clientUpdatedAt: clampInteger(source.clientUpdatedAt),
    serverRevision: clampInteger(source.serverRevision),
    serverUpdatedAt: boundedText(source.serverUpdatedAt),
  };
}

export function getScoresTotalCents(scores) {
  return itemIds.reduce((sum, itemId) => sum + Math.round(Number(scores?.[itemId] || 0) * scoreScale), 0);
}

export function getEntryTotalCents(entry) {
  return getScoresTotalCents(entry?.scores);
}

export function calculateCompositeCents(totalCents) {
  const ordered = Array.isArray(totalCents)
    ? totalCents.map((value) => Number(value)).filter(Number.isFinite).map(Math.round).sort((left, right) => left - right)
    : [];
  if (ordered.length < 3) return null;
  const counted = ordered.slice(1, -1);
  return {
    compositeCents: Math.round(counted.reduce((sum, value) => sum + value, 0) / counted.length),
    highCents: ordered.at(-1),
    lowCents: ordered[0],
  };
}

export function formatScore(value) {
  if (value === "" || value === undefined || value === null) return "--";
  return (Math.round(Number(value) * scoreScale) / scoreScale).toFixed(2);
}

export function formatCents(cents) {
  return (Number(cents) / scoreScale).toFixed(2);
}
