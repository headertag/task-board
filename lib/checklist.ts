import { z } from 'zod';
import { checklistSchema, type Task } from './model';
import { AppError } from './errors';

export const checklistEdit = z.object({
  id: z.string().uuid(), expectedRevision: z.number().int().positive(),
  requestKey: z.string().min(8).max(100),
  action: z.enum(['add', 'update', 'remove', 'move']),
  itemId: z.string().uuid(), text: z.string().trim().min(1).max(500).optional(),
  checked: z.boolean().optional(), position: z.number().int().min(0).max(99).optional(),
}).strict().superRefine((v, ctx) => {
  const bad = (message: string) => ctx.addIssue({code: z.ZodIssueCode.custom, message});
  if (v.action === 'add' && v.text === undefined) bad('Add requires text');
  if (v.action === 'update' && v.text === undefined && v.checked === undefined) bad('Update requires text or checked');
  if (v.action === 'move' && v.position === undefined) bad('Move requires position');
  if (['remove', 'move'].includes(v.action) && (v.text !== undefined || v.checked !== undefined)) bad('Text and checked are only for add/update');
  if (['remove', 'update'].includes(v.action) && v.position !== undefined) bad('Position is only for add/move');
});
export function editChecklist(task: Task, raw: unknown) {
  const args = checklistEdit.parse(raw);
  if (task.archived) throw new AppError(400, 'archived_task', 'Restore this task before editing its checklist');
  const items = (task.checklist ?? []).map(item => ({...item}));
  const index = items.findIndex(item => item.id.toLowerCase() === args.itemId.toLowerCase());
  if (args.action === 'add') {
    if (index !== -1) throw new AppError(409, 'duplicate_item', 'That checklist item ID already exists');
    const position = args.position ?? items.length;
    if (position > items.length) throw new AppError(400, 'invalid_position', 'Position exceeds checklist length');
    items.splice(position, 0, {id: args.itemId, text: args.text!, checked: args.checked ?? false});
  } else {
    if (index === -1) throw new AppError(404, 'item_not_found', 'Checklist item not found');
    if (args.action === 'remove') items.splice(index, 1);
    else if (args.action === 'move') {
      if (args.position! >= items.length) throw new AppError(400, 'invalid_position', 'Position exceeds checklist length');
      const [item] = items.splice(index, 1); items.splice(args.position!, 0, item);
    } else items[index] = {...items[index], ...(args.text === undefined ? {} : {text: args.text}), ...(args.checked === undefined ? {} : {checked: args.checked})};
  }
  return checklistSchema.parse(items);
}
