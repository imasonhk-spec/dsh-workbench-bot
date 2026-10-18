// Plans consume frozen inputs; all professional operations share the executor's recovery contract.
export function buildPptSteps(coordinator, run, source) {
  const steps = []
  const add = (operation, input, dependsOn) => {
    const step = coordinator.createStep({ runId: run.id, operation, adapterId: operation.split('.')[0], input, dependsOn: dependsOn || (steps.length ? [steps.at(-1).id] : source?.$ref ? [source.$ref.split('.')[0]] : []) })
    steps.push(step); return step
  }
  const ref = (step, field) => ({ $ref: `${step.id}.${field}` })
  const project = run.projectId ? null : add('ppt.create_project', { title: run.taskSpec.title || '协作任务汇报' })
  const projectId = project ? ref(project, 'projectId') : run.projectId
  add('ppt.configure', { projectId, title: run.taskSpec.title || '协作任务汇报', pageCount: run.taskSpec.pageCount, notes: run.taskSpec.goal })
  add('ppt.add_material', { projectId, text: source, filename: `sources-${run.planRevision}.txt` })
  add('ppt.generate_outline', { projectId, modelId: run.taskSpec.pptModelId })
  add('ppt.select_style', { projectId, family: run.taskSpec.family || 'green-clean-business', count: run.taskSpec.pageCount })
  const sample = add('ppt.generate', { projectId, phase: 'sample' })
  add('business.review_samples', { projectId, version: ref(sample, 'version'), sha256: ref(sample, 'sha256') })
  add('ppt.confirm_samples', { projectId, version: ref(sample, 'version'), sha256: ref(sample, 'sha256'), note: { $ref: `${steps.at(-1).id}.answer` } })
  add('ppt.generate', { projectId, phase: 'final' })
  add('ppt.export', { projectId })
  return steps
}

export function buildPptEditSteps(coordinator, run, after) {
  const add = (operation, input, dependsOn) => coordinator.createStep({ runId: run.id, operation, adapterId: operation.split('.')[0], input, dependsOn })
  const projectId = run.projectId
  const edit = add('ppt.revise', { projectId, version: run.pptHeadVersion, sha256: run.pptHeadSha256, instruction: run.taskSpec.goal, modelId: run.taskSpec.pptModelId }, after ? [after] : [])
  const sample = { projectId, version: { $ref: `${edit.id}.version` }, sha256: { $ref: `${edit.id}.sha256` } }
  const review = add('business.review_samples', sample, [edit.id])
  const confirm = add('ppt.confirm_samples', { ...sample, note: { $ref: `${review.id}.answer` } }, [review.id])
  const final = add('ppt.generate', { projectId, phase: 'final' }, [confirm.id])
  add('ppt.export', { projectId }, [final.id])
}
