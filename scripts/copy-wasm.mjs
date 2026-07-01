// 把 jieba-wasm 的 web 版 .wasm 拷进 src/,供 Worker 打包(包的 exports 挡了直接 subpath 导入)。
// postinstall / predev / predeploy 自动跑,保证 src/jieba_rs_wasm_bg.wasm 存在且最新。
import { copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(ROOT, "node_modules/jieba-wasm/pkg/web/jieba_rs_wasm_bg.wasm");
const dst = join(ROOT, "src/jieba_rs_wasm_bg.wasm");
if (existsSync(src)) {
  copyFileSync(src, dst);
  console.log("copy-wasm: ok →", "src/jieba_rs_wasm_bg.wasm");
} else {
  console.warn("copy-wasm: 找不到", src, "(先 npm install)");
}
