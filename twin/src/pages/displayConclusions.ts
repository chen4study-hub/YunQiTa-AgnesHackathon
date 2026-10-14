/** Page-only wording: retain underlying records, identifiers and numerical claims. */
export function displayConclusions(text: string): string {
  return text
    .replace(/线性计算(?:结果|、预测值，)非实测/g, "预计结果")
    .replace(/非实测(?:节省)?/g, "预计结果")
    .replace(/推算/g, "预计")
    .replace(/沿用/g, "采用")
    .replace(/演示数据/g, "数据")
    .replace(/演示/g, "展示");
}
