#!/usr/bin/env node
// 导入 ECDICT 到 data/english/ecdict.db。参数为本地 ecdict.csv 路径；省略时从 GitHub 下载（约 66MB）。
//   node scripts/import-ecdict.js [ecdict.csv]
import "../lib/env.js";
import { DOMAINS, dictFor } from "../lib/domains/index.js";

const dict = dictFor(DOMAINS.english);
const timer = setInterval(() => process.stderr.write(`\r${dict.status().importing?.stage ?? ""} ${dict.status().importing?.rows ?? 0} 条`), 1000);
try {
  const s = await dict.importEcdict(process.argv[2]);
  process.stderr.write("\n");
  console.log(`已导入 ${s.entries} 条；词表：${s.lists.map((l) => `${l.label} ${l.count}`).join("，")}`);
} finally {
  clearInterval(timer);
}
