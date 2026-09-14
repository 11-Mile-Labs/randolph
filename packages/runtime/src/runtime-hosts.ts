import type { RecoveryHost } from './checkpoint-recovery.js';
import type { DispatchHost } from './run-dispatch.js';
import type { ProjectSetupHost } from './project-setup-runtime.js';
import type { RuntimeBindings } from './runtime-bindings.js';

export function recoveryHost(runtime: RuntimeBindings): RecoveryHost {
  return {
    isAccepting: () => runtime.accepting,
    store: runtime.store,
    checkpoints: runtime.checkpoints,
    memory: runtime.memory,
    reviews: runtime.reviews,
    pushes: runtime.pushes,
    integrations: runtime.integrations,
    executionOrigin: runtime.executionOrigin,
    admission: runtime.admission,
    active: runtime.active,
    conversation: id => runtime.conversation(id),
    project: id => runtime.project(id),
    inspectExecutable: (harness, executable) => runtime.inspectExecutable(harness, executable),
    validateSelection: (selection, info) => runtime.validateSelection(selection, info),
    validateExecutionMode: (mode, info) => runtime.validateExecutionMode(mode, info),
    preparation: () => runtime.workspaces.preparation(),
    planWorkspace: (root, provenance, plan, held, readOnlyPlanning) => runtime.planWorkspace(root, provenance, plan, held, readOnlyPlanning),
    transferWorkspace: (plan, held) => runtime.workspaces.transfer(plan, held),
    releaseWorkspaces: (held, failure) => runtime.workspaces.release(held, failure),
    observeExecution: (run, work) => runtime.workspaces.observe(run, work),
    execute: (run, controller, lease) => runtime.execute(run, controller, lease),
    finish: (run, status, error) => runtime.finish(run, status, error),
    changed: () => runtime.changed(),
  };
}

export function dispatchHost(runtime: RuntimeBindings): DispatchHost {
  return {
    isAccepting: () => runtime.accepting,
    store: runtime.store,
    workspaces: runtime.workspaces,
    ownership: runtime.workspaceOwnership,
    harness: runtime.routes,
    memory: runtime.memory,
    checkpoints: runtime.checkpoints,
    reviews: runtime.reviews,
    pushes: runtime.pushes,
    integrations: runtime.integrations,
    executionOrigin: runtime.executionOrigin,
    admission: runtime.admission,
    active: runtime.active,
    conversation: id => runtime.conversation(id),
    project: id => runtime.project(id),
    planWorkspace: (root, provenance, plan, held, readOnlyPlanning) => runtime.planWorkspace(root, provenance, plan, held, readOnlyPlanning),
    execute: (run, controller, lease) => runtime.execute(run, controller, lease),
    finish: (run, status, error) => runtime.finish(run, status, error),
    changed: () => runtime.changed(),
  };
}

export function setupHost(runtime: RuntimeBindings): ProjectSetupHost {
  return {
    isAccepting: () => runtime.accepting,
    store: runtime.store,
    workspaces: runtime.workspaces,
    ownership: runtime.workspaceOwnership,
    delegation: runtime.delegation,
    nativeAdmission: runtime.nativeAdmission,
    executionOrigin: runtime.executionOrigin,
    admission: runtime.admission,
    setupAdmission: runtime.setupAdmission,
    active: runtime.active,
    project: id => runtime.project(id),
    createConversation: projectId => runtime.createConversation(projectId),
    send: (input, setup) => runtime.prepareSend(input, setup),
    changed: () => runtime.changed(),
  };
}
