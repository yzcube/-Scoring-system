import assert from "node:assert/strict";
import test from "node:test";
import { inflateRawSync } from "node:zlib";
import { getFinalResultExportData } from "./result-export-data.mjs";
import { buildFinalResultWorkbook, buildResultExportFilename } from "./result-export-xlsx.mjs";
import { itemIds, itemMax } from "../shared/scoringRules.js";

function scoresForTotal(total) {
  return Object.fromEntries(itemIds.map((itemId) => [itemId, itemMax[itemId] * total / 100]));
}

function readZipEntry(buffer, targetName) {
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressionMethod = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString("utf8");
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    if (name === targetName) {
      if (compressionMethod === 0) return compressed;
      if (compressionMethod === 8) return inflateRawSync(compressed);
      throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`);
    }
    offset = dataStart + compressedSize;
  }
  throw new Error(`ZIP entry not found: ${targetName}`);
}

function createState() {
  const accounts = Array.from({ length: 8 }, (_, index) => {
    const username = String(index + 1).padStart(3, "0");
    return { id: username, username, displayName: `评委 ${username}`, role: "judge", status: "active" };
  });
  const teams = [
    { id: "a", groupId: "gaozhi", status: "active", appearanceOrder: 2, registrationNumber: "A-02", teamName: "并列后出场", judgeRosterSnapshot: ["007", "001", "006", "002", "005", "003", "004"] },
    { id: "b", groupId: "gaozhi", status: "active", appearanceOrder: 1, registrationNumber: "A-01", teamName: "并列先出场", judgeRosterSnapshot: ["004", "003", "002", "001", "007", "006", "005"] },
    { id: "c", groupId: "gaozhi", status: "active", appearanceOrder: 3, registrationNumber: "A-03", teamName: "暂算高分", judgeRosterSnapshot: ["001", "002", "003", "004", "005", "006", "007"] },
    { id: "d", groupId: "gaozhi", status: "active", appearanceOrder: 4, registrationNumber: "A-04", teamName: "八评委队伍", judgeRosterSnapshot: ["008", "007", "006", "005", "004", "003", "002", "001"] },
  ];
  const entriesByJudge = Object.fromEntries(accounts.map((account) => [account.id, {}]));
  const tieTotals = [88, 89, 90, 91, 92, 93, 94];
  for (const teamId of ["a", "b"]) {
    tieTotals.forEach((total, index) => {
      entriesByJudge[String(index + 1).padStart(3, "0")][teamId] = { submitted: true, scores: scoresForTotal(total) };
    });
  }
  tieTotals.forEach((_, index) => {
    if (index === 6) return;
    entriesByJudge[String(index + 1).padStart(3, "0")].c = { submitted: true, scores: scoresForTotal(99 - index / 10) };
  });
  Array.from({ length: 8 }, (_, index) => 78 + index).forEach((total, index) => {
    entriesByJudge[String(index + 1).padStart(3, "0")].d = { submitted: true, scores: scoresForTotal(total) };
  });
  return {
    accounts,
    teams,
    entriesByJudge,
    judgeRoster: { judgeIds: accounts.map((account) => account.id) },
    competitionSetup: { groups: { gaozhi: { teamIds: teams.map((team) => team.id) } } },
  };
}

test("final result export filters temporary scores, preserves tie ranks, and orders judge columns by account", () => {
  const exportData = getFinalResultExportData(createState(), "gaozhi");
  assert.deepEqual(exportData.rows.map((row) => row.registrationNumber), ["A-01", "A-02", "A-04"]);
  assert.deepEqual(exportData.rows.map((row) => row.rank), [1, 1, 3]);
  assert.deepEqual(exportData.rows.map((row) => row.finalScore), [91, 91, 81.5]);
  assert.deepEqual(exportData.rows[0].judgeScores, [88, 89, 90, 91, 92, 93, 94]);
  assert.equal(exportData.judgeColumnCount, 8);
});

test("final result workbook is a real xlsx zip and uses a safe timestamped filename", () => {
  const exportData = getFinalResultExportData(createState(), "gaozhi");
  const createdAt = new Date("2026-07-18T12:34:00Z");
  const workbook = buildFinalResultWorkbook(exportData, { createdAt });
  assert.equal(workbook.subarray(0, 2).toString("ascii"), "PK");
  assert.equal(workbook.subarray(-22, -18).readUInt32LE(0), 0x06054b50);
  const worksheet = readZipEntry(workbook, "xl/worksheets/sheet1.xml").toString("utf8");
  assert.match(worksheet, /<c r="D4"[^>]*><is><t xml:space="preserve">评委1分数<\/t><\/is><\/c>/);
  assert.match(worksheet, /<c r="D5" s="5"><v>88<\/v><\/c>/);
  assert.match(worksheet, /<c r="L4"[^>]*><is><t xml:space="preserve">最终得分<\/t><\/is><\/c>/);
  assert.match(worksheet, /<c r="L5" s="5"><v>91<\/v><\/c>/);
  assert.equal(buildResultExportFilename("高职组", createdAt), "高职组-成绩排名-20260718-2034.xlsx");
});
