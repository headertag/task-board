// Stable navigation only: a task URL never grants board access.
export function validTaskId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
export function taskPath(id: string): string {
  if (!validTaskId(id)) throw new Error('Invalid task link');
  return '/?task=' + encodeURIComponent(id);
}
export function taskLinkSelection(search: string): {id: string|null; invalid: boolean} {
  const values = new URLSearchParams(search).getAll('task');
  if (!values.length) return {id:null, invalid:false};
  return values.length === 1 && validTaskId(values[0]) ? {id:values[0], invalid:false} : {id:null, invalid:true};
}
