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
export { systemModel, type Site, type SystemComponent, type SystemEdge, type SystemExternal, type SystemModel, type SystemRoute } from "./system.js";
export { SERVICES, classifyHost, type ServiceEntry } from "./services.js";
