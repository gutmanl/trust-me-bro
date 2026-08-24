export {
  ActorId,
  BlobPath,
  ClaimId,
  EvidenceId,
  IsoDateTime,
  ProjectId,
  Sha256Hex,
  SourceId,
} from "./primitives";
export {
  CalibrationResult,
  ClaimStatus,
  ClaimType,
  ComplaintCategory,
  ExistenceCheckMatch,
  ExistenceCheckStatus,
  ProjectEventType,
  RelationType,
  RoutingReason,
  SourceType,
  SupportDegree,
  TriggerKind,
} from "./enums";
export {
  AutoCaptureProvenance,
  IdentifierVerification,
  Source,
  SourceCustom,
  SourceSnapshot,
} from "./source";
export { Evidence, ExistenceCheck, Judgment, Locator } from "./evidence";
export {
  CaptureFailure,
  ChainFields,
  Decision,
  HistoryEntry,
  ProjectEvent,
  Revision,
} from "./history";
// `CalibrationSnapshot` is public because the display tier reads it: the
// claim card's verdict-changed note projects over `previous_calibrations`
// and must name the archived triple's fields by type. 04-01 added the schema
// but not this line, so the type was unreachable from `@/lib/register`.
export { CalibrationSnapshot, Claim, Provenance } from "./claim";
export {
  BackendRef,
  BriefingImport,
  Project,
  ProjectConfig,
  ReferenceScanImport,
  SecondOpinionConfig,
} from "./project";
export { ClaimsRegister, SCHEMA_VERSION } from "./register";
export {
  buildEvidenceJsonSchema,
  buildJudgmentJsonSchema,
  buildRegisterJsonSchema,
  serializeJsonSchema,
} from "./json-schema";
