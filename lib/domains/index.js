import academic from "./academic.js";
import english from "./english.js";
import path from "node:path";
import { openStore, DATA_DIR } from "../store.js";
import { openDict } from "../dict.js";

export const DOMAINS = { academic, english };

export function getDomain(id) {
  const d = DOMAINS[id];
  if (!d) throw new Error(`未知领域：${id}，可选：${Object.keys(DOMAINS).join(", ")}`);
  return d;
}

export const storeFor = (domain) => openStore(domain.id, { defaultTags: domain.defaultTags });

const dicts = new Map();
// 词典仅英语领域使用，保存在 data/english/ecdict.db
export function dictFor(domain) {
  if (!domain.hasDictionary) throw new Error(`${domain.name}领域没有词典`);
  if (!dicts.has(domain.id)) dicts.set(domain.id, openDict(path.join(DATA_DIR, domain.id)));
  return dicts.get(domain.id);
}
