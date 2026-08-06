export {
  ROLES,
  CAPABILITIES,
  capabilitiesFor,
  roleHas,
  isRole,
  seesAllProjects,
  isExternal,
  canGrantRole,
  type Role,
  type Capability,
} from "./rbac.js";

export {
  hasCapability,
  isExternalContext,
  hasEmptyScope,
  type RequestContext,
  type PrincipalInput,
} from "./context.js";

/**
 * Deliberately renamed on export.
 *
 * Constructing a context bypasses authentication by definition, so the call
 * site should read as the exception it is. The auth plugin and tests use it;
 * nothing else should, and a reviewer seeing this identifier anywhere else
 * knows to ask why.
 */
export { createRequestContext as __unsafeCreateRequestContext } from "./context.js";

export { uuidv7, isUuid, uuidv7Timestamp } from "./ids.js";
