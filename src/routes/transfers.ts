import type {FastifyInstance,FastifyReply,FastifyRequest} from "fastify";
import {randomUUID,createHash} from "node:crypto";
import {Transform,Readable} from "node:stream";
import path from "node:path";
import fs from "node:fs";
import {mkdir,unlink} from "node:fs/promises";
import {pipeline} from "node:stream/promises";
import {query} from "../db.js";
import {config} from "../config.js";
import type {TransferRow} from "../types.js";
import {SESSION_COOKIE_NAME,getAuthenticatedUser} from "../auth.js";

type ChunkRow = {chunk_index:number;chunk_size:number;sha256:string;storage_path:string};
type ChunkTransferRow = TransferRow & {chunk_size:number|null;chunk_count:number|null};
type ReceivedTransferRow = TransferRow & {
 sender_display_name:string;
 sender_username:string|null;
 sender_email:string;
};

function publicTransfer(row:TransferRow){
 return {
  id:row.id,filename:row.filename,filesize:Number(row.filesize),status:row.status,
  createdAt:row.created_at,uploadedAt:row.uploaded_at,expiresAt:row.expires_at,
  downloadUrl:row.status==="completed"?config.publicBaseUrl+"/transfers/"+row.id+"/download":null,
  shareUrl:row.share_token?config.publicBaseUrl+"/share/"+row.share_token:null,
  sha256:row.sha256
 };
}

async function requireUser(request:FastifyRequest,reply:FastifyReply){
 const user=await getAuthenticatedUser(request.cookies?.[SESSION_COOKIE_NAME]);
 if(!user){reply.code(401).send({error:"Please log in to access this transfer."});return null;}
 return user;
}

async function ownedTransfer(id:string,userId:string){
 const r=await query<TransferRow>("SELECT * FROM transfers WHERE id=$1 AND user_id=$2",[id,userId]);
 return r.rows[0];
}

async function accessibleTransfer(id:string,userId:string){
 const r=await query<TransferRow>(
  "SELECT * FROM transfers WHERE id=$1 AND (user_id=$2 OR recipient_user_id=$2)",
  [id,userId]
 );
 return r.rows[0];
}

