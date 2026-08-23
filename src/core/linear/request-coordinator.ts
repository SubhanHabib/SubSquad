// The discipline lives in `src/core/issues/request-coordinator.ts` — it is provider-neutral, and
// keeping a second copy here is exactly the drift CLAUDE.md warns about. Re-exported under Linear
// names so this provider's call sites read like GitHub's.
export {
  IssueRequestCoordinator as LinearRequestCoordinator,
  IssueCoordinatorError as LinearCoordinatorError
} from '../issues/request-coordinator'
