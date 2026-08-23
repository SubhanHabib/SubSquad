// Moved to `src/core/issues/request-coordinator.ts` — the discipline is provider-neutral and
// Linear needs the same one. Re-exported under the historical names so every GitHub call site and
// test is unchanged.
export {
  IssueRequestCoordinator as GitHubRequestCoordinator,
  IssueCoordinatorError as GitHubCoordinatorError
} from '../issues/request-coordinator'
