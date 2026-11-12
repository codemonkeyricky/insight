export {
  ROOT_SCOPE,
  ScopeError,
  findingInScope,
  fileResolver,
  inScope,
  normalizeScope,
  scopeOfNode,
  stubFor,
  type ScopeOptions,
  type ScopeStats,
  type ScopedDocument,
} from "./scope.js";
export { buildProjectModel, ROOT_DIR, type DirEntity, type FunctionEntity, type ProjectModel, type ProjectTree, type Rel, type RelKind } from "./model.js";
export { refsOf, type RefRow, type Refs } from "./refs.js";
export { scopeView, type ScopeKindName, type ScopeRel, type ScopeView } from "./view.js";
export { MODEL_SCHEMA, loadModel, serializeModel, type SerializedModel } from "./serialize.js";
export { systemModel, type Site, type SystemComponent, type SystemEdge, type SystemExternal, type SystemModel, type SystemOptions, type SystemRoute } from "./system.js";
export { SERVICES, classifyHost, type ServiceEntry } from "./services.js";
export { buildModuleGraph, type UnresolvedImport } from "./arch/module-graph.js";
export {
  archModel,
  defaultLayerOf,
  topDirLayerOf,
  DEFAULT_LAYERS,
  DEFAULT_LAYER_MATCH_MIN,
  type ArchModel,
  type ArchOptions,
  type ArchPackage,
  type ArchEdge,
  type ArchExternal,
  type ArchUnresolved,
  type ArchViolation,
  type ArchFile,
  type ArchFileImport,
} from "./arch/arch.js";
