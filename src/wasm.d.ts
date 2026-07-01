// Cloudflare Workers 把 .wasm 作为模块导入 → WebAssembly.Module。
declare module "*.wasm" {
  const mod: WebAssembly.Module;
  export default mod;
}
