import {taskLinkSelection, taskPath} from '../lib/task-links';

// Keep the board mounted (filters/scroll stay intact). Index our history entries
// so rejected Back/Forward restores the original entry, without pushing duplicates.
export function taskNavigation(win: Window, canLeave: ()=>boolean, select: (id:string|null, invalid:boolean)=>void) {
  let index = Number.isInteger(win.history.state?.taskBoardIndex) ? win.history.state.taskBoardIndex : 0;
  let restoring = false;
  const initial = taskLinkSelection(win.location.search);
  win.history.replaceState({...win.history.state, taskBoardIndex:index}, '', win.location.href);
  select(initial.id, initial.invalid);
  const pop = (event: PopStateEvent) => {
    const target = event.state?.taskBoardIndex;
    if (restoring) {
      if (Number.isInteger(target) && target!==index) win.history.go(index-target);
      else restoring=false;
      return;
    }
    if (!Number.isInteger(target)) return; // Other documents use beforeunload.
    if (!canLeave()) {
      restoring=true;
      win.history.go(index-target);
      return;
    }
    index=target;
    const next=taskLinkSelection(win.location.search);
    select(next.id,next.invalid);
  };
  win.addEventListener('popstate',pop);
  return {
    navigate(id:string|null, replace=false) {
      if (restoring) return false;
      const path=id?taskPath(id):'/';
      if (win.location.pathname+win.location.search+win.location.hash !== path) {
        if (!replace) index++;
        win.history[replace?'replaceState':'pushState']({...win.history.state,taskBoardIndex:index},'',path);
      }
      return true;
    },
    dispose() {win.removeEventListener('popstate',pop);},
  };
}
