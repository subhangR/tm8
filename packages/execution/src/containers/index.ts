// @tm8/execution — the container block (TM8-CONTAINERS-DESIGN §5, §8.4, §11).
export { ContainerError, CONTAINER_ERROR_TAXONOMY, isContainerError } from './errors.js';
export { ContainerService } from './ContainerService.js';
export type {
  ContainerServiceConfig, ContainerServiceDeps, CreateContainerRequest,
  LifecycleRequest, ReconcileReport, ReconcileRepair,
} from './ContainerService.js';
export { ProviderRegistry, type ProviderSelection } from './ProviderRegistry.js';
export { requiredIsolation, type IsolationDecision, type IsolationPolicyInput } from './policy.js';
export { provisionContainer, type ProvisionInput, type ProvisionResult, type SagaDeps } from './saga.js';
export {
  TM8_CONTAINER_LABEL, TM8_NODE_LABEL, TM8_SPACE_LABEL,
  type ContainerProvider, type ExecLaunch, type ExecRequest, type ProviderCtx,
  type RuntimeHandle, type RuntimeInspection, type RuntimeListing, type RuntimeStatus,
  type SurfaceEndpoint,
} from './provider.js';
export { FakeProvider, FAKE_PROVIDER_DESCRIPTOR, type FakeProviderOptions } from './providers/FakeProvider.js';
export type {
  ContainerGraphAuth, ContainerGraphPort, ContainerRecord,
  CreateContainerEntityInput, CreateContainerEntityResult,
  NodeContainerRow, SetContainerStatusInput, SweepRow, UpdateContainerInput,
} from './types.js';
