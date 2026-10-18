// Shared browser/MCP link; each download rechecks the current session and task.
export function attachmentZipPath(taskId:string) {
 return `/api/attachments/zip?taskId=${encodeURIComponent(taskId)}`;
}
