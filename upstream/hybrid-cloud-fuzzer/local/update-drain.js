// Shared cooperative shutdown marker used by the Windows auto-updater.
// Workers finish their current task before exiting, preserving journals and leases.
import fs from 'node:fs/promises';
import path from 'node:path';

export function updateDrainPath(root=process.cwd()){
 return path.resolve(root,'.local-state','update-drain.flag');
}

export async function updateDrainRequested(root=process.cwd()){
 try{await fs.access(updateDrainPath(root));return true;}
 catch(e){if(e?.code==='ENOENT')return false;throw e;}
}
