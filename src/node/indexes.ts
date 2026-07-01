// Node 端索引:从磁盘读 data/*.json,用 nodejs-jieba 分词,复用 indexes-core 的 buildIndexes。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildIndexes } from "../indexes-core";
import type { Indexes, BuildInfo } from "../indexes-core";
import { tokenizeSync } from "./tokenize";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
const readJson = (name: string) => JSON.parse(readFileSync(join(DATA, name), "utf8"));

const metadataRaw = readJson("metadata.json");
const knowledgeRaw = readJson("knowledge.json");
export const buildInfo: BuildInfo = readJson("build-info.json");

let built: Promise<Indexes> | null = null;
/** 懒建索引(isolate 内只建一次)。nodejs-jieba 同步,无需 initJieba。 */
export function getIndexes(): Promise<Indexes> {
  if (!built) built = Promise.resolve(buildIndexes(metadataRaw, knowledgeRaw, tokenizeSync));
  return built;
}
