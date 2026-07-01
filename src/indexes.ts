// Worker 端索引:JSON 模块导入 + jieba-wasm 分词,复用 indexes-core 的 buildIndexes。
import metadataRaw from "../data/metadata.json";
import knowledgeRaw from "../data/knowledge.json";
import buildInfoRaw from "../data/build-info.json";
import { initJieba, tokenizeSync } from "./tokenize";
import { buildIndexes } from "./indexes-core";
import type { Indexes, BuildInfo } from "./indexes-core";

// 类型统一从 core 出口,保持既有 `from "./indexes"` 的 import 不破。
export * from "./indexes-core";

export const buildInfo: BuildInfo = buildInfoRaw as BuildInfo;

let built: Promise<Indexes> | null = null;
/** 懒建索引(isolate 内只建一次)。minisearch tokenize 同步,必须先 await initJieba。 */
export function getIndexes(): Promise<Indexes> {
  if (!built) {
    built = (async () => {
      await initJieba();
      return buildIndexes(metadataRaw, knowledgeRaw, tokenizeSync);
    })();
  }
  return built;
}
