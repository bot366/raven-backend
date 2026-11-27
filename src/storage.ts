import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { Readable } from "node:stream";
import { config } from "./config.js";

const client = config.b2.enabled ? new S3Client({
 endpoint: config.b2.endpoint,
 region: config.b2.region,
 forcePathStyle: true,
 credentials: {
  accessKeyId: config.b2.keyId,
  secretAccessKey: config.b2.applicationKey
 }
}) : null;

const PREFIX = "raven/";
export function makeObjectKey(category:string, id:string, suffix=""):string {
 const safeCategory=category.replace(/[^a-z0-9-]/gi,"-");
 const safeId=id.replace(/[^a-z0-9-]/gi,"-");
 const safeSuffix=suffix.replace(/^\\/+|\\\\/g,"").replace(/[^a-z0-9._-]/gi,"_");
 return PREFIX+safeCategory+"/"+safeId+(safeSuffix?"-"+safeSuffix:"");
}
export function isB2ObjectPath(value:string|null|undefined):boolean {
 return Boolean(value?.startsWith("b2://"));
}
export function toB2ObjectPath(key:string):string { return "b2://"+key; }
export function fromB2ObjectPath(value:string):string {
 if(!isB2ObjectPath(value)) throw new Error("Expected a B2 object path.");
 return value!.slice("b2://".length);
}
export async function uploadObject(key:string, body:Readable|Buffer, contentType:string, contentLength?:number):Promise<string> {
 if(!client||!config.b2.enabled) throw new Error("Backblaze B2 storage is not configured.");
 const upload=new Upload({
  client,
  params:{
   Bucket:config.b2.bucket,
   Key:key,
   Body:body,
   ContentType:contentType,
   ...(contentLength!==undefined?{ContentLength:contentLength}:{})
  },
  queueSize:2,
  partSize:5*1024*1024,
  leavePartsOnError:false
 });
 await upload.done();
 return toB2ObjectPath(key);
}
export async function getObjectStream(path:string):Promise<Readable> {
 if(!client) throw new Error("Backblaze B2 storage is not configured.");
 const result=await client.send(new GetObjectCommand({Bucket:config.b2.bucket,Key:fromB2ObjectPath(path)}));
 if(!result.Body) throw new Error("The requested B2 object has no response body.");
 return result.Body as Readable;
}
export async function objectExists(path:string):Promise<boolean> {
 if(!client) return false;
 try {
  await client.send(new HeadObjectCommand({Bucket:config.b2.bucket,Key:fromB2ObjectPath(path)}));
  return true;
 } catch(error) {
  const status=(error as { $metadata?:{$httpStatusCode?:number} }).$metadata?.$httpStatusCode;
  if(status===404) return false;
  throw error;
 }
}
export async function deleteObject(path:string):Promise<void> {
 if(!client||!isB2ObjectPath(path)) return;
 await client.send(new DeleteObjectCommand({Bucket:config.b2.bucket,Key:fromB2ObjectPath(path)}));
}
export function b2StorageEnabled():boolean { return config.b2.enabled; }
