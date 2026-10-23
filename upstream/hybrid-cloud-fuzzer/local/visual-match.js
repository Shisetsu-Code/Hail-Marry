// Detached canvases compare our JPEGs; the provider document stays unchanged.
export async function matchReviewedImage(page,reference,current,point){
 if(!reference?.length||!current?.length||reference.length>8*1024*1024||current.length>8*1024*1024)throw Error('invalid visual reference image');
 if(!Number.isFinite(point?.x)||!Number.isFinite(point?.y)||point.x<0||point.x>1||point.y<0||point.y>1)throw Error('invalid visual reference point');
 return page.evaluate(async({before,after,point})=>{
  const load=async encoded=>createImageBitmap(new Blob([Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))],{type:'image/jpeg'}));
  const [a,b]=await Promise.all([load(before),load(after)]);
  try{
   if(Math.abs(a.width/a.height-b.width/b.height)>.01)return {matched:false,reason:'viewport-changed'};
   const pixels=(bitmap,target)=>{
    const canvas=document.createElement('canvas');canvas.width=64;canvas.height=36;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    if(target){const x=Math.max(0,Math.min(.84,point.x-.08)),y=Math.max(0,Math.min(.84,point.y-.08));ctx.drawImage(bitmap,x*bitmap.width,y*bitmap.height,.16*bitmap.width,.16*bitmap.height,0,0,64,36);}
    else ctx.drawImage(bitmap,0,0,64,36);
    return ctx.getImageData(0,0,64,36).data;
   };
   const compare=(x,y)=>{
    let sum=0,changed=0,variance=0,mean=0,n=0;
    for(let i=0;i<x.length;i++)if(i%4!==3){mean+=x[i];n++;}
    mean/=n;
    for(let i=0;i<x.length;i++)if(i%4!==3){const d=Math.abs(x[i]-y[i])/255;sum+=d;changed+=d>.12;variance+=(x[i]-mean)**2/65025;}
    return {distance:sum/n,changed:changed/n,variance:variance/n};
   };
   const scene=compare(pixels(a,false),pixels(b,false)),target=compare(pixels(a,true),pixels(b,true));
   const matched=scene.variance>.002&&target.variance>.001&&scene.distance<.06&&scene.changed<.18&&target.distance<.035&&target.changed<.12;
   return {matched,reason:matched?'reviewed-image-match':'screen-changed',sceneDistance:scene.distance,targetDistance:target.distance};
  }finally{a.close();b.close();}
 },{before:Buffer.from(reference).toString('base64'),after:Buffer.from(current).toString('base64'),point});
}
