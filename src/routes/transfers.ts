import type {FastifyInstance,FastifyReply,FastifyRequest} from "fastify";
import {randomUUID} from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import {mkdir,unlink} from "node:fs/promises";
import {pipeline} from "node:stream/promises";
import {query} from "../db.js";
import {config} from "../config.js";
import type {TransferRow} from "../types.js";
import {SESSION_COOKIE_NAME,getAuthenticatedUser} from "../auth.js";

type ReceivedTransferRow = TransferRow & {
 sender_display_name:string;
 sender_email:string;
};

function publicTransfer(row:TransferRow){
 return {
  id:row.id,filename:row.filename,filesize:Number(row.filesize),status:row.status,
  createdAt:row.created_at,uploadedAt:row.uploaded_at,expiresAt:row.expires_at,
  downloadUrl:row.status==="completed"?config.publicBaseUrl+"/transfers/"+row.id+"/download":null
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
   `SELECT t.*,u.display_name AS sender_display_name,u.email AS sender_email
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
    senderEmail:row.sender_email
   }))
  };
 });

 app.post<{Body:{filename?:string;filesize?:number;recipientEmail?:string}}>("/transfers",async(request,reply)=>{
  const user=await requireUser(request,reply);if(!user)return;
  const filename=request.body?.filename?.trim();
  const filesize=request.body?.filesize??0;
  const recipientEmail=typeof request.body?.recipientEmail==="string"?request.body.recipientEmail.trim().toLowerCase():"";
  if(!filename||filename.length>255)return reply.code(400).send({error:"A filename between 1 and 255 characters is required."});
  if(!Number.isSafeInteger(filesize)||filesize<0||filesize>config.maxFileSizeBytes)return reply.code(400).send({error:"Invalid file size."});

  let recipientId:string|null=null;
  if(recipientEmail){
   if(recipientEmail.length>254||!/^[^@ ]+@[^@ ]+[.][^@ ]+$/.test(recipientEmail)){
    return reply.code(400).send({error:"Enter a valid recipient email address."});
   }
   if(recipientEmail===user.email.toLowerCase()){
    return reply.code(400).send({error:"You cannot send a transfer to your own account."});
   }
   const recipient=await query<{id:string}>("SELECT id FROM users WHERE LOWER(email)=$1 LIMIT 1",[recipientEmail]);
   if(!recipient.rows[0])return reply.code(404).send({error:"No RAVEN account was found with that email address."});
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
    "UPDATE transfers SET filename=$3,filesize=$4,storage_path=$5,mime_type=$6,uploaded_at=NOW(),status='completed',share_token=$7 WHERE id=$1 AND user_id=$2 AND status='pending' RETURNING *",
    [transfer.id,user.id,name,stat.size,destination,part.mimetype,token]
   );
   if(!updated.rows[0]){
    await unlink(destination).catch(()=>undefined);
    return reply.code(409).send({error:"Transfer changed before upload completed."});
   }
   return reply.code(201).send({
    message:"File uploaded successfully.",
    transfer:publicTransfer(updated.rows[0]),
    shareUrl:config.publicBaseUrl+"/share/"+token
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
