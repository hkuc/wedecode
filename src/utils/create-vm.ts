import { VM, VMOptions } from "vm2";
import { JSDOM } from "jsdom";
import { deepmerge } from "@biggerstar/deepmerge";
import { createWxFakeDom } from "@/utils/wx-dom";

export function createVM(vmOptions: VMOptions = {}) {
  const domBaseHtml = `<!DOCTYPE html><html lang="en"><head><title>''</title></head><body></body></html>`
  const dom = new JSDOM(domBaseHtml);
  const vm_window = dom.window
  const vm_navigator = dom.window.navigator
  const vm_document = dom.window.document
  const __wxAppCode__ = {}
  const glassEaselTemplates: Record<string, any> = {}
  const glassEaselStaticConfigs: Record<string, any> = {}
  const fakeGlobal = {
    __wxAppCode__,
    publishDomainComponents: () => void 0,
  }
  Object.assign(vm_window, fakeGlobal)
  return new VM(deepmerge({
    sandbox: {
      ...createWxFakeDom(),
      setInterval: () => null,
      setTimeout: () => null,
      console: {
        ...console,  // 在 vm 执行的时候，对于小程序源码中的 info, log, warn 打印直接忽略
        log: ()=> void 0,
        warn: ()=> void 0,
        info: ()=> void 0,
      },
      window: vm_window,
      location: dom.window.location,
      navigator: vm_navigator,
      document: vm_document,
      define: () => void 0,
      require: () => void 0,
      requirePlugin: () => void 0,
      global: {
        __wcc_version__: 'v0.5vv_20211229_syb_scopedata',
      },
      System: {
        register: () => void 0,
      },
      setCssToHead: () => void 0,
      __vd_version_info__: {},
      __wxAppCode__,
      __wxConfig: {},
      __glassEaselTemplates__: glassEaselTemplates,
      __glassEaselStaticConfigs__: glassEaselStaticConfigs,
      __wxCodeSpace__: {
        setRuntimeGlobals: () => void 0,
        addComponentStaticConfig: (p: string, cfg: any) => {
          let jsonPath = p.startsWith('/') ? p.slice(1) : p;
          glassEaselStaticConfigs[jsonPath] = cfg;
          if (!jsonPath.endsWith('.json')) jsonPath += '.json';
          __wxAppCode__[jsonPath] = cfg;
        },
        setStyleScope: () => void 0,
        enableCodeChunk: () => void 0,
        initializeCodeChunk: () => void 0,
        addTemplateDependencies: () => void 0,
        batchAddCompiledScripts: () => void 0,
        batchAddCompiledTemplate: (factory: any) => {
          try {
            if (typeof factory === 'function') {
              const tpls = factory({}, {}, {}, {}, {}, (x: any) => x, (x: any) => x, {}, {});
              if (tpls && typeof tpls === 'object') {
                Object.assign(glassEaselTemplates, tpls);
              }
            }
          } catch (e) {}
        },
      },
    }
  }, vmOptions));
}

export function runVmCode(vm: VM, code: string) {
  try {
    vm.run(code)
  } catch (e) {
    console.error(e.message)
  }
}
