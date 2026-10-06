// tsx ESM loader 垫片：把 SvelteKit 虚拟模块 $app/environment 指到浏览器态
// 用法：node --import tsx --loader ./scripts/app-shim-loader.mjs <test-file>
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '$app/environment') {
    return { url: 'virtual:$app/environment', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === 'virtual:$app/environment') {
    return {
      format: 'module',
      shortCircuit: true,
      source:
        'export const browser = true; export const dev = false; export const building = false; export const version = "test";'
    };
  }
  return nextLoad(url, context);
}