function safeName(name:string){return name.replace(/[\r\n"\\]/g,"_").slice(0,255);}

async function hashFile(filePath:string):Promise<string>{
 const hash=createHash("sha256");
 for await(const chunk of fs.createReadStream(filePath))hash.update(chunk);
 return hash.digest("hex");
}

async function verifyStoredChunk(chunk:ChunkRow):Promise<boolean>{
 if(!fs.existsSync(chunk.storage_path))return false;
 const hash=createHash("sha256");
 let size=0;
 try{
  for await(const data of fs.createReadStream(chunk.storage_path)){
   const buffer=Buffer.isBuffer(data)?data:Buffer.from(data);
   size+=buffer.length;hash.update(buffer);
  }
  return size===Number(chunk.chunk_size)&&hash.digest("hex")===chunk.sha256;
 }catch{return false;}
}

async function sendFile(reply:FastifyReply,row:TransferRow){
 if(row.status!=="completed"||!row.storage_path)return reply.code(410).send({error:"This file is no longer available."});
 if(row.expires_at&&new Date(row.expires_at)<new Date())return reply.code(410).send({error:"This file has expired."});
 if(!fs.existsSync(row.storage_path))return reply.code(404).send({error:"The stored file is missing from the server."});
 reply.header("Content-Type",row.mime_type??"application/octet-stream");
 reply.header("Content-Disposition",'attachment; filename="'+safeName(row.filename)+'"');
 reply.header("Content-Length",String(row.filesize));
 return reply.send(fs.createReadStream(row.storage_path));
}

export async function transferRoutes(app:FastifyInstance):Promise<void>{
 const MAX_CHUNK_BYTES=8*1024*1024;
 const MIN_CHUNK_BYTES=256*1024;

 // Start (or re-open) a chunked upload. The transfer itself is created by POST /transfers.
 app.post<{Params:{id:string};Body:{chunkSize?:number;chunkCount?:number;mimeType?:string}}>("/transfers/:id/chunks/start",async(request,reply)=>{
  const user=await requireUser(request,reply);if(!user)return;
  const transfer=await ownedTransfer(request.params.id,user.id) as ChunkTransferRow|undefined;
  if(!transfer)return reply.code(404).send({error:"Transfer not found."});
  if(transfer.status!=="pending")return reply.code(409).send({error:"This transfer is no longer pending."});
  if(transfer.expires_at&&new Date(transfer.expires_at)<new Date())return reply.code(410).send({error:"This transfer has expired."});
  const chunkSize=request.body?.chunkSize;
  const chunkCount=request.body?.chunkCount;
  const mimeType=typeof request.body?.mimeType==="string"?request.body.mimeType.slice(0,150):"application/octet-stream";
  if(!Number.isSafeInteger(chunkSize)||!Number.isSafeInteger(chunkCount)||chunkSize!<MIN_CHUNK_BYTES||chunkSize!>MAX_CHUNK_BYTES||chunkCount!<1){
   return reply.code(400).send({error:"Invalid chunk size or count."});
  }
  const expectedCount=Math.max(1,Math.ceil(Number(transfer.filesize)/chunkSize!));
  if(chunkCount!==expectedCount)return reply.code(400).send({error:"Chunk count does not match the declared file size."});
  if(transfer.chunk_size!==null&&transfer.chunk_size!==undefined&&(transfer.chunk_size!==chunkSize||transfer.chunk_count!==chunkCount)){
   return reply.code(409).send({error:"This upload was already started with different chunk settings."});
  }
  const updated=await query(
   "UPDATE transfers SET chunk_size=$3,chunk_count=$4,mime_type=$5 WHERE id=$1 AND user_id=$2 AND status='pending' RETURNING id,chunk_size,chunk_count",
   [transfer.id,user.id,chunkSize,chunkCount,mimeType]
  );
  if(!updated.rows[0])return reply.code(409).send({error:"Could not initialize this upload."});
  const received=await query<{chunk_index:number;chunk_size:number;sha256:string;storage_path:string}>(
   "SELECT chunk_index,chunk_size,sha256,storage_path FROM transfer_chunks WHERE transfer_id=$1 ORDER BY chunk_index",
   [transfer.id]
  );
  const validReceived=[] as typeof received.rows;
  for(const chunk of received.rows){
   if(fs.existsSync(chunk.storage_path))validReceived.push(chunk);
   else await query("DELETE FROM transfer_chunks WHERE transfer_id=$1 AND chunk_index=$2",[transfer.id,chunk.chunk_index]);
  }
  return {
   transferId:transfer.id,chunkSize,chunkCount,
   receivedChunks:validReceived.map(({chunk_index,chunk_size,sha256})=>({chunk_index,chunk_size,sha256})),
   receivedBytes:validReceived.reduce((total,row)=>total+Number(row.chunk_size),0)
  };
 });

 // Report received chunks so the browser can resume without re-uploading them.
 app.get<{Params:{id:string}}>("/transfers/:id/chunks",async(request,reply)=>{
  const user=await requireUser(request,reply);if(!user)return;
  const transfer=await ownedTransfer(request.params.id,user.id) as ChunkTransferRow|undefined;
  if(!transfer)return reply.code(404).send({error:"Transfer not found."});
  if(!transfer.chunk_size||!transfer.chunk_count)return reply.code(409).send({error:"Chunked upload has not been initialized."});
  const received=await query<{chunk_index:number;chunk_size:number;sha256:string;storage_path:string}>(
   "SELECT chunk_index,chunk_size,sha256,storage_path FROM transfer_chunks WHERE transfer_id=$1 ORDER BY chunk_index",
   [transfer.id]
  );
  const validReceived=[] as typeof received.rows;
  for(const chunk of received.rows){if(await verifyStoredChunk(chunk))validReceived.push(chunk);else{await unlink(chunk.storage_path).catch(()=>undefined);await query("DELETE FROM transfer_chunks WHERE transfer_id=$1 AND chunk_index=$2",[transfer.id,chunk.chunk_index]);}}
  return {
   transferId:transfer.id,chunkSize:transfer.chunk_size,chunkCount:transfer.chunk_count,
   receivedChunks:validReceived.map(({chunk_index,chunk_size,sha256})=>({chunk_index,chunk_size,sha256})),
   receivedBytes:validReceived.reduce((total,row)=>total+Number(row.chunk_size),0)
  };
 });

 // Receive one chunk. Repeated identical chunk requests are safe and idempotent.
 app.put<{Params:{id:string;index:string}}>("/transfers/:id/chunks/:index",async(request,reply)=>{
  const user=await requireUser(request,reply);if(!user)return;
  const transfer=await ownedTransfer(request.params.id,user.id) as ChunkTransferRow|undefined;
  if(!transfer)return reply.code(404).send({error:"Transfer not found."});
  if(transfer.status!=="pending")return reply.code(409).send({error:"This transfer is no longer accepting chunks."});
  if(transfer.expires_at&&new Date(transfer.expires_at)<new Date())return reply.code(410).send({error:"This transfer has expired."});
  if(!transfer.chunk_size||!transfer.chunk_count)return reply.code(409).send({error:"Initialize the chunked upload first."});
  const index=Number(request.params.index);
  if(!Number.isSafeInteger(index)||index<0||index>=transfer.chunk_count)return reply.code(400).send({error:"Invalid chunk index."});
  const expectedSize=index===transfer.chunk_count-1
   ? Number(transfer.filesize)-transfer.chunk_size*(transfer.chunk_count-1)
   : transfer.chunk_size;
  const expectedHash=request.headers["x-chunk-sha256"];
  if(typeof expectedHash!=="string"||!/^[a-f0-9]{64}$/.test(expectedHash))return reply.code(400).send({error:"A valid X-Chunk-Sha256 header is required."});

  const part=await request.file({limits:{fileSize:MAX_CHUNK_BYTES,files:1}});
  if(!part)return reply.code(400).send({error:"Attach one chunk using the multipart field name 'chunk'."});

  const chunkDirectory=path.join(config.storageDir,"chunks",transfer.id);
  await mkdir(chunkDirectory,{recursive:true});
  const destination=path.join(chunkDirectory,index+"-"+randomUUID()+".part");
  const hash=createHash("sha256");
  let byteCount=0;
  const meter=new Transform({
   transform(chunk:Buffer,_encoding,callback){
    byteCount+=chunk.length;hash.update(chunk);callback(null,chunk);
   }
  });
  try{
   await pipeline(part.file,meter,fs.createWriteStream(destination,{flags:"wx"}));
   if(part.file.truncated||byteCount!==expectedSize){
    await unlink(destination).catch(()=>undefined);
    return reply.code(400).send({error:"Chunk size does not match the expected size."});
   }
   const actualHash=hash.digest("hex");
   if(actualHash!==expectedHash){
    await unlink(destination).catch(()=>undefined);
    return reply.code(422).send({error:"Chunk integrity check failed. Retry this chunk."});
   }
   const existing=await query<ChunkRow>(
    "SELECT chunk_index,chunk_size,sha256,storage_path FROM transfer_chunks WHERE transfer_id=$1 AND chunk_index=$2",
    [transfer.id,index]
   );
   if(existing.rows[0]&&await verifyStoredChunk(existing.rows[0])){
    await unlink(destination).catch(()=>undefined);
    if(Number(existing.rows[0].chunk_size)===byteCount&&existing.rows[0].sha256===actualHash){
     return {received:true,alreadyReceived:true,chunkIndex:index,chunkSize:byteCount,sha256:actualHash};
    }
    return reply.code(409).send({error:"A different chunk is already stored at this position."});
   }
   if(existing.rows[0]&&!fs.existsSync(existing.rows[0].storage_path)){
    await query("DELETE FROM transfer_chunks WHERE transfer_id=$1 AND chunk_index=$2",[transfer.id,index]);
   }
   try{
    await query(
     "INSERT INTO transfer_chunks(transfer_id,chunk_index,chunk_size,sha256,storage_path) VALUES($1,$2,$3,$4,$5)",
     [transfer.id,index,byteCount,actualHash,destination]
    );
   }catch(error){
    await unlink(destination).catch(()=>undefined);
    if(typeof error==="object"&&error!==null&&"code" in error&&error.code==="23505"){
     return reply.code(409).send({error:"This chunk was received simultaneously. Check upload status and retry if needed."});
    }
    throw error;
   }
   return {received:true,alreadyReceived:false,chunkIndex:index,chunkSize:byteCount,sha256:actualHash};
  }catch(error){
   await unlink(destination).catch(()=>undefined);
   if(part.file.truncated)return reply.code(413).send({error:"Chunk exceeds the 8 MB chunk limit."});
   throw error;
  }
 });

 // Assemble chunks in order, re-check every stored part, hash the final file, then publish it.
 app.post<{Params:{id:string}}>("/transfers/:id/chunks/complete",async(request,reply)=>{
  const user=await requireUser(request,reply);if(!user)return;
  const transfer=await ownedTransfer(request.params.id,user.id) as ChunkTransferRow|undefined;
  if(!transfer)return reply.code(404).send({error:"Transfer not found."});
  if(transfer.status==="completed")return {message:"Upload already completed.",transfer:publicTransfer(transfer),shareUrl:transfer.share_token?config.publicBaseUrl+"/share/"+transfer.share_token:null};
  if(transfer.status!=="pending")return reply.code(409).send({error:"This transfer is no longer pending."});
  if(!transfer.chunk_size||!transfer.chunk_count)return reply.code(409).send({error:"Initialize the chunked upload first."});
  const parts=await query<ChunkRow>(
   "SELECT chunk_index,chunk_size,sha256,storage_path FROM transfer_chunks WHERE transfer_id=$1 ORDER BY chunk_index",
   [transfer.id]
  );
  if(parts.rows.length!==transfer.chunk_count)return reply.code(409).send({error:"Some chunks are still missing.",received:parts.rows.length,expected:transfer.chunk_count});
  for(let index=0;index<parts.rows.length;index++){
   if(parts.rows[index].chunk_index!==index)return reply.code(409).send({error:"Chunk sequence is incomplete.",missingIndex:index});
   const expectedSize=index===transfer.chunk_count-1
    ? Number(transfer.filesize)-transfer.chunk_size*(transfer.chunk_count-1)
    : transfer.chunk_size;
   if(Number(parts.rows[index].chunk_size)!==expectedSize||!fs.existsSync(parts.rows[index].storage_path)){
    return reply.code(409).send({error:"A stored chunk is missing or has an invalid size.",chunkIndex:index});
   }
  }

  const finalDirectory=config.storageDir;
  await mkdir(finalDirectory,{recursive:true});
  const destination=path.join(finalDirectory,randomUUID()+path.extname(transfer.filename).slice(0,20));
  const finalHash=createHash("sha256");
  let totalBytes=0;
  async function* orderedChunks(){
   for(const part of parts.rows){
    const partHash=createHash("sha256");
    let partBytes=0;
    for await(const data of fs.createReadStream(part.storage_path)){
     const buffer=Buffer.isBuffer(data)?data:Buffer.from(data);
     partBytes+=buffer.length;totalBytes+=buffer.length;
     partHash.update(buffer);finalHash.update(buffer);
     yield buffer;
    }
    if(partBytes!==Number(part.chunk_size)||partHash.digest("hex")!==part.sha256){
     throw new Error("Stored chunk "+part.chunk_index+" failed integrity verification.");
    }
   }
  }
  try{
   await pipeline(Readable.from(orderedChunks()),fs.createWriteStream(destination,{flags:"wx"}));
   if(totalBytes!==Number(transfer.filesize)){
    await unlink(destination).catch(()=>undefined);
    return reply.code(422).send({error:"Reconstructed file size does not match the original file size."});
   }
   const digest=finalHash.digest("hex");
   const token=randomUUID();
   const updated=await query<TransferRow>(
    "UPDATE transfers SET storage_path=$3,sha256=$4,uploaded_at=NOW(),status='completed',share_token=CASE WHEN recipient_user_id IS NULL THEN $5::uuid ELSE NULL::uuid END WHERE id=$1 AND user_id=$2 AND status='pending' RETURNING *",
    [transfer.id,user.id,destination,digest,token]
   );
   if(!updated.rows[0]){
    await unlink(destination).catch(()=>undefined);
    return reply.code(409).send({error:"Transfer changed before assembly completed."});
   }
   for(const part of parts.rows)await unlink(part.storage_path).catch(()=>undefined);
   await query("DELETE FROM transfer_chunks WHERE transfer_id=$1",[transfer.id]);
   await fs.promises.rm(path.join(config.storageDir,"chunks",transfer.id),{recursive:true,force:true}).catch(()=>undefined);
   const completed=updated.rows[0];
   return {
    message:"Chunks verified and file assembled successfully.",
    transfer:publicTransfer(completed),
    sha256:digest,
    shareUrl:completed.share_token?config.publicBaseUrl+"/share/"+completed.share_token:null
   };
  }catch(error){
   await unlink(destination).catch(()=>undefined);
   if(error instanceof Error&&error.message.includes("failed integrity verification")){
    const match=error.message.match(/Stored chunk (\\d+) failed integrity verification/);
    if(match){
     const corruptIndex=Number(match[1]);
     const corruptPart=parts.rows.find(part=>part.chunk_index===corruptIndex);
     await query("DELETE FROM transfer_chunks WHERE transfer_id=$1 AND chunk_index=$2",[transfer.id,corruptIndex]);
     if(corruptPart)await unlink(corruptPart.storage_path).catch(()=>undefined);
     return reply.code(422).send({error:error.message,chunkIndex:corruptIndex,retryable:true});
    }
    return reply.code(422).send({error:error.message});
   }
   throw error;
  }
 });

 // Abandon an unfinished upload and remove its temporary chunks.
 app.delete<{Params:{id:string}}>("/transfers/:id/chunks",async(request,reply)=>{
  const user=await requireUser(request,reply);if(!user)return;
  const transfer=await ownedTransfer(request.params.id,user.id);
  if(!transfer)return reply.code(404).send({error:"Transfer not found."});
  if(transfer.status==="completed")return reply.code(409).send({error:"A completed transfer cannot be cancelled."});
  const parts=await query<{storage_path:string}>("SELECT storage_path FROM transfer_chunks WHERE transfer_id=$1",[transfer.id]);
  await query("DELETE FROM transfer_chunks WHERE transfer_id=$1",[transfer.id]);
  await query("UPDATE transfers SET status='cancelled' WHERE id=$1 AND user_id=$2 AND status='pending'",[transfer.id,user.id]);
  for(const part of parts.rows)await unlink(part.storage_path).catch(()=>undefined);
  await fs.promises.rm(path.join(config.storageDir,"chunks",transfer.id),{recursive:true,force:true}).catch(()=>undefined);
  return {message:"Upload cancelled and temporary chunks removed."};
 });


 app.get("/transfers",async(request,reply)=>{
  const user=await requireUser(request,reply);if(!user)return;
  await query("UPDATE transfers SET status='expired' WHERE user_id=$1 AND expires_at<=NOW() AND status IN ('pending','completed')",[user.id]);
  const r=await query<TransferRow>("SELECT * FROM transfers WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100",[user.id]);
  return {transfers:r.rows.map(publicTransfer)};
 });

 app.get("/transfers/received",async(request,reply)=>{
  const user=await requireUser(request,reply);if(!user)return;
  await query("UPDATE transfers SET status='expired' WHERE recipient_user_id=$1 AND expires_at<=NOW() AND status='completed'",[user.id]);
  const r=await query<ReceivedTransferRow>(
   `SELECT t.*,u.display_name AS sender_display_name,u.username AS sender_username,u.email AS sender_email
    FROM transfers t
    JOIN users u ON u.id=t.user_id
    WHERE t.recipient_user_id=$1 AND t.status='completed'
    ORDER BY t.created_at DESC LIMIT 100`,
   [user.id]
  );
  return {
   transfers:r.rows.map(row=>({
    ...publicTransfer(row),
    senderName:row.sender_display_name,
    senderUsername:row.sender_username,
    senderEmail:row.sender_email
   }))
  };
 });

 app.get<{Querystring:{identifier?:string}}>("/users/lookup",async(request,reply)=>{
  const user=await requireUser(request,reply);if(!user)return;
  const identifier=typeof request.query.identifier==="string"?request.query.identifier.trim().toLowerCase().replace(/^@/,""):"";
  if(!identifier||identifier.length>254)return reply.code(400).send({error:"Enter a username or email address."});
  const found=await query<{id:string;display_name:string;username:string|null}>(
   "SELECT id,display_name,username FROM users WHERE LOWER(email)=$1 OR LOWER(username)=$1 LIMIT 1",
   [identifier]
  );
  const recipient=found.rows[0];
  if(!recipient)return reply.code(404).send({error:"No RAVEN account was found with that username or email."});
  if(recipient.id===user.id)return reply.code(400).send({error:"You cannot send a file to your own account."});
  return {user:{displayName:recipient.display_name,username:recipient.username}};
 });

 app.post<{Body:{filename?:string;filesize?:number;recipientIdentifier?:string}}>("/transfers",async(request,reply)=>{
  const user=await requireUser(request,reply);if(!user)return;
  const filename=request.body?.filename?.trim();
  const filesize=request.body?.filesize??0;
  const recipientIdentifier=typeof request.body?.recipientIdentifier==="string"?request.body.recipientIdentifier.trim().toLowerCase().replace(/^@/,""):"";
  if(!filename||filename.length>255)return reply.code(400).send({error:"A filename between 1 and 255 characters is required."});
  if(!Number.isSafeInteger(filesize)||filesize<0||filesize>config.maxFileSizeBytes)return reply.code(400).send({error:"Invalid file size."});

  let recipientId:string|null=null;
  if(recipientIdentifier){
   const isEmail=/^[^@ ]+@[^@ ]+[.][^@ ]+$/.test(recipientIdentifier);
   const isUsername=/^[a-z0-9_]{3,20}$/.test(recipientIdentifier);
   if(recipientIdentifier.length>254||(!isEmail&&!isUsername)){
    return reply.code(400).send({error:"Enter a valid username or email address."});
   }
   const recipient=await query<{id:string}>(
    "SELECT id FROM users WHERE LOWER(email)=$1 OR LOWER(username)=$1 LIMIT 1",
    [recipientIdentifier]
   );
   if(!recipient.rows[0])return reply.code(404).send({error:"No RAVEN account was found with that username or email."});
   if(recipient.rows[0].id===user.id)return reply.code(400).send({error:"You cannot send a transfer to your own account."});
   recipientId=recipient.rows[0].id;
  }

  const expires=new Date(Date.now()+config.expiryHours*3600000);
  const r=await query<TransferRow>(
   "INSERT INTO transfers(user_id,recipient_user_id,filename,filesize,status,expires_at) VALUES($1,$2,$3,$4,'pending',$5) RETURNING *",
   [user.id,recipientId,filename,filesize,expires]
  );
  return reply.code(201).send({message:"Transfer session created.",transfer:publicTransfer(r.rows[0])});
 });

 app.post<{Params:{id:string}}>("/transfers/:id/upload",async(request,reply)=>{
  const user=await requireUser(request,reply);if(!user)return;
  const transfer=await ownedTransfer(request.params.id,user.id);
  if(!transfer)return reply.code(404).send({error:"Transfer not found."});
  if(transfer.status!=="pending")return reply.code(409).send({error:"This transfer is not pending."});
  const chunked=await query<{chunk_count:number|null}>("SELECT chunk_count FROM transfers WHERE id=$1",[transfer.id]);
  if(chunked.rows[0]?.chunk_count)return reply.code(409).send({error:"This transfer uses the chunked upload endpoint."});
  if(transfer.expires_at&&new Date(transfer.expires_at)<new Date())return reply.code(410).send({error:"This transfer has expired."});
  const part=await request.file({limits:{fileSize:config.maxFileSizeBytes,files:1}});
  if(!part)return reply.code(400).send({error:"Attach a file using the multipart field name 'file'."});
  const name=path.basename(part.filename).replace(/[\r\n"]/g,"_").slice(0,255);
  const diskName=randomUUID()+path.extname(name).slice(0,20);
  await mkdir(config.storageDir,{recursive:true});
  const destination=path.join(config.storageDir,diskName);
  try{
   await pipeline(part.file,fs.createWriteStream(destination,{flags:"wx"}));
   if(part.file.truncated){
    await unlink(destination).catch(()=>undefined);
    return reply.code(413).send({error:"File exceeds the configured upload limit."});
   }
   const stat=await fs.promises.stat(destination);
   const token=randomUUID();
   const updated=await query<TransferRow>(
    "UPDATE transfers SET filename=$3,filesize=$4,storage_path=$5,mime_type=$6,sha256=$7,uploaded_at=NOW(),status='completed',share_token=CASE WHEN recipient_user_id IS NULL THEN $8::uuid ELSE NULL::uuid END WHERE id=$1 AND user_id=$2 AND status='pending' RETURNING *",
    [transfer.id,user.id,name,stat.size,destination,part.mimetype,await hashFile(destination),token]
   );
   if(!updated.rows[0]){
    await unlink(destination).catch(()=>undefined);
    return reply.code(409).send({error:"Transfer changed before upload completed."});
   }
   return reply.code(201).send({
    message:"File uploaded successfully.",
    transfer:publicTransfer(updated.rows[0]),
    shareUrl:updated.rows[0].share_token?config.publicBaseUrl+"/share/"+updated.rows[0].share_token:null
   });
  }catch(error){
   await unlink(destination).catch(()=>undefined);
   if(part.file.truncated)return reply.code(413).send({error:"File exceeds the configured upload limit."});
   throw error;
  }
 });

 app.get<{Params:{id:string}}>("/transfers/:id",async(request,reply)=>{
  const user=await requireUser(request,reply);if(!user)return;
  const row=await accessibleTransfer(request.params.id,user.id);
  if(!row)return reply.code(404).send({error:"Transfer not found."});
  return {transfer:publicTransfer(row)};
 });

 app.get<{Params:{id:string}}>("/transfers/:id/download",async(request,reply)=>{
  const user=await requireUser(request,reply);if(!user)return;
  const row=await accessibleTransfer(request.params.id,user.id);
  if(!row)return reply.code(404).send({error:"Transfer not found."});
  return sendFile(reply,row);
 });

 app.get<{Params:{token:string}}>("/share/:token",async(request,reply)=>{
  const r=await query<TransferRow>("SELECT * FROM transfers WHERE share_token=$1",[request.params.token]);
  const row=r.rows[0];
  if(!row)return reply.code(404).send({error:"Share link not found."});
  return sendFile(reply,row);
 });
}
